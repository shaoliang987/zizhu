/**
 * Aggregate signal non-BUY outcomes and emit periodic summaries.
 */
const SUMMARY_INTERVAL_SEC_DEFAULT = 300;

let bucket = {
  since: new Date().toISOString(),
  scans: 0,
  byAction: {},
  byReason: {},
};

function reasonKey(plan) {
  const action = String(plan?.action || 'UNKNOWN');
  const reason = String(plan?.reason || '').trim();
  if (!reason) return action;

  if (reason.startsWith('raw bidSum') || reason.includes('bidSum')) return `${action}: bidSum > pair_sum_max`;
  if (reason.includes('out of band') || reason.includes('bid out of band')) return `${action}: price band`;
  if (reason.includes('skew max')) return `${action}: ask skew`;
  if (reason.startsWith('t=') && reason.includes('< entry')) return `${action}: before entry_start`;
  if (reason.startsWith('t=') && reason.includes('> entry end')) return `${action}: after entry_end`;
  if (reason.includes('pair needs') && reason.includes('before entry end')) return `${action}: pair entry window closed`;
  if (reason.includes('missing bid') || reason.includes('missing ask')) return `${action}: missing quote`;
  if (reason.includes('extreme quote')) return `${action}: extreme quote`;
  if (reason.includes('leg ratio')) return `${action}: leg ratio`;
  if (reason.includes('open orders resting')) return `${action}: open orders`;
  if (reason.includes('pair inflight')) return `${action}: pair inflight`;
  if (reason.includes('one-sided') || reason.includes('unbalanced')) return `${action}: imbalance`;
  if (reason.includes('pair rounds')) return `${action}: max pair rounds`;
  if (reason.includes('projected pairCost') || reason.includes('pair cost')) return `${action}: pair cost`;
  if (reason.includes('market cap full')) return `${action}: market cap`;

  return `${action}: ${reason.slice(0, 48)}`;
}

function recordPlanOutcome(plan) {
  if (!plan || plan.action === 'BUY') return;
  bucket.scans += 1;
  const action = String(plan.action || 'UNKNOWN');
  bucket.byAction[action] = (bucket.byAction[action] || 0) + 1;
  const key = reasonKey(plan);
  bucket.byReason[key] = (bucket.byReason[key] || 0) + 1;
}

function topEntries(map, n = 8) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function maybeFlushSkipSummary(state, params, addLog) {
  const intervalSec = Number(params.skip_summary_interval_sec);
  const intervalMs = (Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : SUMMARY_INTERVAL_SEC_DEFAULT) * 1000;
  const now = Date.now();
  const last = Number(state.skip_summary_last_at) || 0;
  if (now - last < intervalMs) return false;
  if (bucket.scans <= 0) {
    state.skip_summary_last_at = now;
    return false;
  }

  const mins = Math.round(intervalMs / 60000);
  const actions = topEntries(bucket.byAction, 6)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
  const reasons = topEntries(bucket.byReason, 8)
    .map(([k, v]) => `${k} (${v})`)
    .join(' | ');

  addLog(
    state,
    `[扫描汇总 ${mins}m] 非BUY ${bucket.scans} 次 · ${actions} · 主因: ${reasons}`,
    'info'
  );

  bucket = {
    since: new Date().toISOString(),
    scans: 0,
    byAction: {},
    byReason: {},
  };
  state.skip_summary_last_at = now;
  return true;
}

function resetSkipStats() {
  bucket = {
    since: new Date().toISOString(),
    scans: 0,
    byAction: {},
    byReason: {},
  };
}

module.exports = {
  recordPlanOutcome,
  maybeFlushSkipSummary,
  resetSkipStats,
  reasonKey,
};
