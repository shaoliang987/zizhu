/**
 * Rebuild live ledger PnL from Polymarket Data API /activity.
 * Fixes missing fills, sells, and empty-shell windows so window sums ≈ cash − initial.
 */
const fs = require('fs');
const { rnd } = require('./fees');
const { appendJsonl, dataPath, readJsonl, ensureDataDir } = require('./paths');
const { loadState, saveState, addLog, getOrCreatePosition, bumpWindowBuyUsdc } = require('./ledger');
const { fetchAccountCashUsdc } = require('./account');
const { isDryRun } = require('./mode');

const DATA_API = process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com';

function funderAddress() {
  const addr = String(process.env.POLYMARKET_FUNDER_ADDRESS || '').trim();
  if (!addr) throw new Error('POLYMARKET_FUNDER_ADDRESS missing');
  return addr;
}

async function fetchAllActivity({ limit = 100, maxPages = 20 } = {}) {
  const addr = funderAddress();
  const all = [];
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit;
    const url =
      `${DATA_API}/activity?user=${encodeURIComponent(addr)}` +
      `&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`data-api /activity ${res.status}`);
    const data = await res.json();
    const rows = Array.isArray(data) ? data : [];
    all.push(...rows);
    if (rows.length < limit) break;
  }
  return all;
}

function slugWindowStart(slug) {
  const m = String(slug || '').match(/(\d{10})$/);
  return m ? Number(m[1]) : null;
}

/** Infer binary marks from redeem outcomes (activity settle often omits them). */
function applyRedeemMarks(pos, g) {
  if (!pos || !g) return false;
  const redeemUp = (g.redeems || []).some((r) => String(r.outcome) === 'Up');
  const redeemDown = (g.redeems || []).some((r) => String(r.outcome) === 'Down');
  if (redeemUp && !redeemDown) {
    pos.upMark = 1;
    pos.downMark = 0;
    return true;
  }
  if (redeemDown && !redeemUp) {
    pos.upMark = 0;
    pos.downMark = 1;
    return true;
  }
  return false;
}

/**
 * Merge activity rem shares with local ledger.
 * Critical: never restore shares that local unwind already sold when activity
 * page is stale (sells not yet visible) — that caused endless 未平尽 loops.
 */
function mergeActivityOpenShares({
  prevUp,
  prevDown,
  remUp,
  remDown,
  allowDropUp,
  allowDropDown,
  buySharesUp,
  buySharesDown,
  prevBuyUp,
  prevBuyDown,
  unwinding = false,
}) {
  const newBuysUp = Number(buySharesUp) > Number(prevBuyUp) + 1e-8;
  const newBuysDown = Number(buySharesDown) > Number(prevBuyDown) + 1e-8;

  let nextUp;
  if (allowDropUp) nextUp = remUp;
  else if (newBuysUp && remUp > prevUp + 0.01) nextUp = remUp;
  else nextUp = prevUp;

  let nextDown;
  if (allowDropDown) nextDown = remDown;
  else if (newBuysDown && remDown > prevDown + 0.01) nextDown = remDown;
  else nextDown = prevDown;

  // Don't invent orphans from partial pages
  if (nextUp <= 1e-8 && nextDown > 1e-8 && prevUp > 1e-8 && !allowDropUp) nextUp = prevUp;
  if (nextDown <= 1e-8 && nextUp > 1e-8 && prevDown > 1e-8 && !allowDropDown) nextDown = prevDown;

  // During unwind: never inflate a leg back above local (stale activity restore)
  if (unwinding) {
    nextUp = Math.min(nextUp, prevUp);
    nextDown = Math.min(nextDown, prevDown);
  }

  return {
    nextUp: rnd(Math.max(0, nextUp), 6),
    nextDown: rnd(Math.max(0, nextDown), 6),
  };
}

function marketFromRow(row) {
  const slug = row.slug || row.eventSlug || null;
  const start = slugWindowStart(slug);
  return {
    conditionId: row.conditionId,
    slug,
    title: row.title || slug,
    windowStart: start,
    windowEnd: start != null ? start + 300 : null,
    upTokenId: null,
    downTokenId: null,
  };
}

function tsIsoFromActivity(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return new Date().toISOString();
  // activity timestamps are unix seconds
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

function aggregateByCondition(activity) {
  const byId = new Map();
  let makerRebateUsdc = 0;
  for (const row of activity || []) {
    const typ = String(row?.type || '').toUpperCase();
    if (typ === 'MAKER_REBATE' || typ === 'REBATE') {
      makerRebateUsdc = rnd(makerRebateUsdc + (Number(row.usdcSize) || 0), 6);
      continue;
    }
    const id = row?.conditionId;
    if (!id) continue;
    let g = byId.get(id);
    if (!g) {
      g = {
        conditionId: id,
        title: row.title || null,
        slug: row.slug || row.eventSlug || null,
        buys: [],
        sells: [],
        redeems: [],
        buyUsdc: 0,
        sellUsdc: 0,
        redeemUsdc: 0,
        buySharesUp: 0,
        buySharesDown: 0,
        sellSharesUp: 0,
        sellSharesDown: 0,
      };
      byId.set(id, g);
    }
    if (row.title && !g.title) g.title = row.title;
    if ((row.slug || row.eventSlug) && !g.slug) g.slug = row.slug || row.eventSlug;

    const side = String(row.side || '').toUpperCase();
    const usdc = Number(row.usdcSize) || 0;
    const size = Number(row.size) || 0;
    const outcome = String(row.outcome || '');

    if (typ === 'TRADE' && side === 'BUY') {
      g.buys.push(row);
      g.buyUsdc = rnd(g.buyUsdc + usdc, 6);
      if (outcome === 'Up') g.buySharesUp = rnd(g.buySharesUp + size, 6);
      else if (outcome === 'Down') g.buySharesDown = rnd(g.buySharesDown + size, 6);
    } else if (typ === 'TRADE' && side === 'SELL') {
      g.sells.push(row);
      g.sellUsdc = rnd(g.sellUsdc + usdc, 6);
      if (outcome === 'Up') g.sellSharesUp = rnd(g.sellSharesUp + size, 6);
      else if (outcome === 'Down') g.sellSharesDown = rnd(g.sellSharesDown + size, 6);
    } else if (typ === 'REDEEM' || typ === 'CLAIM') {
      g.redeems.push(row);
      g.redeemUsdc = rnd(g.redeemUsdc + usdc, 6);
    }
  }

  for (const g of byId.values()) {
    g.realized_pnl_usdc = rnd(g.sellUsdc + g.redeemUsdc - g.buyUsdc, 4);
    g.hasRedeem = g.redeems.length > 0;
  }
  byId.makerRebateUsdc = rnd(makerRebateUsdc, 4);
  return byId;
}

function tradeRowFromActivity(row, type) {
  const market = marketFromRow(row);
  const shares = Number(row.size) || 0;
  const price = Number(row.price) || 0;
  const cost = Number(row.usdcSize) || 0;
  const notional = type === 'LIVE_SELL' ? cost : (price > 0 ? rnd(shares * price, 6) : cost);
  return {
    ts: tsIsoFromActivity(row.timestamp),
    type,
    conditionId: market.conditionId,
    slug: market.slug,
    title: market.title,
    side: row.outcome === 'Down' ? 'Down' : row.outcome === 'Up' ? 'Up' : (row.outcome || null),
    shares,
    price,
    notional,
    fee: 0,
    cost,
    orderId: row.transactionHash || null,
    txHash: row.transactionHash || null,
    activityBackfill: true,
    paired: false,
    liquidity: 'activity',
  };
}

function backupFile(name) {
  ensureDataDir();
  const src = dataPath(name);
  if (!fs.existsSync(src)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = dataPath(`${name}.bak-${stamp}`);
  fs.copyFileSync(src, dest);
  return dest;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] — compute only, no writes
 * @param {boolean} [opts.rewriteTrades=true] — replace LIVE_* trades with activity
 */
async function backfillFromActivity(opts = {}) {
  if (isDryRun() && opts.allowPaper !== true) {
    throw new Error('activity backfill is for live STATE_DIR (DRY_RUN=false)');
  }

  const dryRun = Boolean(opts.dryRun);
  const rewriteTrades = opts.rewriteTrades !== false;

  const activity = await fetchAllActivity();
  const byCond = aggregateByCondition(activity);
  const state = loadState();

  const before = {
    cash: Number(state.cash_usdc) || 0,
    realized: Number(state.stats?.realized_pnl_usdc) || 0,
    posSum: Object.values(state.positions || {}).reduce(
      (s, p) => s + (p.settled ? Number(p.realizedPnl) || 0 : 0),
      0
    ),
  };

  let updated = 0;
  let created = 0;
  let activityPnlSum = 0;

  for (const [id, g] of byCond.entries()) {
    activityPnlSum = rnd(activityPnlSum + g.realized_pnl_usdc, 4);
    const market = marketFromRow({
      conditionId: id,
      title: g.title,
      slug: g.slug,
    });
    const existed = Boolean(state.positions[id]);
    const pos = getOrCreatePosition(state, market);
    if (!existed) created += 1;

    const prev = Number(pos.realizedPnl) || 0;
    pos.title = g.title || pos.title;
    pos.slug = g.slug || pos.slug;
    if (market.windowStart && !pos.windowStart) pos.windowStart = market.windowStart;
    if (market.windowEnd && !pos.windowEnd) pos.windowEnd = market.windowEnd;

    const remUp = rnd(Math.max(0, g.buySharesUp - g.sellSharesUp), 6);
    const remDown = rnd(Math.max(0, g.buySharesDown - g.sellSharesDown), 6);
    const remShares = remUp + remDown;
    const nowSec = Math.floor(Date.now() / 1000);
    const windowEnded = market.windowEnd != null && Number(market.windowEnd) <= nowSec;
    // Treat ended / redeemed / flat windows as settled. Leftover shares on ended
    // markets with no REDEEM in activity are assumed resolved into cash already
    // (official redeem) or worthless — net pnl stays sell+redeem−buy.
    const stillOpen = remShares > 0.01 && !g.hasRedeem && !windowEnded;

    if (!stillOpen) {
      pos.upShares = 0;
      pos.downShares = 0;
      pos.upCost = 0;
      pos.downCost = 0;
      pos.investedUsdc = 0;
      pos.settled = true;
      pos.settling = false;
      pos.realizedPnl = g.realized_pnl_usdc;
      pos.windowRealizedChurn = rnd(g.sellUsdc - Math.min(g.buyUsdc, g.sellUsdc), 4);
      pos.settleReason = 'activity-backfill';
      pos.settledAt = pos.settledAt || new Date().toISOString();
      pos.redeemed = g.hasRedeem || windowEnded ? true : Boolean(pos.redeemed);
      if (pos.redeemed) {
        pos.redeemVia = pos.redeemVia || 'activity-backfill';
        pos.redeemedAt = pos.redeemedAt || new Date().toISOString();
      }
      applyRedeemMarks(pos, g);
      bumpWindowBuyUsdc(pos, g.buyUsdc);
      delete pos.pairInflight;
      delete pos.pairRiskLock;
      if (Math.abs(prev - g.realized_pnl_usdc) > 0.005) updated += 1;
    } else {
      pos.settled = false;
      pos.upShares = remUp;
      pos.downShares = remDown;
      const buyUp = g.buys.filter((b) => b.outcome === 'Up');
      const buyDn = g.buys.filter((b) => b.outcome === 'Down');
      const upCostAll = buyUp.reduce((s, b) => s + (Number(b.usdcSize) || 0), 0);
      const dnCostAll = buyDn.reduce((s, b) => s + (Number(b.usdcSize) || 0), 0);
      const upFrac = g.buySharesUp > 1e-9 ? remUp / g.buySharesUp : 0;
      const dnFrac = g.buySharesDown > 1e-9 ? remDown / g.buySharesDown : 0;
      pos.upCost = rnd(upCostAll * upFrac, 4);
      pos.downCost = rnd(dnCostAll * dnFrac, 4);
      pos.investedUsdc = rnd(pos.upCost + pos.downCost, 4);
      bumpWindowBuyUsdc(pos, g.buyUsdc);
      pos.realizedPnl = rnd(
        g.sellUsdc - (upCostAll * (1 - upFrac) + dnCostAll * (1 - dnFrac)),
        4
      );
      pos.windowRealizedChurn = pos.realizedPnl;
      updated += 1;
    }
    pos.updatedAt = new Date().toISOString();
    pos.activityBackfilledAt = new Date().toISOString();
  }

  // Sync cash from CLOB when possible
  let clobCash = null;
  try {
    clobCash = await fetchAccountCashUsdc({ force: true });
  } catch (_) {
    clobCash = Number(state.clob_cash_usdc) || Number(state.cash_usdc) || null;
  }
  if (clobCash != null) {
    state.cash_usdc = rnd(clobCash, 4);
    state.clob_cash_usdc = rnd(clobCash, 4);
    state.clob_cash_synced_at = new Date().toISOString();
  }

  const capital = Number(state.initial_capital_usdc) || 0;
  const cash = Number(state.cash_usdc) || 0;
  const openCost = Object.values(state.positions || {}).reduce((s, p) => {
    if (p.settled) return s;
    return s + (Number(p.upCost) || 0) + (Number(p.downCost) || 0);
  }, 0);
  const hasOpen = Object.values(state.positions || {}).some(
    (p) => !p.settled && ((Number(p.upShares) || 0) > 1e-8 || (Number(p.downShares) || 0) > 1e-8)
  );
  const posSum = Object.values(state.positions || {}).reduce(
    (s, p) => s + (Number(p.realizedPnl) || 0),
    0
  );
  const makerRebate = Number(byCond.makerRebateUsdc) || 0;
  const cashTruth = hasOpen ? rnd(cash + openCost - capital, 4) : rnd(cash - capital, 4);
  // Window PnL + maker ≈ cash truth (rebate is not per-window)
  const accounted = rnd(posSum + makerRebate, 4);

  if (!state.stats) state.stats = {};
  state.stats.strategy_realized_pnl_usdc = rnd(posSum, 4);
  state.stats.maker_rebate_usdc = rnd(makerRebate, 4);
  state.stats.realized_pnl_usdc = cashTruth;
  state.stats.realized_pnl_clob_drift_usdc = rnd(cashTruth - accounted, 4);
  state.stats.activity_backfilled_at = new Date().toISOString();
  state.stats.settled_markets = Object.values(state.positions || {}).filter((p) => p.settled).length;

  const buyUsdc = [...byCond.values()].reduce((s, g) => s + g.buyUsdc, 0);
  const sellUsdc = [...byCond.values()].reduce((s, g) => s + g.sellUsdc, 0);
  const redeemUsdc = [...byCond.values()].reduce((s, g) => s + g.redeemUsdc, 0);
  state.stats.total_buy_usdc = rnd(buyUsdc, 4);
  state.stats.total_proceeds_usdc = rnd(sellUsdc + redeemUsdc, 4);

  const report = {
    dryRun,
    activityRows: activity.length,
    conditions: byCond.size,
    positionsUpdated: updated,
    positionsCreated: created,
    activityPnlSum: rnd(activityPnlSum, 4),
    positionPnlSum: rnd(posSum, 4),
    makerRebateUsdc: rnd(makerRebate, 4),
    cashTruth,
    residual: rnd(cashTruth - accounted, 4),
    buyUsdc: rnd(buyUsdc, 4),
    sellUsdc: rnd(sellUsdc, 4),
    redeemUsdc: rnd(redeemUsdc, 4),
    before,
    cash,
  };

  if (dryRun) return report;

  const bakState = backupFile('state.json');
  const bakTrades = backupFile('trades.jsonl');
  const bakSettle = backupFile('settlement_log.jsonl');
  report.backups = { state: bakState, trades: bakTrades, settlement: bakSettle };

  if (rewriteTrades) {
    const paper = (readJsonl('trades.jsonl') || []).filter(
      (t) => t && String(t.type || '').startsWith('PAPER_')
    );
    const liveRows = [];
    for (const g of byCond.values()) {
      for (const b of g.buys) liveRows.push(tradeRowFromActivity(b, 'LIVE_BUY'));
      for (const s of g.sells) liveRows.push(tradeRowFromActivity(s, 'LIVE_SELL'));
    }
    liveRows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const lines = [...paper, ...liveRows].map((r) => JSON.stringify(r));
    fs.writeFileSync(dataPath('trades.jsonl'), lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
    state.stats.fills = liveRows.filter((r) => r.type === 'LIVE_BUY').length + paper.length;
  }

  // Rewrite settlement log with activity nets (keep history by appending a batch marker)
  for (const g of byCond.values()) {
    if (!g.hasRedeem && g.sells.length === 0 && Math.abs(g.realized_pnl_usdc) < 1e-9) continue;
    appendJsonl('settlement_log.jsonl', {
      ts: new Date().toISOString(),
      conditionId: g.conditionId,
      slug: g.slug,
      title: g.title,
      upMark: null,
      downMark: null,
      realized: g.realized_pnl_usdc,
      fees: 0,
      reason: 'activity-backfill',
      source: 'polymarket-activity',
      buyUsdc: rnd(g.buyUsdc, 4),
      sellUsdc: rnd(g.sellUsdc, 4),
      redeemUsdc: rnd(g.redeemUsdc, 4),
      recovered: true,
    });
  }

  addLog(
    state,
    `[回补] activity 重建完成 · 窗口 ${byCond.size} · 账本已实现 $${posSum.toFixed(2)}` +
      (makerRebate > 0.005 ? ` · 返佣 $${makerRebate.toFixed(2)}` : '') +
      ` · 现金口径 $${cashTruth.toFixed(2)} · 残余 $${(cashTruth - accounted).toFixed(2)}`,
    Math.abs(cashTruth - accounted) < 0.5 ? 'success' : 'warning'
  );
  saveState(state);
  return report;
}

module.exports = {
  fetchAllActivity,
  aggregateByCondition,
  backfillFromActivity,
  syncActivityLedger,
  syncLiveFillsQuick,
  knownTradeTxHashes,
  isDuplicateMakerFill,
  mergeActivityOpenShares,
};

function knownTradeTxHashes() {
  const set = new Set();
  for (const t of readJsonl('trades.jsonl') || []) {
    const h = t?.txHash || (t?.activityBackfill ? t.orderId : null);
    if (h) set.add(String(h).toLowerCase());
  }
  return set;
}

/** Skip activity rows that duplicate a maker-recorded live fill. */
function isDuplicateMakerFill(existingTrades, row, type) {
  const cid = row?.conditionId;
  if (!cid) return false;
  const side = row.outcome === 'Down' ? 'Down' : row.outcome === 'Up' ? 'Up' : null;
  if (!side) return false;
  const shares = Number(row.size) || 0;
  const price = Number(row.price) || 0;
  if (!(shares > 0) || !(price > 0)) return false;
  const tsMs = Number(row.timestamp) < 1e12 ? Number(row.timestamp) * 1000 : Number(row.timestamp);

  for (const t of existingTrades || []) {
    if (t.activityBackfill) continue;
    if (t.conditionId !== cid || t.side !== side) continue;
    const typ = String(t.type || '');
    if (type === 'LIVE_BUY' && !typ.includes('BUY')) continue;
    if (type === 'LIVE_SELL' && !typ.includes('SELL')) continue;
    if (Math.abs(Number(t.shares) - shares) > 0.02) continue;
    const tMs = new Date(t.ts).getTime();
    if (!(Number.isFinite(tsMs) && Number.isFinite(tMs) && Math.abs(tMs - tsMs) < 300000)) {
      continue;
    }
    const priceDiff = Math.abs(Number(t.price) - price);
    // Exact-ish price match
    if (priceDiff <= 0.03) return true;
    // Maker often books at limit; activity has actual fill px (e.g. 0.57 vs 0.51).
    // Treat as same fill when maker row has no chain txHash or was tagged maker.
    const makerLimitBooked = !t.txHash || String(t.liquidity || '') === 'maker';
    if (makerLimitBooked && priceDiff <= 0.25) return true;
  }
  return false;
}

/**
 * Incremental live sync: append missing activity trades, refresh per-window PnL,
 * align cash. Safe to run periodically (no full trades rewrite).
 */
async function syncActivityLedger(state, opts = {}) {
  if (isDryRun()) return { skipped: true, reason: 'paper' };

  const maxPages = Number(opts.maxPages) || 5;
  const activity = await fetchAllActivity({ limit: 100, maxPages });
  const byCond = aggregateByCondition(activity);
  const known = knownTradeTxHashes();
  const existingTrades = readJsonl('trades.jsonl') || [];

  let appended = 0;
  const touched = new Set();

  for (const g of byCond.values()) {
    for (const b of g.buys) {
      const h = String(b.transactionHash || '').toLowerCase();
      if (!h || known.has(h)) continue;
      if (isDuplicateMakerFill(existingTrades, b, 'LIVE_BUY')) continue;
      const row = tradeRowFromActivity(b, 'LIVE_BUY');
      appendJsonl('trades.jsonl', row);
      existingTrades.push(row);
      known.add(h);
      appended += 1;
      touched.add(g.conditionId);
    }
    for (const s of g.sells) {
      const h = String(s.transactionHash || '').toLowerCase();
      if (!h || known.has(h)) continue;
      if (isDuplicateMakerFill(existingTrades, s, 'LIVE_SELL')) continue;
      const row = tradeRowFromActivity(s, 'LIVE_SELL');
      appendJsonl('trades.jsonl', row);
      existingTrades.push(row);
      known.add(h);
      appended += 1;
      touched.add(g.conditionId);
    }
  }

  let updated = 0;
  // Partial page fetches miss older buys; never rewrite already-settled PnL unless
  // this sync appended fills for that window (or caller explicitly allows).
  const rewriteSettled = opts.rewriteSettled === true;

  for (const [id, g] of byCond.entries()) {
    const market = marketFromRow({ conditionId: id, title: g.title, slug: g.slug });
    const pos = getOrCreatePosition(state, market);
    pos.title = g.title || pos.title;
    pos.slug = g.slug || pos.slug;
    if (market.windowStart && !pos.windowStart) pos.windowStart = market.windowStart;
    if (market.windowEnd && !pos.windowEnd) pos.windowEnd = market.windowEnd;

    const remUp = rnd(Math.max(0, g.buySharesUp - g.sellSharesUp), 6);
    const remDown = rnd(Math.max(0, g.buySharesDown - g.sellSharesDown), 6);
    const remShares = remUp + remDown;
    // Cash cycle complete only when flat or redeemed. Do NOT force-settle on
    // windowEnded alone — partial pages often miss REDEEM and would write
    // realized ≈ −buy (phantom full losses, e.g. Aug 24 11:10 −$23 vs +$7).
    const cashCycleComplete = remShares <= 0.01 || g.hasRedeem;
    const stillOpen = !cashCycleComplete;

    const prev = Number(pos.realizedPnl) || 0;
    const wasSettled = Boolean(pos.settled);
    // Incomplete activity: redeem/sell without matching buys (common with maxPages=2)
    const activityIncomplete =
      (g.hasRedeem || g.sellUsdc > 0.01) && g.buyUsdc < 0.01;
    // Catch-up: prior sync settled before redeem appeared; now redeem is visible.
    const redeemCatchUp =
      wasSettled &&
      g.hasRedeem &&
      g.buyUsdc > 0.05 &&
      Math.abs(prev - g.realized_pnl_usdc) > 0.25;
    const mayRewriteSettled =
      rewriteSettled || touched.has(id) || !wasSettled || redeemCatchUp;

    if (!stillOpen) {
      // Already settled + partial pages → skip (was corrupting Aug 22 to +$20)
      if (wasSettled && !mayRewriteSettled) continue;
      if (wasSettled && activityIncomplete && !touched.has(id) && !redeemCatchUp) continue;

      // Open → settle with incomplete activity would invent phantom profits
      if (!wasSettled && activityIncomplete && !touched.has(id)) continue;

      pos.upShares = 0;
      pos.downShares = 0;
      pos.upCost = 0;
      pos.downCost = 0;
      pos.investedUsdc = 0;
      pos.settled = true;
      pos.settling = false;
      pos.realizedPnl = g.realized_pnl_usdc;
      pos.settleReason = 'activity-sync';
      pos.settledAt = pos.settledAt || new Date().toISOString();
      pos.activityBackfilledAt = new Date().toISOString();
      if (g.hasRedeem) {
        pos.redeemed = true;
        pos.redeemVia = pos.redeemVia || 'activity-sync';
        pos.redeemedAt = pos.redeemedAt || new Date().toISOString();
      }
      applyRedeemMarks(pos, g);
      bumpWindowBuyUsdc(pos, g.buyUsdc);
      delete pos.pairInflight;
      if (Math.abs(prev - g.realized_pnl_usdc) > 0.005 || touched.has(id) || redeemCatchUp) {
        updated += 1;
        appendJsonl('settlement_log.jsonl', {
          ts: new Date().toISOString(),
          conditionId: id,
          slug: g.slug,
          title: g.title,
          realized: g.realized_pnl_usdc,
          fees: 0,
          reason: redeemCatchUp ? 'activity-sync-redeem-catchup' : 'activity-sync',
          source: 'polymarket-activity',
          buyUsdc: rnd(g.buyUsdc, 4),
          sellUsdc: rnd(g.sellUsdc, 4),
          redeemUsdc: rnd(g.redeemUsdc, 4),
          upMark: pos.upMark != null ? Number(pos.upMark) : null,
          downMark: pos.downMark != null ? Number(pos.downMark) : null,
        });
      }
    } else {
      // Never reopen an already-settled window: partial activity pages often show
      // remShares>0 without REDEEM, which made settled rows flash in 持仓 then vanish.
      if (wasSettled && !touched.has(id)) continue;

      const prevUp = Number(pos.upShares) || 0;
      const prevDown = Number(pos.downShares) || 0;
      // Only drop when sells increased since last sync (or we appended fills).
      // Historical sells alone must not keep zeroing legs after a re-buy hedge.
      const prevSellUp = Number(pos.activitySellUp) || 0;
      const prevSellDown = Number(pos.activitySellDown) || 0;
      const prevBuyUp = Number(pos.activityBuyUp) || 0;
      const prevBuyDown = Number(pos.activityBuyDown) || 0;
      const allowDropUp =
        touched.has(id) || g.sellSharesUp > prevSellUp + 1e-8;
      const allowDropDown =
        touched.has(id) || g.sellSharesDown > prevSellDown + 1e-8;
      const unwinding = /unwind/i.test(String(pos.pairInflight?.reason || ''));
      const { nextUp, nextDown } = mergeActivityOpenShares({
        prevUp,
        prevDown,
        remUp,
        remDown,
        allowDropUp,
        allowDropDown,
        buySharesUp: g.buySharesUp,
        buySharesDown: g.buySharesDown,
        prevBuyUp,
        prevBuyDown,
        unwinding,
      });
      const sharesChanged =
        Math.abs(prevUp - nextUp) > 0.01 || Math.abs(prevDown - nextDown) > 0.01;

      pos.settled = false;
      pos.upShares = nextUp;
      pos.downShares = nextDown;
      pos.activitySellUp = g.sellSharesUp;
      pos.activitySellDown = g.sellSharesDown;
      pos.activityBuyUp = g.buySharesUp;
      pos.activityBuyDown = g.buySharesDown;
      const buyUp = g.buys.filter((b) => b.outcome === 'Up');
      const buyDn = g.buys.filter((b) => b.outcome === 'Down');
      const upCostAll = buyUp.reduce((s, b) => s + (Number(b.usdcSize) || 0), 0);
      const dnCostAll = buyDn.reduce((s, b) => s + (Number(b.usdcSize) || 0), 0);
      // Prefer local cost basis when activity buy totals look incomplete
      if (upCostAll > 1e-8 || allowDropUp) {
        const upFrac = g.buySharesUp > 1e-9 ? nextUp / g.buySharesUp : 0;
        pos.upCost = rnd(upCostAll * upFrac, 4);
      } else if (nextUp > 1e-8 && !(Number(pos.upCost) > 0)) {
        /* keep existing */
      }
      if (dnCostAll > 1e-8 || allowDropDown) {
        const dnFrac = g.buySharesDown > 1e-9 ? nextDown / g.buySharesDown : 0;
        pos.downCost = rnd(dnCostAll * dnFrac, 4);
      }
      // Scale costs with share increases when we only merged upward
      if (!allowDropUp && nextUp > prevUp + 0.01 && prevUp > 1e-8 && Number(pos.upCost) > 0) {
        pos.upCost = rnd((Number(pos.upCost) / prevUp) * nextUp, 4);
      }
      if (!allowDropDown && nextDown > prevDown + 0.01 && prevDown > 1e-8 && Number(pos.downCost) > 0) {
        pos.downCost = rnd((Number(pos.downCost) / prevDown) * nextDown, 4);
      }
      pos.investedUsdc = rnd((Number(pos.upCost) || 0) + (Number(pos.downCost) || 0), 4);
      bumpWindowBuyUsdc(pos, g.buyUsdc);
      if (g.sellUsdc > 0.01 && (allowDropUp || allowDropDown)) {
        const upFrac = g.buySharesUp > 1e-9 ? nextUp / g.buySharesUp : 0;
        const dnFrac = g.buySharesDown > 1e-9 ? nextDown / g.buySharesDown : 0;
        pos.realizedPnl = rnd(
          g.sellUsdc - (upCostAll * (1 - upFrac) + dnCostAll * (1 - dnFrac)),
          4
        );
        pos.windowRealizedChurn = pos.realizedPnl;
      }
      pos.activityBackfilledAt = new Date().toISOString();

      if (sharesChanged || touched.has(id)) {
        if (sharesChanged) {
          addLog(
            state,
            `[成交入账] activity · ${pos.title || g.slug} · Up ${prevUp.toFixed(2)}→${nextUp.toFixed(2)}` +
              ` Down ${prevDown.toFixed(2)}→${nextDown.toFixed(2)}`,
            'success'
          );
        }
        updated += 1;
      }
    }
    pos.updatedAt = new Date().toISOString();
  }

  let clobCash = null;
  try {
    clobCash = await fetchAccountCashUsdc({ force: true });
  } catch (_) {
    clobCash = Number(state.clob_cash_usdc) || Number(state.cash_usdc) || null;
  }
  if (clobCash != null) {
    state.cash_usdc = rnd(clobCash, 4);
    state.clob_cash_usdc = rnd(clobCash, 4);
    state.clob_cash_synced_at = new Date().toISOString();
  }

  const capital = Number(state.initial_capital_usdc) || 0;
  const cash = Number(state.cash_usdc) || 0;
  const openCost = Object.values(state.positions || {}).reduce((s, p) => {
    if (p.settled) return s;
    return s + (Number(p.upCost) || 0) + (Number(p.downCost) || 0);
  }, 0);
  const hasOpen = Object.values(state.positions || {}).some(
    (p) => !p.settled && ((Number(p.upShares) || 0) > 1e-8 || (Number(p.downShares) || 0) > 1e-8)
  );
  const posSum = Object.values(state.positions || {}).reduce(
    (s, p) => s + (Number(p.realizedPnl) || 0),
    0
  );
  const makerRebate = Number(byCond.makerRebateUsdc) || 0;
  const cashTruth = hasOpen ? rnd(cash + openCost - capital, 4) : rnd(cash - capital, 4);
  const accounted = rnd(posSum + makerRebate, 4);

  if (!state.stats) state.stats = {};
  state.stats.strategy_realized_pnl_usdc = rnd(posSum, 4);
  if (makerRebate > 0) state.stats.maker_rebate_usdc = rnd(makerRebate, 4);
  state.stats.realized_pnl_usdc = cashTruth;
  state.stats.realized_pnl_clob_drift_usdc = rnd(cashTruth - accounted, 4);
  state.stats.activity_backfilled_at = new Date().toISOString();
  state.stats.activity_synced_at = new Date().toISOString();

  const residual = rnd(cashTruth - accounted, 4);
  if (appended > 0 || updated > 0 || Math.abs(residual) > 0.05) {
    addLog(
      state,
      `[对账] activity 同步 · 补成交 ${appended} · 更新窗 ${updated}` +
        ` · 账本 $${posSum.toFixed(2)}` +
        (makerRebate > 0.005 ? ` · 返佣 $${makerRebate.toFixed(2)}` : '') +
        ` · 现金口径 $${cashTruth.toFixed(2)}` +
        ` · 残余 $${residual.toFixed(2)}`,
      Math.abs(residual) < 0.5 ? 'info' : 'warning'
    );
  }

  saveState(state);
  return { appended, updated, residual, cashTruth, positionPnlSum: rnd(posSum, 4), activityRows: activity.length };
}

let _quickSyncAt = 0;

/**
 * Lightweight per-scan fill sync — recent activity + open position inventory.
 */
async function syncLiveFillsQuick(state, opts = {}) {
  if (isDryRun()) return { skipped: true, reason: 'paper' };

  const minIntervalMs = Number(opts.minIntervalMs) || 800;
  const now = Date.now();
  if (!opts.force && now - _quickSyncAt < minIntervalMs) {
    return { skipped: true, reason: 'throttled' };
  }
  _quickSyncAt = now;

  return syncActivityLedger(state, {
    maxPages: Number(opts.maxPages) || 2,
  });
}
