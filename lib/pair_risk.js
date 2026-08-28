/**
 * Pure pair-risk helpers (no I/O) — safe to unit test without deps.
 */
const { loadParams } = require('./strategy');
const { rnd, estimateTakerFeeUsdc } = require('./fees');

function pairEntryMinSec(params = loadParams()) {
  const v = Number(params.pair_entry_min_sec);
  return Number.isFinite(v) && v >= 0 ? v : 60;
}

function orphanGraceSec(params = loadParams()) {
  const v = Number(params.orphan_grace_sec);
  return Number.isFinite(v) && v >= 0 ? v : 90;
}

/** Seconds before windowEnd when orphan must be hedged/unwound (no more grace). */
function orphanForceBeforeEndSec(params = loadParams()) {
  const v = Number(params.orphan_force_before_end_sec);
  return Number.isFinite(v) && v >= 0 ? v : 60;
}

/** Max seconds to wait on a resting hedge leg before force-cancel + unwind. */
function orphanHedgeRestMaxSec(params = loadParams()) {
  const v = Number(params.orphan_hedge_rest_max_sec);
  return Number.isFinite(v) && v >= 0 ? v : 90;
}

/** Absolute last seconds — dump even if hedge rest is young. */
function orphanHardForceBeforeEndSec(params = loadParams()) {
  const v = Number(params.orphan_hard_force_before_end_sec);
  return Number.isFinite(v) && v >= 0 ? v : 30;
}

/** Age (sec) of oldest open BUY on the missing side; null if none. */
function hedgeRestAgeSec(openOrders, missingSide, nowSec = Math.floor(Date.now() / 1000)) {
  const side = String(missingSide || '');
  if (!side) return null;
  const rests = (openOrders || []).filter(
    (o) =>
      o &&
      String(o.side || 'BUY').toUpperCase() === 'BUY' &&
      o.outcome === side &&
      String(o.status || 'open') !== 'filled' &&
      String(o.status || 'open') !== 'cancelled'
  );
  if (!rests.length) return null;
  let oldest = Infinity;
  for (const o of rests) {
    const t = Date.parse(o.createdAt || o.updatedAt || '') / 1000;
    if (Number.isFinite(t) && t < oldest) oldest = t;
  }
  if (!Number.isFinite(oldest) || oldest === Infinity) return 0;
  return Math.max(0, Number(nowSec) - oldest);
}

/** Block new paired entries too close to entry_end (both legs need time to fill). */
function pairEntryBlocked(t, params = loadParams(), mode = 'pair', opts = {}) {
  if (String(mode || '').toLowerCase() !== 'pair') return { blocked: false };
  const entryEnd = Number(params.entry_end_sec) || 240;
  const minLeft = pairEntryMinSec(params);
  const remaining = entryEnd - Number(t);
  if (remaining + 1e-9 < minLeft) {
    return {
      blocked: true,
      reason: `pair needs ${minLeft}s before entry end, only ${Math.max(0, Math.floor(remaining))}s left`,
      remaining,
      minLeft,
    };
  }

  // Wall-clock: need room for hedge rest + hard force before window ends
  const winStart = Number(opts.windowStart) || 0;
  const winEnd = Number(opts.windowEnd) || 0;
  const now = Number(opts.nowSec) || 0;
  const winLen = winEnd > winStart ? winEnd - winStart : 300;
  const wallLeft = winEnd > 0 && now > 0 ? winEnd - now : winLen - Number(t);
  const needWall =
    orphanHedgeRestMaxSec(params) + orphanHardForceBeforeEndSec(params) + 20;
  if (wallLeft + 1e-9 < needWall) {
    return {
      blocked: true,
      reason: `pair needs ${needWall}s before window end, only ${Math.max(0, Math.floor(wallLeft))}s left`,
      remaining: wallLeft,
      minLeft: needWall,
    };
  }

  return { blocked: false, remaining, minLeft, wallLeft, needWall };
}

