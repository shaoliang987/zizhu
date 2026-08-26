#!/usr/bin/env node
const assert = require('assert');
const { applyRedeemMarks, normalizeActivityOutcome } = require('../lib/activity_backfill');

console.log('redeem-marks.test.js\n');

const up = normalizeActivityOutcome({ outcome: '', outcomeIndex: 0 });
const down = normalizeActivityOutcome({ outcome: '', outcomeIndex: 1 });
assert.strictEqual(up.outcome, 'Up');
assert.strictEqual(down.outcome, 'Down');

const pos = {};
assert.strictEqual(applyRedeemMarks(pos, { redeems: [{ outcome: '', outcomeIndex: 1 }] }), true);
assert.strictEqual(pos.upMark, 0);
assert.strictEqual(pos.downMark, 1);

const existing = { upMark: 1, downMark: 0 };
assert.strictEqual(
  applyRedeemMarks(existing, { redeems: [{ outcome: 'Down', outcomeIndex: 1 }] }),
  false
);
assert.deepStrictEqual(existing, { upMark: 1, downMark: 0 });

console.log('3 passed');
