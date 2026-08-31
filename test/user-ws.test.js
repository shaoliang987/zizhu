#!/usr/bin/env node
const assert = require('assert');
const { parseUserMessage } = require('../lib/user_ws');
const { deriveInventoryState, refreshInventoryState } = require('../lib/inventory_state');
const { applyLiveUserEvent } = require('../lib/live_clob');

console.log('user-ws.test.js\n');
const tokens = new Map([
  ['up-token', { conditionId: 'cid', outcome: 'Up' }],
  ['down-token', { conditionId: 'cid', outcome: 'Down' }],
]);

const orderEvents = parseUserMessage({
  event_type: 'order', type: 'UPDATE', id: 'ord-1', asset_id: 'up-token',
  size_matched: '2.5', price: '0.48',
}, tokens);
assert.strictEqual(orderEvents.length, 1);
assert.deepStrictEqual(orderEvents[0], {
  kind: 'order_fill_total', orderId: 'ord-1', tokenId: 'up-token',
  matchedTotal: 2.5, price: 0.48, conditionId: 'cid', outcome: 'Up',
});

const tradeEvents = parseUserMessage({
  event_type: 'trade', status: 'MATCHED', id: 'trade-1', taker_order_id: 'ord-2',
  asset_id: 'down-token', size: '5', price: '0.49',
}, tokens);
assert.strictEqual(tradeEvents[0].kind, 'trade_fill');
assert.strictEqual(tradeEvents[0].tradeId, 'trade-1');
assert.strictEqual(tradeEvents[0].outcome, 'Down');

assert.strictEqual(deriveInventoryState({ upShares: 0, downShares: 0 }), 'flat');
assert.strictEqual(deriveInventoryState({ upShares: 5, downShares: 0 }), 'first_leg_confirmed');
assert.strictEqual(deriveInventoryState(
  { upShares: 5, downShares: 0 },
  [{ status: 'open', side: 'BUY', outcome: 'Down' }]
), 'hedge_pending');
assert.strictEqual(deriveInventoryState({ upShares: 5, downShares: 5 }), 'balanced');
assert.strictEqual(deriveInventoryState(
  { upShares: 5, downShares: 0, riskLock: { reason: 'uncertain' } }
), 'uncertain');

const pos = { upShares: 3, downShares: 0 };
const transition = refreshInventoryState(pos, [], new Date('2026-01-01T00:00:00Z'));
assert.strictEqual(transition.current, 'first_leg_confirmed');
assert.strictEqual(pos.inventoryImbalanceShares, 3);

const cancelState = {
  cash_usdc: 10,
  reserved_usdc: 2.5,
  positions: {},
  open_orders: [{
    id: 'cancel-race', live: true, status: 'open', side: 'BUY', outcome: 'Up',
    originalSize: 5, remaining: 5, reservedUsdc: 2.5, sizeMatchedBooked: 0,
  }],
};

applyLiveUserEvent(cancelState, { kind: 'order_cancelled', orderId: 'cancel-race' })
  .then((result) => {
    assert.strictEqual(result.pendingReconcile, true);
    assert.strictEqual(cancelState.open_orders[0].status, 'open', 'cancel waits for final fill reconciliation');
    assert.strictEqual(cancelState.open_orders[0].remaining, 5, 'cancel does not erase possible final fill');
    assert.strictEqual(cancelState.reserved_usdc, 2.5, 'cancel does not release reserve before reconciliation');
    console.log('14 passed');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
