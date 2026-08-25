#!/usr/bin/env node
/**
 * Redeem marks: outcome string OR outcomeIndex 0=Up / 1=Down.
 */
const assert = require('assert');
const { applyRedeemMarks, normalizeActivityOutcome } = require('../lib/activity_backfill');

console.log('redeem-marks.test.js\n');

{
  const row = normalizeActivityOutcome({ outcome: '', outcomeIndex: 0 });
  assert.strictEqual(row.outcome, 'Up');
  const row2 = normalizeActivityOutcome({ outcome: '', outcomeIndex: 1 });
  assert.strictEqual(row2.outcome, 'Down');
  console.log('  ok: normalizeActivityOutcome from index');
}

{
  const pos = {};
  const ok = applyRedeemMarks(pos, {
    redeems: [{ outcome: '', outcomeIndex: 0, usdcSize: 5 }],
  });
  assert.ok(ok);
  assert.strictEqual(pos.upMark, 1);
  assert.strictEqual(pos.downMark, 0);
  console.log('  ok: index 0 → Up wins');
}

{
  const pos = {};
  const ok = applyRedeemMarks(pos, {
    redeems: [{ outcome: '', outcomeIndex: 1, usdcSize: 5 }],
  });
  assert.ok(ok);
  assert.strictEqual(pos.upMark, 0);
  assert.strictEqual(pos.downMark, 1);
  console.log('  ok: index 1 → Down wins');
}

{
  const pos = { upMark: 1, downMark: 0 };
  const ok = applyRedeemMarks(pos, {
    redeems: [{ outcome: 'Down', outcomeIndex: 1 }],
  });
  assert.strictEqual(ok, false, 'do not overwrite existing marks');
  console.log('  ok: keep existing marks');
}

console.log('\n4 passed');
