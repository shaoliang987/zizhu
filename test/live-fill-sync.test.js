#!/usr/bin/env node
const { parseBuyMatchedFromResponse } = require('../lib/live_clob');

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

console.log('live-fill-sync.test.js\n');
console.log('parseBuyMatchedFromResponse');
assert(parseBuyMatchedFromResponse({ size_matched: 5 }) === 5, 'size_matched');
assert(parseBuyMatchedFromResponse({ takingAmount: 5 }) === 5, 'takingAmount shares');
assert(
  Math.abs(parseBuyMatchedFromResponse({ makingAmount: 2.5, price: 0.5 }) - 5) < 0.01,
  'makingAmount / price'
);
assert(parseBuyMatchedFromResponse({}) === 0, 'empty response');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