/** Resting BUY on the missing leg while holding one side — do not stale-cancel. */
function isHedgeRestOrder(order, upSh, downSh) {
  if (!order || String(order.side || 'BUY').toUpperCase() !== 'BUY') return false;
  const up = Number(upSh) || 0;
  const down = Number(downSh) || 0;
  if (down > 1e-8 && up <= 1e-8 && order.outcome === 'Up') return true;
  if (up > 1e-8 && down <= 1e-8 && order.outcome === 'Down') return true;
  return false;
}

function shouldSkipStaleCancelForHedge(order, pos) {
  if (!pos || !order) return false;
  const upSh = Number(pos.upShares) || 0;
  const downSh = Number(pos.downShares) || 0;
  return isHedgeRestOrder(order, upSh, downSh);
}

/**
 * One-sided inventory → defer unwind while hedge rests or until entry_end + grace.
 * Hard stops:
 * - last orphan_force_before_end_sec of the window
 * - resting hedge older than orphan_hedge_rest_max_sec
 * (prevents riding a single leg into settlement / waiting forever on unfilled GTC).
 */
function shouldDeferOrphanUnwind({
  upSh,
  downSh,
  hasUpRest,
  hasDownRest,
  windowStart,
  windowEnd,
  nowSec,
  hedgeRestAgeSec: restAgeIn = null,
  params = loadParams(),
}) {
  const up = Number(upSh) || 0;
  const down = Number(downSh) || 0;
  const start = Number(windowStart) || 0;
  const end = Number(windowEnd) || 0;
  const now = Number(nowSec) || 0;
  const t = start ? now - start : 0;
  const entryEnd = Number(params.entry_end_sec) || 240;
  const graceEnd = entryEnd + orphanGraceSec(params);
  const forceBefore = orphanForceBeforeEndSec(params);
  const restMax = orphanHedgeRestMaxSec(params);
  const restAge = restAgeIn == null ? null : Number(restAgeIn);

  // Must act before window ends — soft then hard:
  // Soft (last forceBefore sec): still wait for resting hedge until restMax age.
  // Hard (last hardFloor sec): dump regardless of rest age.
  if (end > 0 && now >= end - forceBefore) {
    const hardFloor = Math.min(forceBefore, orphanHardForceBeforeEndSec(params));
    const inHard = now >= end - hardFloor;
    const restPending =
      (up > 1e-8 && down <= 1e-8 && hasDownRest) ||
      (down > 1e-8 && up <= 1e-8 && hasUpRest);
    if (!inHard && restPending && (!Number.isFinite(restAge) || restAge < restMax)) {
      return {
        defer: true,
        reason: hasDownRest ? 'Down hedge resting' : 'Up hedge resting',
      };
    }
    return {
      defer: false,
      force: true,
      reason: inHard ? 'hard force before window end' : 'force before window end',
    };
  }

  if (up > 1e-8 && down <= 1e-8) {
    if (hasDownRest) {
      if (Number.isFinite(restAge) && restAge >= restMax) {
        return { defer: false, force: true, reason: 'hedge rest timeout' };
      }
      return { defer: true, reason: 'Down hedge resting' };
    }
    if (t <= graceEnd) {
      return { defer: true, reason: `orphan Up grace ${Math.max(0, Math.ceil(graceEnd - t))}s` };
    }
  }
  if (down > 1e-8 && up <= 1e-8) {
    if (hasUpRest) {
      if (Number.isFinite(restAge) && restAge >= restMax) {
        return { defer: false, force: true, reason: 'hedge rest timeout' };
      }
      return { defer: true, reason: 'Up hedge resting' };
    }
    if (t <= graceEnd) {
      return { defer: true, reason: `orphan Down grace ${Math.max(0, Math.ceil(graceEnd - t))}s` };
    }
  }
  return { defer: false };
}

function orphanLossMinSec(params = loadParams()) {
  const v = Number(params.orphan_loss_min_sec);
  return Number.isFinite(v) && v >= 0 ? v : 45;
}

/** While more than this many seconds remain before windowEnd, skip loss-based dumps. */
function orphanLossHoldBeforeEndSec(params = loadParams()) {
  const v = Number(params.orphan_loss_hold_before_end_sec);
  return Number.isFinite(v) && v >= 0 ? v : 120;
}

/**
 * May mark-to-bid loss force-dump the held leg?
 * Blocked while missing-leg hedge GTC is young or window still has runway.
 */
