/**
 * Redeem resolved Polymarket positions via proxy/relayer (not EOA → CTF direct).
 * signature_type 3 (deposit wallet): executeDepositWalletBatch on Polymarket relayer
 * signature_type 1 (proxy): relayer PROXY or proxy factory fallback
 * signature_type 2 (safe): relayer SAFE or Safe exec fallback
 */
const { addLog } = require('./ledger');
const { rnd } = require('./fees');

const CTF_ADDRESS = (process.env.POLYMARKET_CTF_ADDRESS || '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045').trim();
const USDC_ADDRESS = (process.env.POLYMARKET_USDC_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174').trim();
const NEG_RISK_ADAPTER = (process.env.POLYMARKET_NEG_RISK_ADAPTER || '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296').trim();
const PROXY_FACTORY = (process.env.POLYMARKET_PROXY_FACTORY || '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052').trim();
const RPC_URL = (process.env.POLYGON_RPC_URL || process.env.RPC_URL || 'https://polygon-rpc.com').trim();
const DATA_API = process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com';
const RELAYER_URL = (process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com/').trim();

const PROXY_FACTORY_ABI = [
  'function proxy((uint8 typeCode, address to, uint256 value, bytes data)[] calls)',
];

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
];

let _positionsCache = { at: 0, rows: null };

function envTruthy(name, defaultValue = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function funderAddress() {
  const addr = String(process.env.POLYMARKET_FUNDER_ADDRESS || '').trim();
  if (!addr) throw new Error('POLYMARKET_FUNDER_ADDRESS missing');
  return addr;
}

function signatureType() {
  return parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '1', 10);
}

function hasBuilderCreds() {
  return Boolean(
    process.env.POLY_BUILDER_API_KEY
    && process.env.POLY_BUILDER_SECRET
    && process.env.POLY_BUILDER_PASSPHRASE
  );
}

function skipBotRedeem() {
  return envTruthy('POLYMARKET_SKIP_BOT_REDEEM');
}

function getWallet() {
  const pk = (process.env.POLYMARKET_PRIVATE_KEY || '').trim();
  if (!pk) throw new Error('POLYMARKET_PRIVATE_KEY 未配置');
  const { Wallet, providers } = require('ethers');
  const chainId = parseInt(process.env.CHAIN_ID || '137', 10);
  const provider = new providers.StaticJsonRpcProvider(
    { url: RPC_URL, chainId, name: 'polygon' },
    chainId
  );
  return new Wallet(pk, provider);
}

function encodeRedeemData(conditionId, negRisk = false) {
  const { utils, constants } = require('ethers');
  if (negRisk) {
    const iface = new utils.Interface([
      'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
    ]);
    return {
      to: NEG_RISK_ADAPTER,
      data: iface.encodeFunctionData('redeemPositions', [conditionId, ['0', '0']]),
    };
  }
  const iface = new utils.Interface([
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  ]);
  return {
    to: CTF_ADDRESS,
    data: iface.encodeFunctionData('redeemPositions', [
      USDC_ADDRESS,
      constants.HashZero,
      conditionId,
      [1, 2],
    ]),
  };
}

async function fetchUserPositions({ force = false } = {}) {
  const now = Date.now();
  if (!force && _positionsCache.rows && now - _positionsCache.at < 8000) {
    return _positionsCache.rows;
  }
  const addr = funderAddress();
  const url = `${DATA_API}/positions?user=${encodeURIComponent(addr)}&sizeThreshold=0`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`data-api positions ${res.status}`);
  const rows = await res.json();
  _positionsCache = { at: now, rows: Array.isArray(rows) ? rows : [] };
  return _positionsCache.rows;
}

