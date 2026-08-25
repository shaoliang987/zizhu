const { readJson, writeJson, appendJsonl, readJsonl, ensureDataDir } = require('./paths');
const { buyCostWithFee, rnd } = require('./fees');
const { loadParams } = require('./strategy');
const { formatHkt } = require('./time');

function emptyState() {
  const p = loadParams();
  return {
    initial_capital_usdc: Number(p.initial_capital_usdc) || 1000,
    cash_usdc: Number(p.initial_capital_usdc) || 1000,
    positions: {},
    stats: {
      scans: 0,
      signals: 0,
      fills: 0,
      skipped: 0,
      settled_markets: 0,
      realized_pnl_usdc: 0,
      fees_usdc: 0,
      total_buy_usdc: 0,
      total_proceeds_usdc: 0,
      orders_posted: 0,
      orders_cancelled: 0,
    },
    open_orders: [],
    reserved_usdc: 0,
    last_scan: null,
    bot_status: 'running',
    logs: [],
  };
}

function loadState() {
  ensureDataDir();
  const s = readJson('state.json', null);
  if (!s) {
    const fresh = emptyState();
    writeJson('state.json', fresh);
    return fresh;
  }
  if (!s.positions || typeof s.positions !== 'object') s.positions = {};
  if (!s.stats || typeof s.stats !== 'object') s.stats = emptyState().stats;
  if (!Array.isArray(s.logs)) s.logs = [];
  if (!Array.isArray(s.open_orders)) s.open_orders = [];
  if (!Number.isFinite(s.reserved_usdc)) s.reserved_usdc = 0;
  if (!Number.isFinite(s.cash_usdc)) {
    s.cash_usdc = Number(s.initial_capital_usdc) || 1000;
  }
  return s;
}

function saveState(state) {
  writeJson('state.json', state);
}

function addLog(state, message, type = 'info') {
  const row = { ts: new Date().toISOString(), type, message };
  state.logs.unshift(row);
  if (state.logs.length > 300) state.logs.length = 300;
  appendJsonl('run_log.jsonl', row);
  const tag = type.toUpperCase();
  console.log(`[${formatHkt(row.ts, { withLabel: true })}] [${tag}] ${message}`);
}