function shouldAllowOrphanLossDump({
  lossExceeded = false,
  defer = {},
  hasMissingRest = false,
  restAge = null,
  windowEnd = 0,
  nowSec = 0,
  orphanAgeSec = null,
  params = loadParams(),
} = {}) {
  if (!lossExceeded) return { allowed: false };

  const restMax = orphanHedgeRestMaxSec(params);
  const rest = restAge == null ? null : Number(restAge);
  const end = Number(windowEnd) || 0;
  const now = Number(nowSec) || 0;
  const wallLeft = end > 0 && now > 0 ? end - now : Infinity;
  const holdBeforeEnd = orphanLossHoldBeforeEndSec(params);
  const minSec = orphanLossMinSec(params);

  if (hasMissingRest && defer?.defer) {
    return { allowed: false, reason: defer.reason || 'hedge resting' };
  }
  if (hasMissingRest && Number.isFinite(rest) && rest < restMax) {
    return { allowed: false, reason: 'hedge rest young' };
  }
  if (wallLeft > holdBeforeEnd + 1e-9) {
    return {
      allowed: false,
      reason: `window has ${Math.max(0, Math.floor(wallLeft))}s left`,
      wallLeft,
    };
  }
  if (minSec > 0 && (orphanAgeSec == null || orphanAgeSec < minSec)) {
    return {
      allowed: false,
      reason:
        orphanAgeSec == null
          ? `orphan age unknown < min ${minSec}s`
          : `orphan age ${Math.floor(orphanAgeSec)}s < min ${minSec}s`,
      orphanAgeSec,
    };
  }
  return { allowed: true };
}

/** Cancel open orders on the long side; skip when short side is flat but hedge is resting. */
function skewCancelPlan(upSh, downSh, openOrders = []) {
  const up = Number(upSh) || 0;
  const down = Number(downSh) || 0;
  const skew = Math.abs(up - down);
  const hasUpRest = openOrders.some((o) => o.outcome === 'Up');
  const hasDownRest = openOrders.some((o) => o.outcome === 'Down');
  if (!(skew > 1e-8) || !(hasUpRest || hasDownRest)) {
    return { cancel: [], skip: true, reason: 'no skew orders' };
  }

  const longSide = up > down ? 'Up' : 'Down';
  const shortSide = longSide === 'Up' ? 'Down' : 'Up';
  const shortSh = shortSide === 'Up' ? up : down;

  if (shortSh <= 1e-8 && openOrders.some((o) => o.outcome === shortSide)) {
    return { cancel: [], skip: true, reason: 'awaiting hedge fill', longSide, shortSide };
  }

  return {
    cancel: openOrders.filter((o) => o.outcome === longSide),
    skip: false,
    longSide,
    shortSide,
    skew,
  };
}

/** Can taker-buy missingSide to complete pair within pair_sum_max? */
function completePairCostOk(pos, missingSide, askPrice, params = loadParams()) {
  if (!pos || !(askPrice > 0)) return { ok: false, reason: 'invalid' };
  const upSh = Number(pos.upShares) || 0;
  const downSh = Number(pos.downShares) || 0;
  const ask = Number(askPrice);
  const maxSum = Number(params.pair_sum_max) || 0.99;
  const feeRate = Number(params.taker_fee_rate);
  const takerFeePerShare = estimateTakerFeeUsdc(
    1,
    ask,
    Number.isFinite(feeRate) && feeRate >= 0 ? feeRate : undefined
  );

  let heldAvg = null;
  if (missingSide === 'Down' && upSh > 1e-8 && downSh <= 1e-8) {
    heldAvg = (Number(pos.upCost) || 0) / upSh;
  } else if (missingSide === 'Up' && downSh > 1e-8 && upSh <= 1e-8) {
    heldAvg = (Number(pos.downCost) || 0) / downSh;
  } else {
    return { ok: false, reason: 'not orphan' };
  }

  const pairCost = rnd(heldAvg + ask + takerFeePerShare, 4);
  if (pairCost > maxSum + 1e-9) {
    return {
      ok: false,
      reason: 'pair cost too high',
      pairCost,
      maxSum,
      heldAvg,
      ask,
      takerFeePerShare,
    };
  }
  return { ok: true, pairCost, maxSum, heldAvg, ask, takerFeePerShare };
}

