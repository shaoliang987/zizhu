const { isDryRun } = require('./mode');
const { rnd } = require('./fees');

const DATA_API = process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com';

let _cached = { at: 0, usdc: null };
let _posCached = { at: 0, usdc: null };

function funderAddress() {
  const addr = String(process.env.POLYMARKET_FUNDER_ADDRESS || '').trim();
  if (!addr) throw new Error('POLYMARKET_FUNDER_ADDRESS missing');
  return addr;
}

/**
 * Live CLOB collateral (USDC).
 * Paper cash is computed in pnl.js (初始+已实现−持仓成本), not here.
 */
async function fetchAccountCashUsdc({ force = false } = {}) {
  if (isDryRun()) return null;

  const now = Date.now();
  if (!force && _cached.usdc != null && now - _cached.at < 5000) {
    return _cached.usdc;
  }

  try {
    const { getClobClient } = require('./executor');
    const client = await getClobClient();
    const { AssetType } = require('@polymarket/clob-client-v2');
    const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const raw = Number(bal?.balance);
    if (Number.isFinite(raw)) {
      const usdc = rnd(raw / 1e6, 4);
      _cached = { at: now, usdc };
      return usdc;
    }
  } catch (err) {
    if (_cached.usdc != null) return _cached.usdc;
    throw err;
  }
  return _cached.usdc;
}

/**
 * Live open-position mark-to-market from Polymarket Data API (/value).
 */
