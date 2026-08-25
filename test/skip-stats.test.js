#!/usr/bin/env node
const { recordPlanOutcome, maybeFlushSkipSummary, reasonKey } = require('../lib/skip_stats');

let passed = 0;
let failed = 0;
function ok(c, m) { if (c) { passed++; console.log('  ok:', m); } else { failed++; console.error('  FAIL:', m); } }

console.log('skip_stats.test.js\n');
ok(reasonKey({ action: 'SKIP', reason: 'raw bidSum 0.990 > max 0.985' }) === 'SKIP: bidSum > pair_sum_max', 'bidSum bucket');
ok(reasonKey({ action: 'WAIT', reason: 't=10s < entry 30s' }).includes('before entry_start'), 'wait bucket');
recordPlanOutcome({ action: 'SKIP', reason: 'raw bidSum 0.990 > max 0.985' });
recordPlanOutcome({ action: 'WAIT', reason: 't=10s < entry 30s' });
const state = {};
const logs = [];
maybeFlushSkipSummary(state, { skip_summary_interval_sec: 0 }, (s, msg) => logs.push(msg));
ok(logs.length === 1, 'flush emits summary');
ok(logs[0].includes('[扫描汇总'), 'summary prefix');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