/** avg held leg + ask on missing leg — for taker hedge gate. */
function completePairCost(heldSide, pos, missingAskPrice) {
  if (!pos || !(Number(missingAskPrice) > 0)) return null;
  const side = String(heldSide || '');
  const heldSh = side === 'Up' ? Number(pos.upShares) || 0 : Number(pos.downShares) || 0;
  const heldCost = side === 'Up' ? Number(pos.upCost) || 0 : Number(pos.downCost) || 0;
  if (!(heldSh > 1e-8)) return null;
  return rnd(heldCost / heldSh + Number(missingAskPrice), 4);
}

function canTakerHedgePairCost(heldSide, pos, missingAskPrice, params = loadParams(), heldBidPrice = null) {
  const held = String(heldSide || '');
  if (held !== 'Up' && held !== 'Down') return { ok: false, reason: 'invalid held side' };
  const missingSide = held === 'Up' ? 'Down' : 'Up';
  const checked = completePairCostOk(pos, missingSide, missingAskPrice, params);
  const completeSum = checked.pairCost;
  if (checked.ok) {
    return { ...checked, completeSum, buffer: 0, mode: 'normal' };
  }

  const normalMax = Number(params.pair_sum_max) || 0.99;
  const configuredEmergencyMax = Number(params.emergency_pair_sum_max);
  const emergencyMax = Number.isFinite(configuredEmergencyMax)
    ? Math.max(normalMax, Math.min(0.995, configuredEmergencyMax))
    : Math.max(normalMax, 0.992);
  if (!(completeSum > normalMax) || completeSum > emergencyMax + 1e-9) {
    return { ...checked, completeSum, buffer: 0, emergencyMax, mode: 'rejected' };
  }

  const bid = Number(heldBidPrice);
  if (!(bid > 0)) {
    return {
      ...checked,
      completeSum,
      buffer: 0,
      emergencyMax,
      mode: 'rejected',
      reason: 'no held bid for emergency comparison',
    };
  }
  const heldShares = held === 'Up' ? Number(pos.upShares) || 0 : Number(pos.downShares) || 0;
  const heldCost = held === 'Up' ? Number(pos.upCost) || 0 : Number(pos.downCost) || 0;
  const heldAvg = heldShares > 1e-8 ? heldCost / heldShares : 0;
  const feeRate = Number(params.taker_fee_rate);
  const unwindFeePerShare = estimateTakerFeeUsdc(
    1,
    bid,
    Number.isFinite(feeRate) && feeRate >= 0 ? feeRate : undefined
  );
  const unwindLossPerShare = rnd(Math.max(0, heldAvg - (bid - unwindFeePerShare)), 6);
  // Emergency cost is measured as the edge sacrificed beyond the normal target.
  const emergencyPenaltyPerShare = rnd(Math.max(0, completeSum - normalMax), 6);
  const cheaperThanUnwind = emergencyPenaltyPerShare + 1e-9 < unwindLossPerShare;
  return {
    ...checked,
    completeSum,
    buffer: 0,
    emergencyMax,
    heldBid: bid,
    unwindFeePerShare,
    unwindLossPerShare,
    emergencyPenaltyPerShare,
    mode: cheaperThanUnwind ? 'emergency' : 'rejected',
    ok: cheaperThanUnwind,
    reason: cheaperThanUnwind ? null : 'emergency hedge not cheaper than unwind',
  };
}

function detectPairExposure(upSh, downSh, hasUpRest, hasDownRest) {
  const hasUp = (Number(upSh) || 0) > 1e-8 || Boolean(hasUpRest);
  const hasDown = (Number(downSh) || 0) > 1e-8 || Boolean(hasDownRest);
  if (!hasUp && !hasDown) return { kind: 'empty', missingSide: null };
  if (hasUp && !hasDown) return { kind: 'one_sided', missingSide: 'Down' };
  if (hasDown && !hasUp) return { kind: 'one_sided', missingSide: 'Up' };
  return { kind: 'both_sides', missingSide: null };
}

