/**
 * Build risk / health summary for dashboard (no side effects).
 */
const { detectPairExposure, validatePairedPositionCost } = require('./pair_risk');

function collectMarketContexts(state) {
  const map = new Map();
  const ensure = (conditionId, seed = {}) => {
    const id = String(conditionId || '');
    if (!id) return null;
    if (!map.has(id)) {
      map.set(id, {
        conditionId: id,
        slug: seed.slug || id.slice(0, 10),
        title: seed.title || seed.slug || id.slice(0, 10),
        pos: null,
        orders: [],
      });
    }
    const ctx = map.get(id);
    if (seed.slug) ctx.slug = seed.slug;
    if (seed.title) ctx.title = seed.title;
    if (seed.pos) ctx.pos = seed.pos;
    return ctx;
  };

  for (const pos of Object.values(state.positions || {})) {
    if (pos.settled) continue;
    const upSh = Number(pos.upShares) || 0;
    const downSh = Number(pos.downShares) || 0;
    if (upSh <= 1e-8 && downSh <= 1e-8) continue;
    const ctx = ensure(pos.conditionId, { slug: pos.slug, title: pos.title, pos });
    if (ctx) ctx.pos = pos;
  }

  for (const o of state.open_orders || []) {
    if (o.status !== 'open') continue;
    const ctx = ensure(o.conditionId, {
      slug: o.slug,
      title: o.title,
      pos: state.positions?.[o.conditionId] || null,
    });
    if (ctx) ctx.orders.push(o);
  }

  return [...map.values()];
}

function buildRiskSummary(state, opts = {}) {
  const contexts = collectMarketContexts(state);
  const exposures = [];
  const costAlerts = [];

  for (const ctx of contexts) {
    const pos = ctx.pos;
    const upSh = Number(pos?.upShares) || 0;
    const downSh = Number(pos?.downShares) || 0;
    const hasUpRest = ctx.orders.some((o) => o.outcome === 'Up');
    const hasDownRest = ctx.orders.some((o) => o.outcome === 'Down');
    const det = detectPairExposure(upSh, downSh, hasUpRest, hasDownRest);

    if (det.kind === 'one_sided') {
      exposures.push({
        type: 'one_sided',
        conditionId: ctx.conditionId,
        slug: ctx.slug,
        title: ctx.title,
        missingSide: det.missingSide,
        upShares: upSh,
        downShares: downSh,
        upRest: hasUpRest,
        downRest: hasDownRest,
        liveOrders: ctx.orders.filter((o) => o.live).length,
      });
    }

    if (upSh > 1e-8 && downSh > 1e-8) {
      const cost = validatePairedPositionCost(state, { conditionId: ctx.conditionId });
      if (!cost.ok) {
        costAlerts.push({
          type: 'pair_cost',
          conditionId: ctx.conditionId,
          slug: ctx.slug,
          title: ctx.title,
          pairCost: cost.pairCost,
          maxSum: cost.maxSum,
        });
      }
    }
  }

  const openOrders = (state.open_orders || []).filter((o) => o.status === 'open');
  const pendingReconcile = openOrders.filter((o) => o.reconcilePending || o.reconcileError).length;
  const cancelFailed = openOrders.filter((o) => o.cancelFailed).length;
  const pendingRedeem = Object.values(state.positions || {}).filter(
    (p) => p.settled && p.redeemPending && !p.redeemed
  ).length;
  const liveOpen = openOrders.filter((o) => o.live).length;
  const paperOpen = openOrders.filter((o) => !o.live).length;

  const issues = exposures.length + costAlerts.length + pendingReconcile + cancelFailed + pendingRedeem;

  return {
    ok: issues === 0,
    issue_count: issues,
    one_sided: exposures,
    pair_cost_alerts: costAlerts,
    pending_reconcile_orders: pendingReconcile,
    cancel_failed_orders: cancelFailed,
    pending_redeem_positions: pendingRedeem,
    open_orders_live: liveOpen,
    open_orders_paper: paperOpen,
    clob_cash_usdc: state.clob_cash_usdc != null ? Number(state.clob_cash_usdc) : null,
    clob_cash_synced_at: state.clob_cash_synced_at || null,
    ledger_cash_usdc: Number(state.cash_usdc) || 0,
    reserved_usdc: Number(state.reserved_usdc) || 0,
    ledger_cash_resyncs: Number(state.stats?.ledger_cash_resyncs) || 0,
    ledger_cash_topups_usdc: Number(state.stats?.ledger_cash_topups_usdc) || 0,
    api_auth_required: Boolean(opts.apiAuthRequired),
    bind_host: opts.bindHost || null,
  };
}

module.exports = {
  buildRiskSummary,
  collectMarketContexts,
};
