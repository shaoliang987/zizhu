const path = require('path');
const { readJson, writeJson } = require('./paths');

/**
 * BTC 5m Up/Down pair defaults:
 * - Maker on bid pair (bid_up+bid_down); taker ask pair rarely < 1
 * - Band 10–90¢; avoid 0–10¢ lottery legs
 * - Scan every 2s via HTTP book (raise only if missing short-lived edges)
 */
const DEFAULTS = {
  quote_mode: 'maker',
  pair_sum_max: 0.97,
  min_ask: 0.35,
  max_ask: 0.65,
  entry_start_sec: 45,
  entry_end_sec: 180,
  /** Require this many seconds before entry_end to open a new pair (both legs need time). */
  pair_entry_min_sec: 120,
  /** Max wait from first detecting one-sided inventory before forced handling. */
  orphan_grace_sec: 2,
  /** Never ride a one-sided leg into the last N seconds of the window. */
  orphan_force_before_end_sec: 90,
  /** Absolute dump floor even if hedge rest is young (seconds before end). */
  orphan_hard_force_before_end_sec: 30,
  /** Max wait on unfilled hedge GTC before cancel + dump the held leg.
   * Keep short: waiting 90s lets the held leg bid collapse to ~5¢. */
  orphan_hedge_rest_max_sec: 2,
  /** 1=on: one-sided → taker buy missing leg before unwind */
  pair_taker_hedge: 1,
  /** Extra buffer on pair_sum_max for taker hedge cost check */
  pair_hedge_fee_buffer: 0.015,
  share_chunk: 5,
  max_trade_usdc: 5,
  max_market_usdc: 10,
  min_order_shares: 5,
  scan_interval_ms: 1000,
  /** Periodic Polymarket settle-check interval (seconds); 0 disables */
  settle_check_interval_sec: 600,
  /** With settle-check: also sync Polymarket /activity into ledger (1=on) */
  activity_sync_enabled: 1,
  settle_delay_sec: 45,
  official_settle_grace_sec: 300,
  fallback_settle_grace_sec: 1800,
  slippage_limit: 0.05,
  min_slippage_tolerance_cents: 10,
  initial_capital_usdc: 100,
  max_ask_skew: 0.65,
  maker_improve_ticks: 0,
  maker_fee_rate: 0,
  /** Crypto category taker fee rate (Polymarket: fee = C × r × p × (1−p)) */
  taker_fee_rate: 0.07,
  /** Paper: rest GTC + match live book (1=on, 0=instant fill legacy) */
  paper_realistic: 1,
  /** Rebalance only if longAvg + shortQuote ≤ pair_sum_max (1=on) */
  rebalance_require_edge: 1,
  /** Paper: fraction of bid-size drop treated as trade (rest = cancel) */
  paper_bid_fill_fraction: 0.05,
  /** Paper: max shares filled per last-trade print when queue is clear */
  paper_tape_fill_shares: 0,
  /** Max completed pair rounds (min(up,down)/chunk) per 5m window */
  max_pair_rounds_per_window: 1,
  /** Skip new pairs when either leg quote is below this (asymmetric fill risk) */
  pair_extreme_min: 0.35,
  /** Skip new pairs when either leg quote is above this */
  pair_extreme_max: 0.65,
  /** Max hi/lo leg quote ratio (blocks 28¢+71¢ style books) */
  pair_max_leg_ratio: 1.5,
};

function paramsPath() {
  return process.env.STRATEGY_PARAMS_FILE
    || path.join(__dirname, '..', 'strategy_params.json');
}

function loadParams() {
  let file = {};
  try {
    file = require('fs').existsSync(paramsPath())
      ? JSON.parse(require('fs').readFileSync(paramsPath(), 'utf8'))
      : {};
  } catch (_) {
    file = {};
  }
  const runtime = readJson('runtime_params.json', {}) || {};
  // Shared strategy_params.json wins so paper/live stay in sync when both mount it.
  return { ...DEFAULTS, ...runtime, ...file };
}

function saveParams(patch = {}) {
  const next = { ...loadParams(), ...patch, updated_at: new Date().toISOString() };
  const sharedKeys = Object.keys(DEFAULTS);
  const shared = {};
  for (const k of sharedKeys) {
    if (next[k] != null) shared[k] = next[k];
  }
  require('fs').writeFileSync(paramsPath(), `${JSON.stringify(shared, null, 2)}\n`, 'utf8');
  writeJson('runtime_params.json', next);
  return next;
}

module.exports = { DEFAULTS, loadParams, saveParams, paramsPath };