function pairCostFeeBuffer(params = loadParams()) {
  const feeBuf = Number(params.pair_hedge_fee_buffer);
  return Number.isFinite(feeBuf) && feeBuf >= 0 ? feeBuf : 0;
}

function pairedPositionCost(upSh, downSh, upCost, downCost) {
  const u = Number(upSh) || 0;
  const d = Number(downSh) || 0;
  if (u < 1e-8 || d < 1e-8) return null;
  return rnd((Number(upCost) || 0) / u + (Number(downCost) || 0) / d, 4);
}

/** Weighted pair cost after buying shares on one or both legs. */
function projectedPairedPositionCost(
  position,
  { upAdd = 0, downAdd = 0, upPrice = 0, downPrice = 0 } = {}
) {
  if (!position) return null;
  const upSh = Number(position.upShares) || 0;
  const downSh = Number(position.downShares) || 0;
  const upAddN = Math.max(0, Number(upAdd) || 0);
  const downAddN = Math.max(0, Number(downAdd) || 0);
  const newUpSh = upSh + upAddN;
  const newDownSh = downSh + downAddN;
  const newUpCost = (Number(position.upCost) || 0) + upAddN * Number(upPrice);
  const newDownCost = (Number(position.downCost) || 0) + downAddN * Number(downPrice);
  return pairedPositionCost(newUpSh, newDownSh, newUpCost, newDownCost);
}

function projectedPairCostOk(position, projection, params = loadParams()) {
  const pairCost = projectedPairedPositionCost(position, projection);
  if (pairCost == null) return { ok: true };
  const maxSum = Number(params.pair_sum_max) || 0.99;
  const feeBuf = pairCostFeeBuffer(params);
  if (pairCost <= maxSum + feeBuf + 1e-9) {
    return { ok: true, pairCost, maxSum, buffer: feeBuf };
  }
  return {
    ok: false,
    pairCost,
    maxSum,
    buffer: feeBuf,
    reason: 'projected pair cost too high',
  };
}

/** Pair-cost if a resting/pending leg fills at fillPrice. */
function projectedPairCostOnLegFill(position, side, fillShares, fillPrice, params = loadParams()) {
  if (!position || !(Number(fillShares) > 0) || !(Number(fillPrice) > 0)) {
    return { ok: true };
  }
  const projection =
    side === 'Up'
      ? { upAdd: fillShares, upPrice: fillPrice }
      : { downAdd: fillShares, downPrice: fillPrice };
  return projectedPairCostOk(position, projection, params);
}

function validatePairedPositionCost(state, market, params = loadParams()) {
  const pos = state.positions[market.conditionId];
  if (!pos) return { ok: true };
  const upSh = Number(pos.upShares) || 0;
  const downSh = Number(pos.downShares) || 0;
  if (upSh < 1e-8 || downSh < 1e-8) return { ok: true };

  const maxSum = Number(params.pair_sum_max) || 0.99;
  const feeBuf = pairCostFeeBuffer(params);
  const pairCost = pairedPositionCost(upSh, downSh, pos.upCost, pos.downCost);

  if (pairCost <= maxSum + feeBuf + 1e-9) {
    return { ok: true, pairCost, maxSum };
  }

  return {
    ok: false,
    pairCost,
    maxSum,
    reason: 'pair cost exceeds threshold',
  };
}

function setPairRiskLock(pos, reason) {
  if (!pos) return;
  pos.riskLock = { reason: String(reason || 'risk'), at: new Date().toISOString() };
}

function clearPairRiskLock(pos) {
  if (!pos) return;
  delete pos.riskLock;
}

function resolvePositionContext({ position, openOrders = [], market, state = null } = {}) {
  const pos = position || (market?.conditionId && state?.positions?.[market.conditionId]) || null;
  if (!pos) return null;
  const orders = openOrders.length
    ? openOrders
    : (state?.open_orders || []).filter(
        (o) => o.status === 'open' && o.conditionId === (market?.conditionId || pos.conditionId)
      );
  const upSh = Number(pos.upShares) || 0;
  const downSh = Number(pos.downShares) || 0;
  const hasUpRest = orders.some((o) => o.outcome === 'Up');
  const hasDownRest = orders.some((o) => o.outcome === 'Down');
  return { pos, upSh, downSh, hasUpRest, hasDownRest, orders };
}

