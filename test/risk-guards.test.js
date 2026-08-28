#!/usr/bin/env node
/**
 * Lightweight smoke tests for pair-risk helpers (no test framework).
 * Run: npm test
 */
const {
  validatePairedPositionCost,
  detectPairExposure,
  completePairCostOk,
  canTakerHedgePairCost,
  pairEntryBlocked,
  projectedPairCostOk,
  projectedPairCostOnLegFill,
  pairEntryRiskGate,
  extremeQuoteBlocked,
  legRatioBlocked,
  pairRoundsBlocked,
  completedPairRounds,
  pairInflightBlocked,
  setPairInflight,
  clearPairInflight,
  unwindBlocked,
  rebalanceWouldExceedRounds,
  rebalanceRiskGate,
} = require('../lib/pair_risk');
const { loadParams } = require('../lib/strategy');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  ok: ${msg}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${msg}`);
  }
}

function testValidatePairedPositionCost() {
  console.log('validatePairedPositionCost');
  const params = loadParams();
  const maxSum = Number(params.pair_sum_max) || 0.99;

  const stateOk = {
    positions: {
      cid1: { upShares: 5, downShares: 5, upCost: 2.4, downCost: 2.45 },
    },
  };
  const ok = validatePairedPositionCost(stateOk, { conditionId: 'cid1' }, params);
  assert(ok.ok === true, 'balanced pair under max');

  const stateBad = {
    positions: {
      cid2: { upShares: 5, downShares: 5, upCost: 2.8, downCost: 2.8 },
    },
  };
  const bad = validatePairedPositionCost(stateBad, { conditionId: 'cid2' }, params);
  assert(bad.ok === false, `high pair cost rejected (> ${maxSum})`);

  const stateSingle = {
    positions: {
      cid3: { upShares: 5, downShares: 0, upCost: 2.5, downCost: 0 },
    },
  };
  const single = validatePairedPositionCost(stateSingle, { conditionId: 'cid3' }, params);
  assert(single.ok === true, 'single leg skips cost check');
}

function testPairExposureDetection() {
  console.log('detectPairExposure');
  assert(detectPairExposure(5, 0, false, false).missingSide === 'Down', 'filled up only');
  assert(detectPairExposure(0, 5, false, true).missingSide === 'Up', 'down rest only');
  assert(detectPairExposure(5, 5, false, false).kind === 'both_sides', 'both filled');
  assert(detectPairExposure(0, 0, false, false).kind === 'empty', 'flat');
}

function testSettleInvariant() {
  console.log('applyBinarySettleInvariant (inline)');
  function applyBinarySettleInvariant(upMark, downMark) {
    let u = upMark;
    let d = downMark;
    if (u === 1 && d === 1) d = 0;
    if (u === 0 && d === 0) return { ok: false, upMark: u, downMark: d };
    if (u == null && d === 1) u = 0;
    if (d == null && u === 1) d = 0;
    if (u == null && d === 0) u = 1;
    if (d == null && u === 0) d = 1;
    return { ok: u != null && d != null, upMark: u, downMark: d };
  }
  const a = applyBinarySettleInvariant(1, 0);
  assert(a.ok && a.upMark === 1 && a.downMark === 0, 'up wins');
  const b = applyBinarySettleInvariant(0, 0);
  assert(b.ok === false, 'both zero refused');
}

function testBuildRiskSummary() {
  console.log('buildRiskSummary');
  const { buildRiskSummary } = require('../lib/risk_status');
  const okState = {
    cash_usdc: 50,
    reserved_usdc: 0,
    clob_cash_usdc: 50,
    stats: {},
    positions: {
      cid: {
        settled: false,
        conditionId: 'cid',
        slug: 'btc-test',
        title: 'BTC test',
        upShares: 5,
        downShares: 5,
        upCost: 2.4,
        downCost: 2.45,
      },
    },
    open_orders: [],
  };
  const ok = buildRiskSummary(okState, { apiAuthRequired: true, bindHost: '127.0.0.1' });
  assert(ok.ok === true, 'balanced portfolio is ok');
  assert(ok.api_auth_required === true, 'api auth flag');

  const badState = {
    ...okState,
    positions: {
      cid: {
        settled: false,
        conditionId: 'cid',
        slug: 'btc-test',
        title: 'BTC test',
        upShares: 5,
        downShares: 0,
        upCost: 2.5,
        downCost: 0,
      },
    },
  };
  const bad = buildRiskSummary(badState);
  assert(bad.ok === false, 'one-sided exposure flagged');
  assert(bad.one_sided.length === 1, 'one sided row');
}

function testCompletePairCostOk() {
  console.log('completePairCostOk');
  const params = loadParams();
  const pos = { upShares: 5, downShares: 0, upCost: 3.5, downCost: 0 };
  const ok = completePairCostOk(pos, 'Down', 0.26, params);
  assert(ok.ok === true, 'orphan up + cheap down ask ok');
  const feeEdge = completePairCostOk(pos, 'Down', 0.28, params);
  assert(feeEdge.ok === false, 'taker fee is included in strict pair cap');
  const bad = completePairCostOk(pos, 'Down', 0.5, params);
  assert(bad.ok === false, 'expensive down ask rejected');
}

function testCanTakerHedgePairCost() {
  console.log('canTakerHedgePairCost');
  const params = {
    pair_sum_max: 0.985,
    emergency_pair_sum_max: 0.992,
    pair_hedge_fee_buffer: 0.015,
    taker_fee_rate: 0.07,
  };
  const pos = { upShares: 5, downShares: 0, upCost: 2.35, downCost: 0 };
  const ok = canTakerHedgePairCost('Up', pos, 0.49, params);
  assert(ok.ok === true, 'held avg + ask + taker fee within strict max');
  const edge = canTakerHedgePairCost('Up', pos, 0.53, params);
  assert(edge.ok === false, 'configured buffer cannot expand strict pair max');
  const emergencyPos = { upShares: 5, downShares: 0, upCost: 2.5, downCost: 0 };
  const emergency = canTakerHedgePairCost('Up', emergencyPos, 0.47, params, 0.45);
  assert(emergency.ok === true && emergency.mode === 'emergency', 'emergency hedge allowed when cheaper than unwind');
  const costlyEmergency = canTakerHedgePairCost('Up', emergencyPos, 0.47, params, 0.55);
  assert(costlyEmergency.ok === false, 'emergency hedge rejected when unwind is cheaper');
  const bad = canTakerHedgePairCost('Up', pos, 0.60, params);
  assert(bad.ok === false, 'rejects far over strict max');
}

function testPairEntryBlocked() {
  console.log('pairEntryBlocked');
  const params = { ...loadParams(), entry_end_sec: 240, pair_entry_min_sec: 60 };
  assert(pairEntryBlocked(223, params, 'pair').blocked === true, 'late pair blocked');
  assert(pairEntryBlocked(170, params, 'pair').blocked === false, 'early pair allowed');
  const wall = pairEntryBlocked(
    100,
    { ...params, orphan_hedge_rest_max_sec: 35, orphan_hard_force_before_end_sec: 30 },
    'pair',
    { windowStart: 0, windowEnd: 300, nowSec: 250 }
  );
  assert(wall.blocked === true, 'wall-clock late blocked');
}

function testProjectedPairCost() {
  console.log('projectedPairCostOk');
  const params = loadParams();
  const posBalanced = {
    upShares: 10,
    downShares: 10,
    upCost: 6.5,
    downCost: 3.4,
  };
  const ok = projectedPairCostOk(
    posBalanced,
    { upAdd: 5, downAdd: 5, upPrice: 0.48, downPrice: 0.48 },
    params
  );
  assert(ok.ok === true, 'balanced add under pair_sum_max projected ok');

  const posSkewed = {
    upShares: 10,
    downShares: 5,
    upCost: 6.5,
    downCost: 1.75,
  };
  const bad = projectedPairCostOk(
    posSkewed,
    { upAdd: 0, downAdd: 5, upPrice: 0, downPrice: 0.42 },
    params
  );
  assert(bad.ok === false, 'skewed down fill projected over max');

  const leg = projectedPairCostOnLegFill(posSkewed, 'Down', 5, 0.42, params);
  assert(leg.ok === false, 'skew fill at 0.42 projected over max');
}

function testPairEntryRiskGateProjected() {
  console.log('pairEntryRiskGate projected');
  const params = loadParams();
  const position = {
    upShares: 8,
    downShares: 8,
    upCost: 5.12,
    downCost: 2.8,
    conditionId: 'cid',
  };
  const blocked = pairEntryRiskGate({
    position,
    market: { conditionId: 'cid' },
    params,
    mode: 'pair',
    addShares: 5,
    upPrice: 0.66,
    downPrice: 0.42,
  });
  assert(blocked.blocked === true, 'pair entry blocked when projected cost too high');
}

function testExtremeQuoteBlocked() {
  console.log('extremeQuoteBlocked');
  const params = loadParams();
  const bad = extremeQuoteBlocked(0.12, 0.87, params);
  assert(bad.blocked === true, '12c+87c blocked');
  const asym = extremeQuoteBlocked(0.20, 0.78, params);
  assert(asym.blocked === true, '20c+78c blocked by extreme band');
  const ok = extremeQuoteBlocked(0.45, 0.54, params);
  assert(ok.blocked === false, 'mid quotes allowed');
  // 28+71 passes absolute band but leg-ratio gate catches it
  const gate = pairEntryRiskGate({
    position: null,
    market: { conditionId: 'cid' },
    params,
    mode: 'pair',
    addShares: 5,
    upPrice: 0.28,
    downPrice: 0.71,
  });
  assert(gate.blocked === true, '28c+71c blocked by leg ratio gate');
}

function testLegRatioBlocked() {
  console.log('legRatioBlocked');
  const params = { ...loadParams(), pair_max_leg_ratio: 2.0 };
  const bad = legRatioBlocked(0.28, 0.71, params);
  assert(bad.blocked === true, '28/71 ratio blocked');
  const ok = legRatioBlocked(0.40, 0.58, params);
  assert(ok.blocked === false, '40/58 ratio allowed');
}

function testPairRoundsBlocked() {
  console.log('pairRoundsBlocked');
  const params = { ...loadParams(), share_chunk: 5, min_order_shares: 5, max_pair_rounds_per_window: 1 };
  assert(pairRoundsBlocked(0, 0, params).blocked === false, '0 rounds ok');
  assert(pairRoundsBlocked(5, 5, params).blocked === true, '1 round blocked when max=1');
  assert(completedPairRounds(10, 10, params) === 2, 'completed rounds count');
}

function testPairEntryOpenOrders() {
  console.log('pairEntryRiskGate open orders');
  const params = loadParams();
  const blocked = pairEntryRiskGate({
    position: { upShares: 5, downShares: 5, upCost: 2.5, downCost: 2.45, conditionId: 'cid' },
    openOrders: [{ status: 'open', side: 'BUY', outcome: 'Up', conditionId: 'cid' }],
    market: { conditionId: 'cid' },
    params,
    mode: 'pair',
    addShares: 5,
    upPrice: 0.5,
    downPrice: 0.49,
  });
  assert(blocked.blocked === true, 'open orders block new pair');
}

function testPairInflight() {
  console.log('pairInflight');
  const pos = { upShares: 0, downShares: 0, conditionId: 'cid' };
  setPairInflight(pos, 'pair posting');
  assert(pairInflightBlocked(pos).blocked === true, 'inflight blocks');
  const gated = pairEntryRiskGate({
    position: pos,
    market: { conditionId: 'cid' },
    params: loadParams(),
    mode: 'pair',
    addShares: 5,
    upPrice: 0.48,
    downPrice: 0.50,
  });
  assert(gated.blocked === true, 'pair entry blocked while inflight');
  clearPairInflight(pos);
  assert(pairInflightBlocked(pos).blocked === false, 'cleared inflight');
}

function testUnwindBlocked() {
  console.log('unwindBlocked');
  assert(unwindBlocked(null).blocked === false, 'no position ok');
  const locked = { riskLock: { reason: 'pair cost too high' } };
  assert(unwindBlocked(locked).blocked === true, 'risk lock blocks');
  const unwinding = { pairInflight: { reason: 'unwind pending' } };
  assert(unwindBlocked(unwinding).blocked === true, 'unwind inflight blocks');
}

function testRebalanceRiskGate() {
  console.log('rebalanceRiskGate');
  const params = { ...loadParams(), share_chunk: 5, min_order_shares: 5, max_pair_rounds_per_window: 1 };
  const pos = {
    conditionId: 'cid',
    upShares: 10,
    downShares: 5,
    upCost: 5,
    downCost: 2.5,
  };
  const blocked = rebalanceRiskGate({
    position: pos,
    market: { conditionId: 'cid' },
    params,
    side: 'Down',
    shares: 5,
    price: 0.49,
  });
  assert(blocked.blocked === true, 'rebalance blocked when rounds would exceed max');

  const params2 = { ...params, max_pair_rounds_per_window: 2 };
  const ok = rebalanceRiskGate({
    position: { conditionId: 'cid', upShares: 5, downShares: 0, upCost: 2.5, downCost: 0 },
    market: { conditionId: 'cid' },
    params: params2,
    side: 'Down',
    shares: 5,
    price: 0.48,
  });
  assert(ok.blocked === false, 'first rebalance leg allowed when rounds headroom');
}

function testOrphanForceBeforeWindowEnd() {
  console.log('shouldDeferOrphanUnwind window force');
  const { shouldDeferOrphanUnwind, hedgeRestAgeSec } = require('../lib/pair_risk');
  const start = 1_000_000;
  const end = start + 300; // 5m window
  const params = {
    entry_end_sec: 240,
    orphan_grace_sec: 90,
    orphan_force_before_end_sec: 90,
    orphan_hard_force_before_end_sec: 30,
    orphan_hedge_rest_max_sec: 35,
  };

  const mid = shouldDeferOrphanUnwind({
    upSh: 0,
    downSh: 5,
    hasUpRest: false,
    hasDownRest: false,
    windowStart: start,
    windowEnd: end,
    nowSec: start + 100,
    params,
  });
  assert(mid.defer === true, 'mid-window still defers');

  const rest = shouldDeferOrphanUnwind({
    upSh: 0,
    downSh: 5,
    hasUpRest: true,
    hasDownRest: false,
    windowStart: start,
    windowEnd: end,
    nowSec: start + 100,
    hedgeRestAgeSec: 30,
    params,
  });
  assert(rest.defer === true, 'hedge rest defers mid-window');

  const restTimeout = shouldDeferOrphanUnwind({
    upSh: 0,
    downSh: 5,
    hasUpRest: true,
    hasDownRest: false,
    windowStart: start,
    windowEnd: end,
    nowSec: start + 100,
    hedgeRestAgeSec: 35,
    params,
  });
  assert(restTimeout.defer === false, 'hedge rest timeout no defer');
  assert(restTimeout.force === true, 'hedge rest timeout force');
  assert(restTimeout.reason === 'hedge rest timeout', 'hedge rest timeout reason');

  // Soft force zone (90s left) + young hedge rest → still defer
  const softForceYoung = shouldDeferOrphanUnwind({
    upSh: 0,
    downSh: 5,
    hasUpRest: true,
    hasDownRest: false,
    windowStart: start,
    windowEnd: end,
    nowSec: end - 80,
    hedgeRestAgeSec: 20,
    params,
  });
  assert(softForceYoung.defer === true, 'soft force keeps young hedge rest');

  // Soft force + rest aged out → force
  const softForceAged = shouldDeferOrphanUnwind({
    upSh: 0,
    downSh: 5,
    hasUpRest: true,
    hasDownRest: false,
    windowStart: start,
    windowEnd: end,
    nowSec: end - 80,
    hedgeRestAgeSec: 35,
    params,
  });
  assert(softForceAged.defer === false, 'soft force + aged rest forces');
  assert(softForceAged.force === true, 'soft force + aged rest force flag');

  // Hard floor (30s) dumps even young rest
  const hardFloor = shouldDeferOrphanUnwind({
    upSh: 0,
    downSh: 5,
    hasUpRest: true,
    hasDownRest: false,
    windowStart: start,
    windowEnd: end,
    nowSec: end - 20,
    hedgeRestAgeSec: 10,
    params,
  });
  assert(hardFloor.defer === false, 'hard floor no defer');
  assert(hardFloor.force === true, 'hard floor force');

  const late = shouldDeferOrphanUnwind({
    upSh: 0,
    downSh: 5,
    hasUpRest: true,
    hasDownRest: false,
    windowStart: start,
    windowEnd: end,
    nowSec: end - 50,
    hedgeRestAgeSec: 10,
    params,
  });
  // 50s left is soft zone with young rest → still defer (not hard 30)
  assert(late.defer === true, '50s left soft zone defers young rest');

  // Old bug: graceEnd=330 > window 300 — force must win when no rest
  const pastEntryGrace = shouldDeferOrphanUnwind({
    upSh: 0,
    downSh: 5,
    hasUpRest: false,
    hasDownRest: false,
    windowStart: start,
    windowEnd: end,
    nowSec: start + 220,
    params,
  });
  assert(pastEntryGrace.defer === false, 't=220 within force window (90s before end)');
  assert(pastEntryGrace.force === true, 't=220 force flag');

  const age = hedgeRestAgeSec(
    [{ side: 'BUY', outcome: 'Up', status: 'open', createdAt: new Date((start + 10) * 1000).toISOString() }],
    'Up',
    start + 100
  );
  assert(age === 90, `hedgeRestAgeSec got ${age}`);
}

function testEmptyShellRecovery() {
  console.log('emptyShellRecovery');
  const { recoverZombieSettlements } = require('../lib/settle');
  const state = {
    positions: {
      ghost: {
        conditionId: 'ghost',
        slug: 'btc-updown-5m-ghost',
        title: 'Ghost pair',
        windowEnd: Math.floor(Date.now() / 1000) - 200,
        upShares: 0,
        downShares: 0,
        upCost: 0,
        downCost: 0,
        investedUsdc: 0,
        settled: false,
        realizedPnl: 0,
        pairInflight: { reason: 'pair posting', at: new Date().toISOString() },
      },
      active: {
        conditionId: 'active',
        slug: 'btc-updown-5m-active',
        title: 'Still open window',
        windowEnd: Math.floor(Date.now() / 1000) + 300,
        upShares: 0,
        downShares: 0,
        upCost: 0,
        downCost: 0,
        investedUsdc: 0,
        settled: false,
        pairInflight: { reason: 'pair posting', at: new Date().toISOString() },
      },
    },
    open_orders: [],
    stats: { settled_markets: 0 },
    logs: [],
  };
  const n = recoverZombieSettlements(state);
  assert(n === 1, 'recovers one ended empty shell');
  assert(state.positions.ghost.settled === true, 'ghost marked settled');
  assert(!state.positions.ghost.pairInflight, 'ghost inflight cleared');
  assert(state.positions.active.settled === false, 'active window shell kept open');
}

console.log('risk-guards.test.js\n');
testValidatePairedPositionCost();
testPairExposureDetection();
testSettleInvariant();
testBuildRiskSummary();
testCompletePairCostOk();
testCanTakerHedgePairCost();
testPairEntryBlocked();
testProjectedPairCost();
testPairEntryRiskGateProjected();
testExtremeQuoteBlocked();
testLegRatioBlocked();
testPairRoundsBlocked();
testPairEntryOpenOrders();
testPairInflight();
testUnwindBlocked();
testRebalanceRiskGate();
testOrphanForceBeforeWindowEnd();
testEmptyShellRecovery();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
