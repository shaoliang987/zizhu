const { rnd } = require('./fees');

function deriveInventoryState(pos, openOrders = []) {
  const up = Number(pos?.upShares) || 0;
  const down = Number(pos?.downShares) || 0;
  const open = (openOrders || []).filter((o) => o?.status === 'open');
  const uncertain = open.some((o) => o.reconcilePending) || Boolean(pos?.riskLock);
  if (uncertain) return 'uncertain';
  if (pos?.pairInflight?.reason === 'unwind pending') return 'unwind_pending';
  if (up <= 1e-8 && down <= 1e-8) return 'flat';
  if (up > 1e-8 && down > 1e-8 && Math.abs(up - down) <= 1e-6) return 'balanced';

  const missing = up > down ? 'Down' : 'Up';
  const hedgeResting = open.some(
    (o) => String(o.side || 'BUY').toUpperCase() === 'BUY' && o.outcome === missing
  );
  if (hedgeResting || pos?.pairInflight?.reason === 'await hedge rest') return 'hedge_pending';
  return 'first_leg_confirmed';
}

function refreshInventoryState(pos, openOrders = [], now = new Date()) {
  if (!pos) return null;
  const next = deriveInventoryState(pos, openOrders);
  const prev = pos.inventoryState || null;
  if (prev !== next) {
    pos.inventoryState = next;
    pos.inventoryStateChangedAt = now.toISOString();
    pos.inventoryStateTransition = prev ? `${prev}->${next}` : `init->${next}`;
  }
  pos.inventoryImbalanceShares = rnd(
    Math.abs((Number(pos.upShares) || 0) - (Number(pos.downShares) || 0)),
    6
  );
  return { previous: prev, current: next, changed: prev !== next };
}

function refreshAllInventoryStates(state, now = new Date()) {
  const changes = [];
  for (const [conditionId, pos] of Object.entries(state?.positions || {})) {
    if (pos?.settled) continue;
    const orders = (state.open_orders || []).filter(
      (o) => o.live && String(o.conditionId) === String(conditionId)
    );
    const result = refreshInventoryState(pos, orders, now);
    if (result?.changed) changes.push({ conditionId, ...result });
  }
  return changes;
}

module.exports = { deriveInventoryState, refreshInventoryState, refreshAllInventoryStates };