/** Block new orders while unwind / risk lock is active. */
function unwindBlocked(position) {
  if (!position) return { blocked: false };
  if (position.riskLock?.reason) {
    return { blocked: true, reason: `risk lock: ${position.riskLock.reason}`, lock: position.riskLock };
  }
  const inflight = String(position.pairInflight?.reason || '');
  if (/unwind/i.test(inflight)) {
    return { blocked: true, reason: `unwind in progress: ${inflight}`, inflight: position.pairInflight };
  }
  return { blocked: false };
}

/** Would fixing imbalance push paired rounds above max_pair_rounds_per_window? */
function rebalanceWouldExceedRounds(position, side, shares, params = loadParams()) {
  if (!position) return { blocked: false };
  const upSh = Number(position.upShares) || 0;
  const downSh = Number(position.downShares) || 0;
  const add = Math.max(0, Number(shares) || 0);
  const newUp = side === 'Up' ? upSh + add : upSh;
  const newDown = side === 'Down' ? downSh + add : downSh;
  return pairRoundsBlocked(newUp, newDown, params);
}

/** Gate rebalance BUY: unwind lock, pair rounds, projected pair cost. */
function rebalanceRiskGate({
  position,
  openOrders = [],
  market,
  state = null,
  params = loadParams(),
  side,
  shares,
  price,
} = {}) {
  const ctx = resolvePositionContext({ position, openOrders, market, state });
  if (!ctx) return { blocked: false };

  const { pos } = ctx;
  const unw = unwindBlocked(pos);
  if (unw.blocked) return unw;

  const buyGate = buyRiskGate({ position: pos, openOrders, market, state, params });
  if (buyGate.blocked) return buyGate;

  const inflight = pairInflightBlocked(pos);
  if (inflight.blocked) return inflight;

  const roundsGate = rebalanceWouldExceedRounds(pos, side, shares, params);
  if (roundsGate.blocked) return roundsGate;

  const addN = Number(shares);
  const px = Number(price);
  if (addN > 0 && px > 0) {
    const projection =
      side === 'Up'
        ? { upAdd: addN, upPrice: px }
        : { downAdd: addN, downPrice: px };
    const projected = projectedPairCostOk(pos, projection, params);
    if (!projected.ok) {
      return {
        blocked: true,
        reason: `rebalance projected pairCost ${Number(projected.pairCost).toFixed(4)} > max ${projected.maxSum}`,
        projected,
      };
    }
  }

  return { blocked: false };
}

/** Block any new BUY when risk lock or pair cost already blown (pair + rebalance). */
function buyRiskGate({
  position,
  openOrders = [],
  market,
  state = null,
  params = loadParams(),
} = {}) {
  const ctx = resolvePositionContext({ position, openOrders, market, state });
  if (!ctx) return { blocked: false };

  const { pos, upSh, downSh } = ctx;
  const unw = unwindBlocked(pos);
  if (unw.blocked) return unw;

  if (upSh > 1e-8 && downSh > 1e-8 && market?.conditionId) {
    const stubState = state || { positions: { [market.conditionId]: pos } };
    const cost = validatePairedPositionCost(stubState, market, params);
    if (!cost.ok) {
      return {
        blocked: true,
        reason: `pair cost ${Number(cost.pairCost).toFixed(4)} > max ${cost.maxSum}`,
        cost,
      };
    }
  }

  return { blocked: false };
}

