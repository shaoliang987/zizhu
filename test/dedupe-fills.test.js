#!/usr/bin/env node
const { isDuplicateMakerFill } = require('../lib/activity_backfill');

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

console.log('dedupe-fills.test.js\n');

const maker = [{
  type: 'LIVE_BUY',
  conditionId: '0xabc',
  side: 'Down',
  shares: 5,
  price: 0.57,
  ts: '2026-08-25T03:45:45.678Z',
  liquidity: 'maker',
  orderId: '0xa5d58a',
}];

const activityRow = {
  conditionId: '0xabc',
  outcome: 'Down',
  size: 5,
  price: 0.51,
  timestamp: Math.floor(new Date('2026-08-25T03:45:48.000Z').getTime() / 1000),
};

assert(isDuplicateMakerFill(maker, activityRow, 'LIVE_BUY'), 'limit 0.57 vs fill 0.51 deduped');
assert(
  !isDuplicateMakerFill(maker, { ...activityRow, price: 0.20 }, 'LIVE_BUY'),
  'large price gap not deduped'
);
assert(
  !isDuplicateMakerFill(maker, { ...activityRow, outcome: 'Up' }, 'LIVE_BUY'),
  'other side not deduped'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