async function fetchRedeemablePositions({ force = false } = {}) {
  const addr = funderAddress();
  const url = `${DATA_API}/positions?user=${encodeURIComponent(addr)}&redeemable=true&sizeThreshold=0`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`data-api redeemable ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

function positionsForCondition(rows, conditionId) {
  const cid = String(conditionId || '').toLowerCase();
  return (rows || []).filter((r) => String(r.conditionId || '').toLowerCase() === cid);
}

/** True when official API shows nothing left to redeem for this condition. */
async function isAlreadyRedeemedOnChain(conditionId) {
  try {
    const redeemable = await fetchRedeemablePositions();
    const still = positionsForCondition(redeemable, conditionId)
      .some((r) => Number(r.size) > 1e-8);
    if (still) return false;
    const all = await fetchUserPositions();
    const open = positionsForCondition(all, conditionId)
      .some((r) => Number(r.size) > 1e-8);
    return !open;
  } catch (_) {
    return false;
  }
}

function markRedeemed(state, pos, meta = {}) {
  pos.redeemed = true;
  pos.redeemedAt = new Date().toISOString();
  pos.redeemVia = meta.via || 'sync';
  if (meta.hash) pos.redeemTx = meta.hash;
  delete pos.redeemError;
  delete pos.redeemPending;
  addLog(
    state,
    `[赎回] ${pos.title || pos.slug} ${meta.via ? `via ${meta.via}` : '已完成'}${meta.hash ? ` tx=${String(meta.hash).slice(0, 12)}…` : ''}`,
    'success'
  );
}

async function createRelayClient() {
  const { RelayClient, RelayerTxType } = require('@polymarket/builder-relayer-client');
  const { BuilderConfig } = require('@polymarket/builder-signing-sdk');
  const { createWalletClient, http } = require('viem');
  const { privateKeyToAccount } = require('viem/accounts');
  const { polygon } = require('viem/chains');

  const pk = (process.env.POLYMARKET_PRIVATE_KEY || '').trim();
  if (!pk) throw new Error('POLYMARKET_PRIVATE_KEY 未配置');
  const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(RPC_URL),
  });

  const builderConfig = hasBuilderCreds()
    ? new BuilderConfig({
      localBuilderCreds: {
        key: process.env.POLY_BUILDER_API_KEY,
        secret: process.env.POLY_BUILDER_SECRET,
        passphrase: process.env.POLY_BUILDER_PASSPHRASE,
      },
    })
    : undefined;

  const sig = signatureType();
  const relayTxType = sig === 2 ? RelayerTxType.SAFE : RelayerTxType.PROXY;
  return new RelayClient(RELAYER_URL, 137, wallet, builderConfig, relayTxType, { chain: polygon });
}

async function waitRelayerResponse(resp) {
  const result = await resp.wait();
  if (!result || result.state === 'STATE_FAILED' || result.state === 'STATE_INVALID') {
    throw new Error(`relayer ${result?.state || 'failed'}`);
  }
  return {
    hash: result.transactionHash || resp.transactionHash || resp.hash,
    transactionID: resp.transactionID,
    state: result.state,
  };
}

async function redeemViaRelayerDepositWallet(conditionId, negRisk = false) {
  const client = await createRelayClient();
  const funder = funderAddress();
  const { to, data } = encodeRedeemData(conditionId, negRisk);
  const deadline = String(Math.floor(Date.now() / 1000) + 3600);
  const resp = await client.executeDepositWalletBatch(
    [{ target: to, value: '0', data }],
    funder,
    deadline
  );
  const result = await waitRelayerResponse(resp);
  return { ...result, via: 'relayer-deposit-wallet' };
}

async function redeemViaRelayerExecute(conditionId, negRisk = false) {
  const client = await createRelayClient();
  const { to, data } = encodeRedeemData(conditionId, negRisk);
  const resp = await client.execute([{ to, data, value: '0' }], 'redeem positions');
  const result = await waitRelayerResponse(resp);
  const sig = signatureType();
  return { ...result, via: sig === 2 ? 'relayer-safe' : 'relayer-proxy' };
}

async function redeemViaProxyFactory(conditionId, negRisk = false) {
  const wallet = getWallet();
  const { Contract } = require('ethers');
  const { to, data } = encodeRedeemData(conditionId, negRisk);
  const factory = new Contract(PROXY_FACTORY, PROXY_FACTORY_ABI, wallet);
  const tx = await factory.proxy([{ typeCode: 1, to, value: 0, data }]);
  const receipt = await tx.wait(1);
  return { hash: tx.hash, status: receipt.status, via: 'proxy-factory' };
}

async function signSafeTxHash(wallet, txHash) {
  const { BigNumber } = require('ethers');
  const messageArray = require('ethers').utils.arrayify(txHash);
  let sig = await wallet.signMessage(messageArray);
  let sigV = parseInt(sig.slice(-2), 16);
  if (sigV === 0 || sigV === 1) sigV += 31;
  else if (sigV === 27 || sigV === 28) sigV += 4;
  else throw new Error('Invalid signature');
  sig = sig.slice(0, -2) + sigV.toString(16);
  const r = BigNumber.from(`0x${sig.slice(2, 66)}`).toHexString();
  const s = BigNumber.from(`0x${sig.slice(66, 130)}`).toHexString();
  const v = BigNumber.from(`0x${sig.slice(130, 132)}`).toHexString();
  return require('ethers').utils.solidityPack(['uint256', 'uint256', 'uint8'], [r, s, v]);
}

async function redeemViaSafeExec(conditionId, negRisk = false) {
  const wallet = getWallet();
  const { Contract, constants } = require('ethers');
  const safeAddress = funderAddress();
  const safe = new Contract(safeAddress, SAFE_ABI, wallet);
  const { to, data } = encodeRedeemData(conditionId, negRisk);
  const nonce = await safe.nonce();
  const txHash = await safe.getTransactionHash(
    to, 0, data, 0, 0, 0, 0, constants.AddressZero, constants.AddressZero, nonce
  );
  const packedSig = await signSafeTxHash(wallet, txHash);
  const tx = await safe.execTransaction(
    to, 0, data, 0, 0, 0, 0, constants.AddressZero, constants.AddressZero, packedSig
  );
  const receipt = await tx.wait(1);
  return { hash: tx.hash, status: receipt.status, via: 'safe-exec' };
}

/**
 * Redeem one resolved condition using the correct wallet path.
 */
async function redeemCondition(conditionId, opts = {}) {
  if (!conditionId) throw new Error('missing conditionId');
  const negRisk = Boolean(opts.negRisk);

  if (await isAlreadyRedeemedOnChain(conditionId)) {
    return { ok: true, skipped: true, reason: 'already_redeemed' };
  }
  if (skipBotRedeem()) {
    return { ok: true, skipped: true, reason: 'skip_bot_redeem' };
  }

  const sig = signatureType();
  let lastErr = null;

  if (hasBuilderCreds()) {
    try {
      if (sig === 3) return { ok: true, ...(await redeemViaRelayerDepositWallet(conditionId, negRisk)) };
      return { ok: true, ...(await redeemViaRelayerExecute(conditionId, negRisk)) };
    } catch (err) {
      lastErr = err;
    }
  }

  try {
    if (sig === 1) return { ok: true, ...(await redeemViaProxyFactory(conditionId, negRisk)) };
    if (sig === 2) return { ok: true, ...(await redeemViaSafeExec(conditionId, negRisk)) };
  } catch (err) {
    lastErr = err;
  }

  if (sig === 3) {
    throw new Error(
      'Deposit 钱包(type=3) 需配置 POLY_BUILDER_API_KEY/SECRET/PASSPHRASE（polymarket.com/settings?tab=builder），'
      + '或开启官方自动赎回并设 POLYMARKET_SKIP_BOT_REDEEM=1'
    );
  }

  throw lastErr || new Error('redeem failed');
}

function normalizeRedeemError(err) {
  let msg = String(err?.message || err);
  if (/insufficient funds/i.test(msg)) {
    msg = '签名钱包 MATIC/POL 不足，无法支付链上 gas（relayer 路径需 Builder API）';
  }
  if (/401|invalid authorization/i.test(msg)) {
    msg = 'Relayer 未授权：请配置 POLY_BUILDER_API_KEY/SECRET/PASSPHRASE';
  }
  return msg.slice(0, 200);
}

/**
 * After ledger settle, attempt redeem (relayer/proxy) or sync official status.
 */
async function redeemSettledPosition(state, pos) {
  if (!pos || pos.redeemed) return { ok: true, skipped: true };

  try {
    if (await isAlreadyRedeemedOnChain(pos.conditionId)) {
      markRedeemed(state, pos, { via: 'official-sync' });
      return { ok: true, synced: true };
    }
    if (skipBotRedeem()) {
      pos.redeemPending = false;
      pos.redeemError = '已跳过机器人赎回（POLYMARKET_SKIP_BOT_REDEEM=1，依赖官方自动赎回）';
      return { ok: true, skipped: true };
    }

    const negRisk = Boolean(pos.negRisk);
    const result = await redeemCondition(pos.conditionId, { negRisk });
    if (result.skipped) {
      if (result.reason === 'already_redeemed') {
        markRedeemed(state, pos, { via: 'official-sync' });
        return { ok: true, synced: true };
      }
      return { ok: true, skipped: true, reason: result.reason };
    }

    markRedeemed(state, pos, { via: result.via, hash: result.hash });
    return { ok: true, ...result };
  } catch (err) {
    pos.redeemPending = true;
    pos.redeemError = normalizeRedeemError(err);
    addLog(
      state,
      `[赎回失败] ${pos.title || pos.slug}: ${pos.redeemError}`,
      'warning'
    );
    return { ok: false, error: pos.redeemError };
  }
}

/** Retry pending redeems; sync official status first when possible. */
async function retryPendingRedeems(state, limit = null) {
  const max = limit != null
    ? limit
    : parseInt(process.env.REDEEM_RETRY_LIMIT || '50', 10);
  let n = 0;
  for (const pos of Object.values(state.positions || {})) {
    if (!pos.settled || pos.redeemed) continue;
    if (!pos.redeemPending && !pos.redeemError) continue;
    const r = await redeemSettledPosition(state, pos);
    if (r.ok && (r.hash || r.synced)) n += 1;
    if (n >= max) break;
  }
  return n;
}

module.exports = {
  redeemCondition,
  redeemSettledPosition,
  retryPendingRedeems,
  isAlreadyRedeemedOnChain,
  fetchRedeemablePositions,
  CTF_ADDRESS,
  USDC_ADDRESS,
  rnd,
};
