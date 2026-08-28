#!/usr/bin/env node
const assert = require('assert');
const {
  trackUncertainLiveBuy,
  tripLiveCircuitBreaker,
  maybeResolveLiveCircuitBreaker,
  selectLiveEntryLegs,
  updatePendingPairLegs,
  pendingPairHedgeShares,
  orphanLossAtBid,
} = require('../lib/live_clob');
const { riskResolved } = require('../lib/live_circuit_breaker');

console.log('order-safety.test.js\n');

const market = {
  conditionId: 'cid',
  slug: 'btc-test',
  title: 'BTC test',
  windowStart: 100,
  windowEnd: 400,
  upTokenId: 'up-token',
  downTokenId: 'down-token',
};
const state = {
  bot_status: 'running',
  positions: {},
  open_orders: [],
  logs: [],
};

const uncertain = trackUncertainLiveBuy(state, {
  market,
  prep: { side: 'Up', tokenId: 'up-token', shares: 5, limit: 0.48, quoteMode: 'maker' },
  orderId: 'remote-order',
  paired: true,
  reason: 'cancel timeout',
});
assert(uncertain && uncertain.reconcilePending, 'uncertain remote order remains tracked');
assert.strictEqual(uncertain.reservedUsdc, 0, 'uncertain order does not invent a reserve');

tripLiveCircuitBreaker(state, market, { reason: 'cancel uncertain', remaining: 5, side: 'Up' });
assert.strictEqual(state.bot_status, 'paused');
assert.strictEqual(maybeResolveLiveCircuitBreaker(state), false, 'open uncertain order keeps breaker active');
uncertain.status = 'cancelled';
assert.strictEqual(maybeResolveLiveCircuitBreaker(state), true, 'breaker resolves after order closes');
assert.strictEqual(state.bot_status, 'running');

{
  const breakerState = {
    bot_status: 'running',
    positions: {
      a: { upShares: 5, downShares: 0 },
      b: { upShares: 0, downShares: 0 },
    },
    open_orders: [],
    logs: [],
  };
  tripLiveCircuitBreaker(breakerState, { conditionId: 'a', slug: 'a' }, { reason: 'missing leg' });
  tripLiveCircuitBreaker(breakerState, { conditionId: 'b', slug: 'b' }, { reason: 'cancel uncertain' });
  assert.strictEqual(breakerState.liveCircuitBreaker.riskCount, 2, 'breaker retains both markets');
  assert.strictEqual(maybeResolveLiveCircuitBreaker(breakerState), false, 'risk A keeps breaker active');
  assert.strictEqual(breakerState.liveCircuitBreaker.riskCount, 1, 'only resolved market is removed');
  breakerState.positions.a.downShares = 5;
  assert.strictEqual(maybeResolveLiveCircuitBreaker(breakerState), true, 'last risk can now resolve');
}

{
  assert.strictEqual(pendingPairHedgeShares(2, 0), 2, 'partial first-leg fill hedges only 2 shares');
  assert.strictEqual(pendingPairHedgeShares(5, 2), 3, 'existing opposite inventory reduces hedge size');
  assert.strictEqual(pendingPairHedgeShares(5, 5), 0, 'balanced inventory needs no hedge');
}

{
  const lockedState = {
    bot_status: 'paused',
    positions: {
      locked: {
        upShares: 5,
        downShares: 5,
        riskLock: { reason: 'pair cost too high' },
      },
    },
    open_orders: [],
    logs: [],
  };
  tripLiveCircuitBreaker(
    lockedState,
    { conditionId: 'locked', slug: 'locked' },
    { reason: 'pair cost too high' }
  );
  assert.strictEqual(
    maybeResolveLiveCircuitBreaker(lockedState),
    false,
    'balanced shares do not resolve an active risk lock'
  );
  delete lockedState.positions.locked.riskLock;
  assert.strictEqual(maybeResolveLiveCircuitBreaker(lockedState), true);
}

{
  const legs = [
    { side: 'Up', limit: 0.41 },
    { side: 'Down', limit: 0.57 },
  ];
  const selected = selectLiveEntryLegs(legs, true, { live_high_leg_first: 1 });
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(selected[0].side, 'Down', 'higher-priced leg is posted first');
  assert.strictEqual(
    selectLiveEntryLegs(legs, false, { live_high_leg_first: 1 }).length,
    2,
    'rebalance/non-pair orders are unchanged'
  );
  assert.strictEqual(
    selectLiveEntryLegs(legs, true, { live_high_leg_first: 0 }).length,
    2,
    'live_high_leg_first off posts both legs'
  );
}

{
  const market = { conditionId: 'cid2', slug: 'btc-test-2' };
  const state = {
    positions: { cid2: { upShares: 5, downShares: 0, upCost: 2.35, downCost: 0 } },
    open_orders: [],
  };
  const prepared = [
    { side: 'Up', shares: 5, limit: 0.47, tokenId: 'up' },
    { side: 'Down', shares: 5, limit: 0.51, tokenId: 'down' },
  ];
  updatePendingPairLegs(state, market, prepared, true);
  assert.strictEqual(state.positions.cid2.pendingPairLegs.length, 1);
  assert.strictEqual(state.positions.cid2.pendingPairLegs[0].side, 'Down');
  state.open_orders.push({
    status: 'open',
    side: 'BUY',
    outcome: 'Down',
    conditionId: 'cid2',
    live: true,
  });
  updatePendingPairLegs(state, market, prepared, true);
  assert.strictEqual(state.positions.cid2.pendingPairLegs, undefined, 'resting hedge clears pending');
}

{
  const pos = { upShares: 5, upCost: 3, downShares: 0, downCost: 0 };
  const params = { max_orphan_loss_usdc: 0.35, taker_fee_rate: 0.07 };
  assert.strictEqual(orphanLossAtBid(pos, 'Up', 0.57, params).exceeded, false);
  assert.strictEqual(orphanLossAtBid(pos, 'Up', 0.54, params).exceeded, true);
}

{
  const settled = {
    conditionId: 'cid-settled',
    settled: true,
    upShares: 0,
    downShares: 0,
    riskLock: { reason: 'missing Up · unwind failed' },
  };
  const state = {
    positions: { 'cid-settled': settled },
    open_orders: [],
  };
  assert.strictEqual(
    riskResolved(state, { conditionId: 'cid-settled' }),
    true,
    'settled flat window clears stale risk'
  );
  assert(!settled.riskLock, 'riskLock cleared on resolve check');
}

console.log('15 passed');
