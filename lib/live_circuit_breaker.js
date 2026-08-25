function tripLiveCircuitBreaker(state, market, result = {}, log = () => {}) {
  const remaining = Number(result.remaining) || 0;
  state.bot_status = 'paused';
  state.liveCircuitBreaker = {
    active: true,
    reason: result.reason || 'pair unwind failed',
    conditionId: market?.conditionId || null,
    slug: market?.slug || null,
    side: result.side || null,
    remaining,
    createdAt: new Date().toISOString(),
  };
  log(
    `[实盘断路器] 裸仓处置失败，已暂停新交易 · ${market?.slug || market?.conditionId || 'unknown'}` +
      (result.side ? ` · ${result.side}` : '') +
      (remaining > 0 ? ` rem=${remaining.toFixed(4)}` : ''),
    'error'
  );
  return state.liveCircuitBreaker;
}

function maybeResolveLiveCircuitBreaker(state, log = () => {}) {
  const breaker = state.liveCircuitBreaker;
  if (!breaker?.active || !breaker.conditionId) return false;
  const pos = state.positions?.[breaker.conditionId];
  const upSh = Number(pos?.upShares) || 0;
  const downSh = Number(pos?.downShares) || 0;
  const hasOpenOrders = (state.open_orders || []).some((order) =>
    order.live === true &&
    order.status === 'open' &&
    order.conditionId === breaker.conditionId
  );
  if (Math.abs(upSh - downSh) > 1e-8 || hasOpenOrders) return false;

  breaker.active = false;
  breaker.resolvedAt = new Date().toISOString();
  breaker.remaining = 0;
  log(
    `[实盘断路器] 裸仓已清除 · ${breaker.slug || breaker.conditionId} · 保持暂停，等待人工确认恢复`,
    'success'
  );
  return true;
}

module.exports = {
  tripLiveCircuitBreaker,
  maybeResolveLiveCircuitBreaker,
};
