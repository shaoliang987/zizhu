const { getLastTradePrice } = require('./book');
const { addLog, saveState } = require('./ledger');
const { loadParams } = require('./strategy');
const { rnd } = require('./fees');
const { appendJsonl } = require('./paths');
const { cancelOrdersForMarket } = require('./paper_clob');
const { isLive } = require('./mode');

const GAMMA = 'https://gamma-api.polymarket.com';

function binaryFromHardExtreme(px) {
  if (!Number.isFinite(px)) return null;
  if (px >= 0.99) return 1;
  if (px <= 0.01) return 0;
  return null;
}

async function fetchGammaResolvedSettlePrice(title, outcome) {
  if (!title || !outcome) return null;
  try {
    const url = `${GAMMA}/public-search?q=${encodeURIComponent(String(title).slice(0, 80))}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    for (const ev of data.events || []) {
      for (const m of ev.markets || []) {
        if (m.question !== title && m.title !== title && ev.title !== title) continue;
        let prices = m.outcomePrices;
        let outcomes = m.outcomes;
        if (typeof prices === 'string') {
          try { prices = JSON.parse(prices); } catch (_) { prices = null; }
        }
        if (typeof outcomes === 'string') {
          try { outcomes = JSON.parse(outcomes); } catch (_) { outcomes = null; }
        }
        if (!Array.isArray(prices) || !Array.isArray(outcomes)) continue;
        const idx = outcomes.findIndex(
          (o) => String(o).toLowerCase() === String(outcome).toLowerCase()
        );
        if (idx < 0) continue;
        const px = Number(prices[idx]);
        const bin = binaryFromHardExtreme(px);
        if (bin != null) {
          return { price: bin, curPrice: px, source: 'gamma-search' };
        }
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

function parseJsonField(v, fallback = []) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (_) { return fallback; }
  }
  return fallback;
}

/** Prefer exact conditionId lookup; avoids title collision. */
async function fetchGammaByConditionId(conditionId) {
  const cid = String(conditionId || '').trim();
  if (!cid) return null;
  try {
    const data = await fetchJson(
      `${GAMMA}/markets?condition_ids=${encodeURIComponent(cid)}`
    );
    const market = Array.isArray(data) ? data[0] : data;
    if (!market) return null;

    let prices = market.outcomePrices;
    let outcomes = parseJsonField(market.outcomes, ['Up', 'Down']);
    if (typeof prices === 'string') {
      try { prices = JSON.parse(prices); } catch (_) { prices = null; }
    }
    if (!Array.isArray(prices) || !Array.isArray(outcomes)) return null;

    const upIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'up');
    const downIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'down');
    const ui = upIdx >= 0 ? upIdx : 0;
    const di = downIdx >= 0 ? downIdx : 1;

    const upPx = Number(prices[ui]);
    const downPx = Number(prices[di]);
    const upMark = binaryFromHardExtreme(upPx);
    const downMark = binaryFromHardExtreme(downPx);

    if (upMark == null && downMark == null) return null;

    return {
      upMark: upMark != null ? upMark : (downMark != null ? 1 - downMark : null),
      downMark: downMark != null ? downMark : (upMark != null ? 1 - upMark : null),
      upCurPrice: upPx,
      downCurPrice: downPx,
      source: 'gamma-condition-id',
      conditionId: cid,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Binary invariant (baloneigh): at most one leg @ $1; never clear both @ $0.
 */
function applyBinarySettleInvariant(upMark, downMark) {
  let u = upMark;
  let d = downMark;
  let corrected = false;
  if (u === 1 && d === 1) {
    d = 0;
    corrected = true;
  }
  if (u === 0 && d === 0) {
    return { ok: false, upMark: u, downMark: d, refused: 'both legs @ $0 — wait for oracle' };
  }
  if (u == null && d === 1) u = 0;
  if (d == null && u === 1) d = 0;
  if (u == null && d === 0) u = 1;
  if (d == null && u === 0) d = 1;
  return { ok: u != null && d != null, upMark: u, downMark: d, corrected };
}

/** Compute leg settle without mutating state. */
function computeLegSettle(pos, side, settlePrice) {
  const shares = side === 'Up' ? Number(pos.upShares) || 0 : Number(pos.downShares) || 0;
  const costBasis = side === 'Up' ? Number(pos.upCost) || 0 : Number(pos.downCost) || 0;
  if (!(shares > 1e-8)) {
    return { shares: 0, proceeds: 0, realized: 0, price: settlePrice, costBasis: 0 };
  }
  const price = Math.max(0, Math.min(1, Number(settlePrice) || 0));
  const proceeds = rnd(shares * price, 4);
  const realized = rnd(proceeds - costBasis, 4);
  return { shares, proceeds, realized, price, costBasis };
}

function applySettleCashStats(state, proceeds, realized) {
  if (isLive()) return;
  state.cash_usdc = rnd((Number(state.cash_usdc) || 0) + proceeds, 4);
  state.stats.realized_pnl_usdc = rnd(
    (Number(state.stats.realized_pnl_usdc) || 0) + realized,
    4
  );
  state.stats.total_proceeds_usdc = rnd(
    (Number(state.stats.total_proceeds_usdc) || 0) + proceeds,
    4
  );
}

/**
 * Per-leg settle like baloneigh:
 * proceeds = shares × (0|1); realized = proceeds − costBasis (fees already in cost).
 */
function settleLeg(state, pos, side, settlePrice, reason) {
  const computed = computeLegSettle(pos, side, settlePrice);
  if (!(computed.shares > 1e-8)) {
    return { shares: 0, proceeds: 0, realized: 0, price: settlePrice };
  }

  applySettleCashStats(state, computed.proceeds, computed.realized);

  if (side === 'Up') {
    pos.upShares = 0;
    pos.upCost = 0;
    pos.upMark = computed.price;
  } else {
    pos.downShares = 0;
    pos.downCost = 0;
    pos.downMark = computed.price;
  }

  addLog(
    state,
    `[结算清仓] ${pos.title} (${side}) | ${computed.shares.toFixed(2)} shares @ $${computed.price}` +
      ` → 已实现 ${computed.realized >= 0 ? '+' : ''}${computed.realized.toFixed(2)} USDC (${reason})`,
    computed.realized >= 0 ? 'success' : 'warning'
  );

  return computed;
}

function finalizeSettledPosition(state, pos, reason, meta = {}) {
  const settleRealized =
    rnd((Number(pos._settleRealizedUp) || 0) + (Number(pos._settleRealizedDown) || 0), 4);
  const churn = rnd(Number(pos.windowRealizedChurn) || 0, 4);
  const realized = rnd(churn + settleRealized, 4);
  pos.settled = true;
  pos.settling = false;
  pos.settledAt = new Date().toISOString();
  pos.realizedPnl = realized;
  pos.settleReason = reason;
  pos.investedUsdc = 0;
  pos.updatedAt = pos.settledAt;
  delete pos._settleRealizedUp;
  delete pos._settleRealizedDown;
  state.stats.settled_markets += 1;

  appendJsonl('settlement_log.jsonl', {
    ts: pos.settledAt,
    conditionId: pos.conditionId,
    slug: pos.slug,
    title: pos.title,
    upMark: pos.upMark,
    downMark: pos.downMark,
    realized,
    fees: rnd((Number(pos.upFees) || 0) + (Number(pos.downFees) || 0), 6),
    reason,
    ...meta,
  });
}

/**
 * Recover incomplete settles after crash / empty shells after unfilled posts.
 * - shares cleared but !settled → finalize
 * - settling with _pendingSettle and shares still present → re-apply once
 * - window ended, flat, no resting orders, no cost → mark settled (ghost pair posts)
 */
function recoverZombieSettlements(state, nowSec = Math.floor(Date.now() / 1000)) {
  const { ordersForMarket } = require('./paper_clob');
  const { clearPairInflight, clearPairRiskLock } = require('./pair_risk');
  let n = 0;
  for (const pos of Object.values(state.positions || {})) {
    if (pos.settled) continue;
    const upSh = Number(pos.upShares) || 0;
    const downSh = Number(pos.downShares) || 0;
    const pending = pos._pendingSettle;

    if (pending && (upSh > 1e-8 || downSh > 1e-8)) {
      applyPendingSettle(state, pos);
      n += 1;
      continue;
    }

    const hasMarks = pos.upMark != null || pos.downMark != null;
    if (upSh <= 1e-8 && downSh <= 1e-8 && (pos.settling || hasMarks || pending)) {
      if (pending) {
        pos._settleRealizedUp = Number(pending.up?.realized) || 0;
        pos._settleRealizedDown = Number(pending.down?.realized) || 0;
      } else {
        pos._settleRealizedUp = Number(pos._settleRealizedUp) || 0;
        pos._settleRealizedDown = Number(pos._settleRealizedDown) || 0;
      }
      const reason = pos.settleReason || pending?.reason || 'recovered incomplete settle';
      clearPairInflight(pos);
      clearPairRiskLock(pos);
      finalizeSettledPosition(state, pos, reason, {
        source: pending?.source || 'recovery',
        recovered: true,
      });
      delete pos._pendingSettle;
      addLog(state, `[结算恢复] ${pos.title || pos.slug} 僵尸仓已标记 settled`, 'warning');
      n += 1;
      continue;
    }

    // Empty shell: pair posted but never filled (or fully flat), window over, no open orders
    if (upSh <= 1e-8 && downSh <= 1e-8) {
      const windowEnd = Number(pos.windowEnd) || 0;
      const windowOver = windowEnd > 0 && nowSec >= windowEnd;
      const open = ordersForMarket(state, pos.conditionId);
      const invested = Number(pos.investedUsdc) || 0;
      const costs = (Number(pos.upCost) || 0) + (Number(pos.downCost) || 0);
      if (windowOver && open.length === 0 && invested <= 1e-8 && costs <= 1e-8) {
        // Give activity / CLOB sync time to book late fills before empty-shell
        if (windowEnd > 0 && nowSec - windowEnd < 120) continue;

        // Do not mark empty if trades.jsonl already has fills for this market
        const { readFills } = require('./ledger');
        const hasFill = (readFills() || []).some(
          (t) =>
            t &&
            t.conditionId === pos.conditionId &&
            (t.type === 'LIVE_BUY' || t.type === 'LIVE_SELL' || t.type === 'PAPER_BUY')
        );
        if (hasFill) {
          // Inventory was cleared without settle — leave for settle-check / activity sync
          continue;
        }
        clearPairInflight(pos);
        clearPairRiskLock(pos);
        pos._settleRealizedUp = 0;
        pos._settleRealizedDown = 0;
        finalizeSettledPosition(state, pos, 'empty shell · never filled', {
          source: 'empty-shell',
          recovered: true,
        });
        addLog(
          state,
          `[结算恢复] ${pos.title || pos.slug} 空壳仓（未成交）已标记 settled`,
          'warning'
        );
        n += 1;
      }
    }
  }
  return n;
}

/** Apply a previously journaled settle in one synchronous block. */
function applyPendingSettle(state, pos) {
  const pending = pos._pendingSettle;
  if (!pending) return false;
  if (pending.applied) {
    if (!pos.settled) {
      // Cash/stats already moved; just clear inventory and finalize
      pos.upShares = 0;
      pos.downShares = 0;
      pos.upCost = 0;
      pos.downCost = 0;
      pos.upMark = pending.up?.price;
      pos.downMark = pending.down?.price;
      pos._settleRealizedUp = Number(pending.up?.realized) || 0;
      pos._settleRealizedDown = Number(pending.down?.realized) || 0;
      finalizeSettledPosition(state, pos, pending.reason || 'settle', {
        source: pending.source,
        recovered: true,
      });
      delete pos._pendingSettle;
    }
    return true;
  }

  const upCalc = pending.up || {};
  const downCalc = pending.down || {};
  const reason = pending.reason || 'settle';

  // Mark applied before mutating balances (crash mid-apply → finalize-only recovery)
  pending.applied = true;

  const proceeds = rnd((Number(upCalc.proceeds) || 0) + (Number(downCalc.proceeds) || 0), 4);
  const realized = rnd((Number(upCalc.realized) || 0) + (Number(downCalc.realized) || 0), 4);

  applySettleCashStats(state, proceeds, realized);

  if ((Number(upCalc.shares) || 0) > 1e-8) {
    addLog(
      state,
      `[结算清仓] ${pos.title} (Up) | ${Number(upCalc.shares).toFixed(2)} shares @ $${upCalc.price}` +
        ` → 已实现 ${upCalc.realized >= 0 ? '+' : ''}${Number(upCalc.realized).toFixed(2)} USDC (${reason})`,
      upCalc.realized >= 0 ? 'success' : 'warning'
    );
  }
  if ((Number(downCalc.shares) || 0) > 1e-8) {
    addLog(
      state,
      `[结算清仓] ${pos.title} (Down) | ${Number(downCalc.shares).toFixed(2)} shares @ $${downCalc.price}` +
        ` → 已实现 ${downCalc.realized >= 0 ? '+' : ''}${Number(downCalc.realized).toFixed(2)} USDC (${reason})`,
      downCalc.realized >= 0 ? 'success' : 'warning'
    );
  }

  pos.upShares = 0;
  pos.downShares = 0;
  pos.upCost = 0;
  pos.downCost = 0;
  pos.upMark = upCalc.price;
  pos.downMark = downCalc.price;
  pos._settleRealizedUp = Number(upCalc.realized) || 0;
  pos._settleRealizedDown = Number(downCalc.realized) || 0;

  finalizeSettledPosition(state, pos, reason, {
    source: pending.source,
    upProceeds: upCalc.proceeds,
    downProceeds: downCalc.proceeds,
  });
  delete pos._pendingSettle;
  return true;
}

/**
 * Atomic settle: journal both legs, persist, apply in one block, finalize.
 */
function settlePositionAtomic(state, pos, marks, reason) {
  const upCalc = computeLegSettle(pos, 'Up', marks.upMark);
  const downCalc = computeLegSettle(pos, 'Down', marks.downMark);

  pos.settling = true;
  pos.settleReason = reason;
  pos.upMark = upCalc.price;
  pos.downMark = downCalc.price;
  pos._pendingSettle = {
    up: upCalc,
    down: downCalc,
    reason,
    source: marks.source,
  };
  // Crash after this → recoverZombieSettlements re-applies once
  saveState(state);

  applyPendingSettle(state, pos);
  saveState(state);
  return true;
}

/** Live: after atomic ledger settle, redeem on-chain (best effort). */
async function settlePositionAtomicAndRedeem(state, pos, marks, reason) {
  settlePositionAtomic(state, pos, marks, reason);
  if (isLive() && pos.settled) {
    const { redeemSettledPosition } = require('./redeem');
    await redeemSettledPosition(state, pos);
    saveState(state);
  }
  return true;
}

async function cancelMarketOrdersAll(state, conditionId, reason) {
  // Live first: never paper-cancel live rows before exchange cancel
  if (isLive()) {
    try {
      const { cancelLiveOrdersForMarket } = require('./live_clob');
      const result = await cancelLiveOrdersForMarket(state, conditionId, reason);
      if (!result?.ok) {
        addLog(
          state,
          `[实盘撤单] ${reason}: ${result?.failed?.length || 1} 笔订单状态未确认，阻止结算`,
          'error'
        );
        return false;
      }
    } catch (err) {
      addLog(state, `[实盘撤单] ${reason}: ${err.message}`, 'warning');
      return false;
    }
  }
  cancelOrdersForMarket(state, conditionId, reason);
  return true;
}

/**
 * Resolve settle marks from Polymarket.
 * @param {{ force?: boolean }} opts  force=true: skip grace (manual 结算检查)
 */
async function resolveMarksForPosition(pos, nowSec, params, opts = {}) {
  const end = Number(pos.windowEnd) || 0;
  const force = Boolean(opts.force);
  if (!end && !force) return null;

  const officialGrace = Number(params.official_settle_grace_sec) || 300;
  const fallbackGrace = Number(params.fallback_settle_grace_sec) || 1800;
  const age = end ? nowSec - end : Number.POSITIVE_INFINITY;

  if (!force) {
    if (!end || age < officialGrace) return null;
  }

  // Official: Gamma by conditionId (preferred), then title search fallback
  let upMark = null;
  let downMark = null;
  let source = 'gamma';

  const byCid = await fetchGammaByConditionId(pos.conditionId);
  if (byCid) {
    upMark = byCid.upMark;
    downMark = byCid.downMark;
    source = byCid.source;
  } else {
    const gUp = await fetchGammaResolvedSettlePrice(pos.title, 'Up');
    const gDown = await fetchGammaResolvedSettlePrice(pos.title, 'Down');
    upMark = gUp ? gUp.price : null;
    downMark = gDown ? gDown.price : null;
    source = 'gamma-search';
  }

  // Fallback: hard extremes from last trade
  const allowFallback = force || age >= fallbackGrace;
  if (upMark == null && downMark == null && allowFallback) {
    const upPx = await getLastTradePrice(pos.upTokenId);
    const downPx = await getLastTradePrice(pos.downTokenId);
    upMark = binaryFromHardExtreme(upPx);
    downMark = binaryFromHardExtreme(downPx);
    source = 'clob-last-trade';
  }

  if (upMark == null && downMark != null) upMark = 1 - downMark;
  if (downMark == null && upMark != null) downMark = 1 - upMark;

  const inv = applyBinarySettleInvariant(upMark, downMark);
  if (!inv.ok) return null;
  return {
    upMark: inv.upMark,
    downMark: inv.downMark,
    source,
    corrected: inv.corrected,
  };
}

async function settleEndedPositions(state, nowSec = Math.floor(Date.now() / 1000)) {
  const params = loadParams();
  let n = recoverZombieSettlements(state, nowSec);

  for (const pos of Object.values(state.positions || {})) {
    const end = Number(pos.windowEnd) || 0;
    if (end && nowSec >= end) {
      const cancelled = await cancelMarketOrdersAll(state, pos.conditionId, 'window ended');
      if (!cancelled) pos.settlementCancelPending = true;
      else delete pos.settlementCancelPending;
    }
  }
  // After cancels, flat never-filled shells can finalize
  n += recoverZombieSettlements(state, nowSec);

  for (const pos of Object.values(state.positions || {})) {
    if (pos.settled) continue;
    if (!(Number(pos.upShares) > 1e-8 || Number(pos.downShares) > 1e-8)) continue;

    const marks = await resolveMarksForPosition(pos, nowSec, params);
    if (!marks) continue;

    const cancelled = await cancelMarketOrdersAll(state, pos.conditionId, 'settling');
    if (!cancelled) {
      pos.settlementCancelPending = true;
      continue;
    }
    delete pos.settlementCancelPending;
    const reason = `window ended · ${marks.source}`;
    await settlePositionAtomicAndRedeem(state, pos, marks, reason);
    n += 1;
  }
  if (n) saveState(state);
  return n;
}

/**
 * Manual「结算检查」: query Polymarket for each open position (skip grace).
 * If resolved, run the normal atomic settle flow.
 */
async function checkAndSettleOpenPositions(state, nowSec = Math.floor(Date.now() / 1000)) {
  const params = loadParams();

  // Cancel resting orders on ended windows so empty shells can finalize
  for (const pos of Object.values(state.positions || {})) {
    if (pos.settled) continue;
    const end = Number(pos.windowEnd) || 0;
    if (end && nowSec >= end) {
      const cancelled = await cancelMarketOrdersAll(state, pos.conditionId, 'settle-check');
      if (!cancelled) pos.settlementCancelPending = true;
      else delete pos.settlementCancelPending;
    }
  }

  let settled = recoverZombieSettlements(state, nowSec);
  let checked = 0;
  let unresolved = 0;
  const details = [];

  for (const pos of Object.values(state.positions || {})) {
    if (pos.settled) continue;
    if (!(Number(pos.upShares) > 1e-8 || Number(pos.downShares) > 1e-8)) continue;
    checked += 1;

    const marks = await resolveMarksForPosition(pos, nowSec, params, { force: true });
    if (!marks) {
      unresolved += 1;
      details.push({
        slug: pos.slug,
        title: pos.title,
        status: 'open',
        reason: 'Polymarket 尚未给出明确结算价',
      });
      continue;
    }

    const cancelled = await cancelMarketOrdersAll(state, pos.conditionId, 'settle-check');
    if (!cancelled) {
      pos.settlementCancelPending = true;
      unresolved += 1;
      details.push({
        slug: pos.slug,
        title: pos.title,
        status: 'open',
        reason: '交易所挂单尚未确认关闭',
      });
      continue;
    }
    delete pos.settlementCancelPending;
    const reason = `结算检查 · ${marks.source}`;
    await settlePositionAtomicAndRedeem(state, pos, marks, reason);
    settled += 1;
    details.push({
      slug: pos.slug,
      title: pos.title,
      status: 'settled',
      upMark: marks.upMark,
      downMark: marks.downMark,
      source: marks.source,
    });
  }

  if (settled) saveState(state);
  addLog(
    state,
    `[结算检查] 检查 ${checked} 个持仓 · 已结算 ${settled} · 未结算 ${unresolved}`,
    settled > 0 ? 'success' : 'info'
  );
  saveState(state);
  return { checked, settled, unresolved, details };
}

module.exports = {
  settleEndedPositions,
  checkAndSettleOpenPositions,
  settleLeg,
  settlePositionAtomic,
  settlePositionAtomicAndRedeem,
  recoverZombieSettlements,
  resolveMarksForPosition,
  binaryFromHardExtreme,
  fetchGammaResolvedSettlePrice,
  fetchGammaByConditionId,
  applyBinarySettleInvariant,
  computeLegSettle,
};