function getOrCreatePosition(state, market) {
  const id = market.conditionId;
  if (!state.positions[id]) {
    state.positions[id] = {
      conditionId: id,
      slug: market.slug,
      title: market.title,
      windowStart: market.windowStart,
      windowEnd: market.windowEnd,
      upTokenId: market.upTokenId,
      downTokenId: market.downTokenId,
      upShares: 0,
      downShares: 0,
      upCost: 0,
      downCost: 0,
      upFees: 0,
      downFees: 0,
      investedUsdc: 0,
      settled: false,
      realizedPnl: 0,
      windowRealizedChurn: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return state.positions[id];
}

function positionInvested(pos) {
  // Cost basis already includes taker fees (baloneigh-style).
  return rnd((Number(pos.upCost) || 0) + (Number(pos.downCost) || 0), 4);
}

/** Lifetime window buy USDC (survives cost zeroing / unwind) — hard budget basis. */
function windowSpentUsdc(pos) {
  if (!pos) return 0;
  const invested = positionInvested(pos);
  const lifetime = Number(pos.windowBuyUsdc) || 0;
  return rnd(Math.max(invested, lifetime), 4);
}

/** Monotonic bump of lifetime buys (from applyBuy or activity). */
function bumpWindowBuyUsdc(pos, buyUsdc) {
  if (!pos) return 0;
  const next = Math.max(Number(pos.windowBuyUsdc) || 0, Number(buyUsdc) || 0);
  pos.windowBuyUsdc = rnd(next, 4);
  return pos.windowBuyUsdc;
}

/** Track intra-window sell/unwind PnL (included in position.realizedPnl at settle). */
function recordWindowRealized(state, pos, proceeds, costBasis) {
  if (!pos) return 0;
  const realized = rnd((Number(proceeds) || 0) - (Number(costBasis) || 0), 4);
  pos.windowRealizedChurn = rnd((Number(pos.windowRealizedChurn) || 0) + realized, 4);
  pos.realizedPnl = pos.windowRealizedChurn;
  pos.updatedAt = new Date().toISOString();
  if (state?.stats) {
    state.stats.realized_pnl_usdc = rnd((Number(state.stats.realized_pnl_usdc) || 0) + realized, 4);
    state.stats.total_proceeds_usdc = rnd(
      (Number(state.stats.total_proceeds_usdc) || 0) + (Number(proceeds) || 0),
      4
    );
  }
  return realized;
}

function applyBuy(state, market, side, shares, price, meta = {}) {
  const pos = getOrCreatePosition(state, market);
  const usdcFromApi = meta.usdcFromApi != null ? Number(meta.usdcFromApi) : null;
  const { notional, fee, cost } = buyCostWithFee(
    shares,
    price,
    meta.feeRate,
    Number.isFinite(usdcFromApi) && usdcFromApi > 0 ? usdcFromApi : null
  );
  // Live fills already happened on exchange — never refuse booking for ledger cash
  if (state.cash_usdc + 1e-9 < cost) {
    if (meta.live) {
      const topUp = rnd(cost - Number(state.cash_usdc), 4);
      state.cash_usdc = rnd(Number(state.cash_usdc) + topUp, 4);
      state.stats.ledger_cash_topups_usdc = rnd(
        (Number(state.stats.ledger_cash_topups_usdc) || 0) + topUp,
        4
      );
    } else {
      return { ok: false, reason: `cash $${state.cash_usdc.toFixed(2)} < need $${cost} (incl. fee)` };
    }
  }
  // Cash out = notional + fee; cost basis stores full cash (fees included).
  state.cash_usdc = rnd(state.cash_usdc - cost, 4);
  if (side === 'Up') {
    pos.upShares = rnd(pos.upShares + shares, 6);
    pos.upCost = rnd(pos.upCost + cost, 4);
    pos.upFees = rnd(pos.upFees + fee, 6);
  } else {
    pos.downShares = rnd(pos.downShares + shares, 6);
    pos.downCost = rnd(pos.downCost + cost, 4);
    pos.downFees = rnd(pos.downFees + fee, 6);
  }
  pos.investedUsdc = positionInvested(pos);
  pos.windowBuyUsdc = rnd((Number(pos.windowBuyUsdc) || 0) + cost, 4);
  pos.updatedAt = new Date().toISOString();
  state.stats.fills += 1;
  state.stats.fees_usdc = rnd(state.stats.fees_usdc + fee, 4);
  state.stats.total_buy_usdc = rnd((Number(state.stats.total_buy_usdc) || 0) + cost, 4);

  const fill = {
    ts: new Date().toISOString(),
    type: meta.live ? 'LIVE_BUY' : 'PAPER_BUY',
    conditionId: market.conditionId,
    slug: market.slug,
    title: market.title,
    side,
    shares,
    price,
    plannedPrice: meta.plannedPrice != null ? meta.plannedPrice : price,
    limitPrice: meta.limitPrice != null ? meta.limitPrice : null,
    marketAsk: meta.marketAsk != null ? meta.marketAsk : null,
    notional,
    fee,
    cost,
    orderId: meta.orderId || null,
    paired: Boolean(meta.paired),
    slippageOk: meta.slippageOk !== false,
    liquidity: meta.liquidity || meta.quoteMode || null,
    paperClob: Boolean(meta.paperClob),
  };
  appendJsonl('trades.jsonl', fill);
  return { ok: true, fill, position: pos, fee, cost, notional };
}

function openPositions(state) {
  return Object.values(state.positions || {}).filter((p) => {
    if (p.settled) return false;
    const up = Number(p.upShares) || 0;
    const down = Number(p.downShares) || 0;
    // Hide zero-share unsettled shells from the positions panel (empty flicker)
    return up > 1e-8 || down > 1e-8;
  });
}

function settledPositions(state) {
  return Object.values(state.positions || {}).filter((p) => p.settled);
}

function clearRecords(state) {
  const p = loadParams();
  const capital = Number(p.initial_capital_usdc) || 1000;
  const next = emptyState();
  next.initial_capital_usdc = capital;
  next.cash_usdc = capital;
  next.bot_status = state.bot_status || 'running';
  saveState(next);
  require('fs').writeFileSync(require('./paths').dataPath('trades.jsonl'), '', 'utf8');
  require('fs').writeFileSync(require('./paths').dataPath('settlement_log.jsonl'), '', 'utf8');
  return next;
}

module.exports = {
  emptyState,
  loadState,
  saveState,
  addLog,
  getOrCreatePosition,
  positionInvested,
  windowSpentUsdc,
  bumpWindowBuyUsdc,
  recordWindowRealized,
  applyBuy,
  openPositions,
  settledPositions,
  clearRecords,
  readFills: () => readJsonl('trades.jsonl'),
};
