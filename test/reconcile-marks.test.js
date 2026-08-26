#!/usr/bin/env node
/**
 * Window summary must not show Up 0.0¢ / Down 0.0¢ when marks are missing.
 * Root cause: Number(null) === 0 in JS.
 */
const assert = require('assert');
const { centsLabel, settlePriceLabel, outcomeFromMarks } = require('../lib/reconcile');

console.log('reconcile-marks.test.js\n');

{
  assert.strictEqual(centsLabel(null), '—', 'null → —');
  assert.strictEqual(centsLabel(undefined), '—', 'undefined → —');
  assert.strictEqual(centsLabel(''), '—', 'empty → —');
  assert.ok(centsLabel(0).includes('0.0¢'), 'explicit 0 is valid 0¢');
  assert.ok(centsLabel(1).includes('100.0¢'), '1 → 100¢');
  console.log('  ok: centsLabel null-safe');
}

{
  assert.strictEqual(settlePriceLabel(null, null, null), '—');
  assert.strictEqual(settlePriceLabel(null, 0, 0), 'Up 0.0¢ ($0.00) / Down 0.0¢ ($0.00)');
  assert.ok(settlePriceLabel('Down', 0, 1).startsWith('Down'), 'Down outcome');
  assert.ok(settlePriceLabel('Up', 1, 0).startsWith('Up'), 'Up outcome');
  console.log('  ok: settlePriceLabel missing → —');
}

{
  assert.strictEqual(outcomeFromMarks(null, null), null);
  assert.strictEqual(outcomeFromMarks(1, 0), 'Up');
  assert.strictEqual(outcomeFromMarks(0, 1), 'Down');
  console.log('  ok: outcomeFromMarks');
}

{
  const { latestSettlementByCondition } = require('../lib/reconcile');
  const map = latestSettlementByCondition([
    { conditionId: 'a', ts: '2026-01-01T00:00:00Z', upMark: 1, downMark: 0, realized: 0.2 },
    { conditionId: 'a', ts: '2026-01-01T01:00:00Z', realized: 0.2 },
  ]);
  const row = map.get('a');
  assert.strictEqual(row.upMark, 1, 'keep marks when newer row omits them');
  assert.strictEqual(row.downMark, 0);
  console.log('  ok: latestSettlement merges marks');
}

console.log('\n4 passed');