function maxPairRoundsPerWindow(params = loadParams()) {
  const v = Number(params.max_pair_rounds_per_window);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

function pairExtremeBounds(params = loadParams()) {
  const minPx = Number(params.pair_extreme_min);
  const maxPx = Number(params.pair_extreme_max);
  return {
    min: Number.isFinite(minPx) ? minPx : 0.25,
    max: Number.isFinite(maxPx) ? maxPx : 0.75,
  };
}

function maxLegRatio(params = loadParams()) {
  const v = Number(params.pair_max_leg_ratio);
  return Number.isFinite(v) && v >= 1 ? v : 2.0;
}

/** Block pair entry on lottery / one-sided books (e.g. 12¢ + 87¢). */
function extremeQuoteBlocked(upPrice, downPrice, params = loadParams()) {
  const up = Number(upPrice);
  const down = Number(downPrice);
  if (!(up > 0) || !(down > 0)) return { blocked: false };
  const { min, max } = pairExtremeBounds(params);
  const lo = Math.min(up, down);
  const hi = Math.max(up, down);
  if (lo + 1e-12 < min) {
    return { blocked: true, reason: `extreme quote min=${lo.toFixed(2)} < ${min}`, lo, hi, min, max };
  }
  if (hi > max + 1e-12) {
    return { blocked: true, reason: `extreme quote max=${hi.toFixed(2)} > ${max}`, lo, hi, min, max };
  }
  return { blocked: false, lo, hi, min, max };
}

/** Block asymmetric books like 28¢+71¢ even if within absolute extreme bounds. */
function legRatioBlocked(upPrice, downPrice, params = loadParams()) {
  const up = Number(upPrice);
  const down = Number(downPrice);
  if (!(up > 0) || !(down > 0)) return { blocked: false };
  const maxRatio = maxLegRatio(params);
  const lo = Math.min(up, down);
  const hi = Math.max(up, down);
  const ratio = hi / lo;
  if (ratio > maxRatio + 1e-12) {
    return {
      blocked: true,
      reason: `leg ratio ${ratio.toFixed(2)} > max ${maxRatio}`,
      ratio,
      maxRatio,
      lo,
      hi,
    };
  }
  return { blocked: false, ratio, maxRatio, lo, hi };
}

function setPairInflight(pos, reason = 'pair posting') {
  if (!pos) return;
  pos.pairInflight = { reason: String(reason || 'pair'), at: new Date().toISOString() };
}

function clearPairInflight(pos) {
  if (!pos) return;
  delete pos.pairInflight;
}

function pairInflightBlocked(position) {
  if (!position?.pairInflight) return { blocked: false };
  return {
    blocked: true,
    reason: `pair inflight: ${position.pairInflight.reason || 'pending'}`,
    inflight: position.pairInflight,
  };
}

/** Clear inflight once flat or both legs filled with no open BUYs. */
function maybeClearPairInflight(pos, openOrders = []) {
  if (!pos?.pairInflight) return false;
  const upSh = Number(pos.upShares) || 0;
  const downSh = Number(pos.downShares) || 0;
  const openBuys = (openOrders || []).filter(
    (o) => o.status === 'open' && String(o.side || 'BUY').toUpperCase() === 'BUY'
  );
  if (upSh <= 1e-8 && downSh <= 1e-8 && openBuys.length === 0) {
    clearPairInflight(pos);
    return true;
  }
  if (upSh > 1e-8 && downSh > 1e-8 && Math.abs(upSh - downSh) <= 1e-8 && openBuys.length === 0) {
    clearPairInflight(pos);
    return true;
  }
  return false;
}

/** Completed pair rounds = floor(min shares / chunk). */
function completedPairRounds(upSh, downSh, params = loadParams()) {
  const chunk = Math.max(Number(params.share_chunk) || 5, Number(params.min_order_shares) || 5, 1);
  const paired = Math.min(Number(upSh) || 0, Number(downSh) || 0);
  return Math.floor(paired / chunk);
}

function pairRoundsBlocked(upSh, downSh, params = loadParams()) {
  const rounds = completedPairRounds(upSh, downSh, params);
  const maxRounds = maxPairRoundsPerWindow(params);
  if (rounds >= maxRounds) {
    return {
      blocked: true,
      reason: `pair rounds ${rounds} >= max ${maxRounds}`,
      rounds,
      maxRounds,
    };
  }
  return { blocked: false, rounds, maxRounds };
}

/** Block new paired entries when inventory is one-sided, cost-blown, or unwind failed. */
function pairEntryRiskGate({
  position,
  openOrders = [],
  market,
  state = null,
  params = loadParams(),
  mode = 'pair',
  addShares = 0,
  upPrice = 0,
  downPrice = 0,
} = {}) {
  if (String(mode || '').toLowerCase() !== 'pair') return { blocked: false };

  const extreme = extremeQuoteBlocked(upPrice, downPrice, params);
  if (extreme.blocked) return extreme;

  const ratioGate = legRatioBlocked(upPrice, downPrice, params);
  if (ratioGate.blocked) return ratioGate;

  const inflight = pairInflightBlocked(position);
  if (inflight.blocked) return inflight;

  const buyGate = buyRiskGate({ position, openOrders, market, state, params });
  if (buyGate.blocked) return buyGate;

  const ctx = resolvePositionContext({ position, openOrders, market, state });
  if (!ctx) {
    // No position yet: still block if any open BUY already posted for this market
    const orders = openOrders.length
      ? openOrders
      : (state?.open_orders || []).filter(
          (o) => o.status === 'open' && o.conditionId === market?.conditionId
        );
    const openBuys = orders.filter((o) => String(o.side || 'BUY').toUpperCase() === 'BUY');
    if (openBuys.length > 0) {
      return {
        blocked: true,
        reason: `open orders resting (${openBuys.length})`,
        openCount: openBuys.length,
      };
    }
    return { blocked: false };
  }

  const { pos, upSh, downSh, hasUpRest, hasDownRest, orders } = ctx;
  const inflightPos = pairInflightBlocked(pos);
  if (inflightPos.blocked) return inflightPos;

  const exp = detectPairExposure(upSh, downSh, hasUpRest, hasDownRest);

  if (exp.kind === 'one_sided') {
    return {
      blocked: true,
      reason: `one-sided · missing ${exp.missingSide}`,
      exposure: exp,
    };
  }

  const skew = Math.abs(upSh - downSh);
  if (skew > 1e-8) {
    return {
      blocked: true,
      reason: `unbalanced Up=${rnd(upSh, 2)} Down=${rnd(downSh, 2)}`,
      skew,
    };
  }

  const openBuys = orders.filter((o) => String(o.side || 'BUY').toUpperCase() === 'BUY');
  if (openBuys.length > 0) {
    return {
      blocked: true,
      reason: `open orders resting (${openBuys.length})`,
      openCount: openBuys.length,
    };
  }

  const roundsGate = pairRoundsBlocked(upSh, downSh, params);
  if (roundsGate.blocked) return roundsGate;

  const addN = Number(addShares);
  const upPx = Number(upPrice);
  const downPx = Number(downPrice);
  if (upSh > 1e-8 && downSh > 1e-8 && addN > 0 && upPx > 0 && downPx > 0) {
    const projected = projectedPairCostOk(
      pos,
      { upAdd: addN, downAdd: addN, upPrice: upPx, downPrice: downPx },
      params
    );
    if (!projected.ok) {
      return {
        blocked: true,
        reason: `projected pairCost ${Number(projected.pairCost).toFixed(4)} > max ${projected.maxSum}`,
        projected,
      };
    }
  }

  return { blocked: false };
}

module.exports = {
  detectPairExposure,
  validatePairedPositionCost,
  pairEntryMinSec,
  orphanGraceSec,
  orphanForceBeforeEndSec,
  orphanHedgeRestMaxSec,
  orphanHardForceBeforeEndSec,
  hedgeRestAgeSec,
  pairEntryBlocked,
  extremeQuoteBlocked,
  legRatioBlocked,
  maxLegRatio,
  completedPairRounds,
  pairRoundsBlocked,
  maxPairRoundsPerWindow,
  pairExtremeBounds,
  isHedgeRestOrder,
  shouldSkipStaleCancelForHedge,
  shouldDeferOrphanUnwind,
  orphanLossMinSec,
  orphanLossHoldBeforeEndSec,
  shouldAllowOrphanLossDump,
  skewCancelPlan,
  completePairCostOk,
  canTakerHedgePairCost,
  pairCostFeeBuffer,
  pairedPositionCost,
  projectedPairedPositionCost,
  projectedPairCostOk,
  projectedPairCostOnLegFill,
  setPairRiskLock,
  clearPairRiskLock,
  setPairInflight,
  clearPairInflight,
  pairInflightBlocked,
  maybeClearPairInflight,
  buyRiskGate,
  pairEntryRiskGate,
  unwindBlocked,
  rebalanceWouldExceedRounds,
  rebalanceRiskGate,
};
