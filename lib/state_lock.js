/**
 * Simple async mutex so runScan and mutating API handlers don't interleave
 * loadState/saveState and corrupt open_orders / positions.
 */
let _chain = Promise.resolve();

function withStateLock(fn) {
  const run = _chain.then(() => fn());
  _chain = run.catch(() => {});
  return run;
}

module.exports = { withStateLock };
