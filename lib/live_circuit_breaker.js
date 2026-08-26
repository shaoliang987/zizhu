function ensureRiskMap(state) {
  const breaker = state.liveCircuitBreaker || {};
  if (!breaker.risks || typeof breaker.risks !== 'object' || Array.isArray(breaker.risks)) {
    breaker.risks = {};
    if (breaker.active && breaker.conditionId) {
      breaker.risks[String(breaker.conditionId)] = {
        reason: breaker.reason || 'legacy circuit breaker',
        conditionId: breaker.conditionId,
        slug: breaker.slug || null,
        side: breaker.side || null,
        remaining: Number(breaker.remaining) || 0,
        createdAt: breaker.createdAt || new Date().toISOString(),
      };
    }
  }
  state.liveCircuitBreaker = breaker;
  return breaker;
}

function syncBreakerSummary(state) {
  const breaker = ensureRiskMap(state);
  const risks = Object.values(breaker.risks);
  const latest = risks[risks.length - 1] || null;
  breaker.active = risks.length > 0;
  breaker.riskCount = risks.length;
  breaker.conditionId = latest?.conditionId || null;
  breaker.slug = latest?.slug || null;
  breaker.reason = latest?.reason || null;
  breaker.side = latest?.side || null;
  breaker.remaining = latest ? Number(latest.remaining) || 0 : 0;
  return breaker;
}

function tripLiveCircuitBreaker(state, market, result = {}, log = () => {}) {
  const breaker = ensureRiskMap(state);
  const key = String(market?.conditionId || market?.slug || 'unknown');
  const prev = breaker.risks[key];
  const remaining = Number(result.remaining) || 0;
  state.bot_status = 'paused';
  breaker.risks[key] = {
    reason: result.reason || 'pair unwind failed',
    conditionId: market?.conditionId || prev?.conditionId || null,
    slug: market?.slug || prev?.slug || null,
    side: result.side || prev?.side || null,
    remaining,
    createdAt: prev?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  syncBreakerSummary(state);
  log(
    `[实盘断路器] 风险处置失败，已暂停新交易 · ${market?.slug || market?.conditionId || 'unknown'}` +
      (result.side ? ` · ${result.side}` : '') +
      (remaining > 0 ? ` rem=${remaining.toFixed(4)}` : '') +
      ` · 未解决 ${breaker.riskCount}`,
    'error'
  );
  return breaker;
}

function riskResolved(state, risk) {
  if (!risk?.conditionId) return false;
  const pos = state.positions?.[risk.conditionId];
  const upSh = Number(pos?.upShares) || 0;
  const downSh = Number(pos?.downShares) || 0;
  const hasOpenOrders = (state.open_orders || []).some((order) =>
    order.live === true && order.status === 'open' && order.conditionId === risk.conditionId
  );
  const locked = Boolean(pos?.riskLock?.reason);
  const unwinding = /unwind/i.test(String(pos?.pairInflight?.reason || ''));
  return !hasOpenOrders && !locked && !unwinding && Math.abs(upSh - downSh) <= 1e-8;
}

function maybeResolveLiveCircuitBreaker(state, log = () => {}) {
  const breaker = ensureRiskMap(state);
  let resolved = 0;
  for (const [key, risk] of Object.entries(breaker.risks)) {
    if (!riskResolved(state, risk)) continue;
    delete breaker.risks[key];
    resolved += 1;
    log(`[实盘断路器] 风险已清除 · ${risk.slug || risk.conditionId}`, 'success');
  }
  syncBreakerSummary(state);
  if (breaker.active) {
    state.bot_status = 'paused';
    return false;
  }
  if (resolved <= 0) return false;
  breaker.resolvedAt = new Date().toISOString();
  state.bot_status = 'running';
  log('[实盘断路器] 全部风险已清除 · 已允许恢复交易', 'success');
  return true;
}

module.exports = {
  tripLiveCircuitBreaker,
  maybeResolveLiveCircuitBreaker,
  riskResolved,
};