async function fetchPositionsValueUsdc({ force = false } = {}) {
  if (isDryRun()) return null;

  const now = Date.now();
  if (!force && _posCached.usdc != null && now - _posCached.at < 5000) {
    return _posCached.usdc;
  }

  const addr = funderAddress();
  const url = `${DATA_API}/value?user=${encodeURIComponent(addr)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    if (_posCached.usdc != null) return _posCached.usdc;
    throw new Error(`data-api /value ${res.status}`);
  }
  const data = await res.json();
  const row = Array.isArray(data) ? data[0] : data;
  const raw = Number(row?.value);
  if (!Number.isFinite(raw)) {
    if (_posCached.usdc != null) return _posCached.usdc;
    throw new Error('data-api /value invalid response');
  }
  const usdc = rnd(raw, 4);
  _posCached = { at: now, usdc };
  return usdc;
}

/**
 * Live account equity = CLOB collateral + official position value.
 */
async function fetchAccountEquityUsdc({ force = false } = {}) {
  if (isDryRun()) return null;

  let cash = null;
  let positions = null;
  let cashError = null;
  let positionsError = null;

  try {
    cash = await fetchAccountCashUsdc({ force });
  } catch (err) {
    cashError = err.message;
  }
  try {
    positions = await fetchPositionsValueUsdc({ force });
  } catch (err) {
    positionsError = err.message;
  }

  if (cash == null && positions == null) {
    throw new Error(cashError || positionsError || 'equity sync failed');
  }

  return {
    equity_usdc: rnd((cash || 0) + (positions || 0), 4),
    cash_usdc: cash,
    positions_value_usdc: positions ?? 0,
    cash_error: cashError,
    positions_error: positionsError,
  };
}

/**
 * Align realized PnL with ledger cash once flat (no open inventory).
 * Leg-by-leg settlement can drift from cash-truth when fill costs differ.
 */
function syncLedgerPnl(state) {
  const { openPositions, positionInvested } = require('./ledger');
  const { addLog } = require('./ledger');
  const capital = Number(state.initial_capital_usdc) || 0;
  const cash = Number(state.cash_usdc) || 0;
  const openCost = openPositions(state).reduce((a, p) => a + positionInvested(p), 0);
  const hasOpen = openPositions(state).some(
    (p) => (Number(p.upShares) || 0) > 1e-8 || (Number(p.downShares) || 0) > 1e-8
  );

  if (!state.stats) state.stats = {};
  const legRealized = Number(state.stats.realized_pnl_usdc) || 0;

  if (hasOpen && openCost > 0.01) return legRealized;

  const actualRealized = rnd(cash - capital, 4);
  const drift = rnd(actualRealized - legRealized, 4);

  if (state.stats.strategy_realized_pnl_usdc == null && Math.abs(legRealized) > 1e-8) {
    state.stats.strategy_realized_pnl_usdc = legRealized;
  }

  if (Math.abs(drift) > 0.02 || Math.abs(legRealized - actualRealized) > 0.02) {
    const prev = legRealized;
    state.stats.realized_pnl_usdc = actualRealized;
    state.stats.realized_pnl_clob_drift_usdc = drift;
    state.stats.total_proceeds_usdc = rnd(
      cash - capital + (Number(state.stats.total_buy_usdc) || 0),
      4
    );
    if (Math.abs(drift) > 0.05) {
      const label = isDryRun() ? '现金口径' : 'CLOB';
      addLog(
        state,
        `[账本校准] ${label} 已实现 $${actualRealized.toFixed(4)} ← 逐腿结算 $${prev.toFixed(4)}` +
          ` (Δ $${drift.toFixed(4)}，成交成本偏差)`,
        'warning'
      );
    }
  }

  return actualRealized;
}

/**
 * Live: align realized PnL with CLOB truth once flat (no open inventory).
 */
function syncLiveLedgerPnl(state) {
  if (isDryRun()) return null;
  return syncLedgerPnl(state);
}

/** Paper: same cash-truth calibration as live, using ledger cash. */
function syncPaperLedgerPnl(state) {
  if (!isDryRun()) return null;
  return syncLedgerPnl(state);
}

/**
 * Overlay official Polymarket balances on the PnL snapshot (live only).
 * Identity: total_pnl = realized + unrealized; equity = initial + total_pnl.
 * Official equity is used to derive account-truth total, then realized is back-solved.
 */
function applyLiveAccountPnl(pnl, account) {
  if (!pnl || !account) return pnl;

  const capital = Number(pnl.initial_capital_usdc) || 0;
  let realized = Number(pnl.realized_pnl_usdc) || 0;
  let unrealized = Number(pnl.unrealized_pnl_usdc) || 0;

  if (account.cash_usdc != null) pnl.account_cash_usdc = account.cash_usdc;
  pnl.positions_value_usdc = account.positions_value_usdc ?? 0;

  if (account.equity_usdc != null) {
    pnl.official_equity_usdc = account.equity_usdc;
    pnl.equity_source = 'polymarket';
    const accountTotal = rnd(account.equity_usdc - capital, 4);
    unrealized = rnd(unrealized, 4);
    realized = rnd(accountTotal - unrealized, 4);
    pnl.realized_pnl_usdc = realized;
    pnl.unrealized_pnl_usdc = unrealized;
  } else {
    pnl.equity_source = 'ledger';
  }

  pnl.total_pnl_usdc = rnd(realized + unrealized, 4);
  pnl.equity_usdc = rnd(capital + pnl.total_pnl_usdc, 4);
  if (capital > 0) {
    pnl.roc_pct = rnd((pnl.total_pnl_usdc / capital) * 100, 2);
  }

  if (pnl.official_equity_usdc != null) {
    pnl.equity_official_drift_usdc = rnd(pnl.official_equity_usdc - pnl.equity_usdc, 4);
  }

  pnl.account_cash_error = account.cash_error || null;
  pnl.account_equity_error = account.positions_error || null;
  return pnl;
}

/**
 * Paper: enforce total = realized + unrealized; when flat, realized = cash − initial.
 */
function applyPaperAccountPnl(pnl, state) {
  if (!pnl || !state) return pnl;

  const capital = Number(pnl.initial_capital_usdc) || 0;
  let realized = Number(pnl.realized_pnl_usdc) || 0;
  let unrealized = Number(pnl.unrealized_pnl_usdc) || 0;
  const hasOpen = (Number(pnl.open_markets) || 0) > 0;

  pnl.account_cash_usdc = pnl.paper_account_cash_usdc ?? state.cash_usdc;
  pnl.equity_source = 'ledger';

  if (!hasOpen) {
    const cash = Number(state.cash_usdc) || 0;
    realized = rnd(cash - capital, 4);
    unrealized = 0;
  }

  pnl.realized_pnl_usdc = realized;
  pnl.unrealized_pnl_usdc = unrealized;
  pnl.total_pnl_usdc = rnd(realized + unrealized, 4);
  pnl.equity_usdc = rnd(capital + pnl.total_pnl_usdc, 4);
  if (capital > 0) {
    pnl.roc_pct = rnd((pnl.total_pnl_usdc / capital) * 100, 2);
  }
  return pnl;
}

/**
 * Mirror exchange free collateral into ledger cash (live only).
 * CLOB balance already excludes open-order locks; use as source of truth for cash_usdc.
 */
async function syncLiveLedgerFromClob(state, { force = false } = {}) {
  if (isDryRun()) return null;

  const account = await fetchAccountCashUsdc({ force });
  if (account == null || !(account >= 0)) return null;

  const prev = rnd(Number(state.cash_usdc) || 0, 4);
  state.clob_cash_usdc = account;
  state.clob_cash_synced_at = new Date().toISOString();
  state.cash_usdc = account;

  const drift = rnd(Math.abs(prev - account), 4);
  if (drift > 0.02) {
    if (!state.stats) state.stats = {};
    state.stats.ledger_cash_resyncs = (Number(state.stats.ledger_cash_resyncs) || 0) + 1;
    const { addLog } = require('./ledger');
    addLog(
      state,
      `[账本同步] CLOB 可用 $${account.toFixed(4)} ← 原 ledger $${prev.toFixed(4)} (Δ $${drift.toFixed(4)})`,
      'info'
    );
    if (drift > 0.5) {
      try {
        const { syncLiveFillsQuick } = require('./activity_backfill');
        await syncLiveFillsQuick(state, { force: true });
      } catch (err) {
        addLog(state, `[成交同步] 现金漂移触发失败: ${err.message}`, 'warning');
      }
    }
  }

  syncLiveLedgerPnl(state);
  return account;
}

module.exports = {
  fetchAccountCashUsdc,
  fetchPositionsValueUsdc,
  fetchAccountEquityUsdc,
  applyLiveAccountPnl,
  applyPaperAccountPnl,
  syncLiveLedgerFromClob,
  syncLiveLedgerPnl,
  syncPaperLedgerPnl,
  syncLedgerPnl,
};
