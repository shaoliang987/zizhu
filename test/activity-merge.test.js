#!/usr/bin/env node
/**
 * Activity must not restore shares after a local unwind sell (stale page).
 */
const assert = require('assert');
const { mergeActivityOpenShares } = require('../lib/activity_backfill');

console.log('activity-merge.test.js\n');

{
  // Bug: sold 0.25 locally → prev=4.75; activity still shows rem=5, allowDrop=false
  // Old code: Math.max(4.75, 5) = 5 restored → endless 未平尽
  const r = mergeActivityOpenShares({
    prevUp: 0,
    prevDown: 4.75,
    remUp: 0,
    remDown: 5,
    allowDropUp: false,
    allowDropDown: false,
    buySharesUp: 0,
    buySharesDown: 5,
    prevBuyUp: 0,
    prevBuyDown: 5,
    unwinding: true,
  });
  assert.strictEqual(r.nextDown, 4.75, `keep local after sell, got ${r.nextDown}`);
  console.log('  ok: unwind does not restore sold shares');
}

{
  const r = mergeActivityOpenShares({
    prevUp: 0,
    prevDown: 4.75,
    remUp: 0,
    remDown: 4.75,
    allowDropUp: false,
    allowDropDown: true,
    buySharesUp: 0,
    buySharesDown: 5,
    prevBuyUp: 0,
    prevBuyDown: 5,
    unwinding: false,
  });
  assert.ok(Math.abs(r.nextDown - 4.75) < 1e-9, 'allowDrop applies rem');
  console.log('  ok: allowDrop uses activity rem');
}

{
  const r = mergeActivityOpenShares({
    prevUp: 5,
    prevDown: 0,
    remUp: 5,
    remDown: 5,
    allowDropUp: false,
    allowDropDown: false,
    buySharesUp: 5,
    buySharesDown: 5,
    prevBuyUp: 5,
    prevBuyDown: 0,
    unwinding: false,
  });
  assert.ok(Math.abs(r.nextDown - 5) < 1e-9, 'new buys on Down raise shares');
  console.log('  ok: new buys can raise missing leg');
}

console.log('\n3 passed');
