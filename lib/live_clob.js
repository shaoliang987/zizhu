/**
 * Live CLOB order lifecycle — track resting GTC, poll fills, cancel/re-quote.
 * Uses the same state.open_orders array as paper (flag live: true).
 */
const { applyBuy, addLog, saveState, recordWindowRealized, getOrCreatePosition } = require('./ledger');
const { buyCostWithFee, withTakerFeeCash, rnd } = require('./fees');
const { loadParams } = require('./strategy');
const { ensureOrders, releaseReserve, pruneOrders, openOrders, ordersForMarket, feeRateFor, tickRound } = require('./paper_clob');
const { isLive } = require('./mode');
const {
  tripLiveCircuitBreaker: tripCircuitBreaker,
  maybeResolveLiveCircuitBreaker: resolveCircuitBreaker,
} = require('./live_circuit_breaker');

const UNWIND_MAX_ROUNDS = parseInt(process.env.UNWIND_MAX_ROUNDS || '8', 10);

function extractOrderId(resp) {
  if (!resp || typeof resp !== 'object') return '';
  const candidates = [
    resp.orderID,
    resp.order_id,
    resp.id,
    resp.order?.orderID,
    resp.order?.order_id,
    resp.order?.id,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim();
  }
  return '';
}

function parseSellMatched(resp) {
  const direct = parseSize(resp?.size_matched || resp?.filledSize || resp?.takingAmount || 0);
  if (direct > 0) return direct;
  const making = parseSize(resp?.makingAmount || 0);
  return making > 0 ? making : 0;
}

function parseBuyMatchedFromResponse(resp) {
  if (!resp) return 0;
  let matched = parseSize(resp.size_matched || resp.filledSize || 0);
  if (matched > 0) return matched;
  const taking = parseSize(resp.takingAmount || 0);
  if (taking > 0) return taking;
  const making = parseUsdc(resp.makingAmount);
  const px = Number(resp.average_price || resp.price || 0);
  if (making != null && making > 0 && px > 0) {
    return rnd(making / px, 6);
  }
  return 0;
}

async function pollLiveOrderFill(state, order, { expected = 0, attempts = 4, delayMs = 200 } = {}) {
  if (!order || !order.id) return { matched: 0, booked: false };
  let totalBooked = Number(order.sizeMatchedBooked) || 0;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await matchOneLiveOrder(state, order);
      totalBooked = Number(order.sizeMatchedBooked) || 0;
      if (totalBooked + 1e-6 >= (Number(expected) || order.originalSize || 0)) {
        return { matched: totalBooked, booked: Boolean(r?.booked), done: true };
      }
      if (order.status !== 'open') {
        return { matched: totalBooked, booked: totalBooked > 0, done: true };
      }
    } catch (_) { /* retry */ }
    if (i + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { matched: Number(order.sizeMatchedBooked) || 0, booked: totalBooked > 0, done: false };
}

function parseSize(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (Number.isInteger(n) && n >= 1000 && n % 1000 === 0) return rnd(n / 1e6, 6);
  return rnd(n, 6);
}

function parseUsdc(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (Number.isInteger(n) && n >= 1000) return rnd(n / 1e6, 4);
  return rnd(n, 4);
}

function liveOrders(state) {
  return openOrders(state).filter((o) => o.live);
}

function liveOrdersForMarket(state, conditionId) {
  return liveOrders(state).filter((o) => o.conditionId === conditionId);
}

function liveReservedUsdc(state, conditionId = null) {
  const list = conditionId
    ? liveOrdersForMarket(state, conditionId)
    : liveOrders(state);
  return list.reduce((a, o) => a + (Number(o.reservedUsdc) || 0), 0);
}

function marketStubFromOrder(order) {
  return {
    conditionId: order.conditionId,
    slug: order.slug,
    title: order.title,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    upTokenId: order.upTokenId,
    downTokenId: order.downTokenId,
  };
}

function marketFromPos(pos) {
  return {
    conditionId: pos.conditionId,
    slug: pos.slug,
    title: pos.title,
    windowStart: pos.windowStart,
    windowEnd: pos.windowEnd,
    upTokenId: pos.upTokenId,
    downTokenId: pos.downTokenId,
  };
}

/** USDC spent/received for *our* order within a CLOB trade (not whole trade aggregate). */
function extractOrderUsdcFromTrade(trade, orderId) {
  if (!trade || !orderId) return null;
  const oid = String(orderId).toLowerCase();
  let usdc = 0;
  let found = false;

  for (const mo of trade.maker_orders || []) {
    if (String(mo.order_id || '').toLowerCase() !== oid) continue;
    const amt = parseSize(mo.matched_amount);
    const px = Number(mo.price) || 0;
    if (amt > 0 && px > 0) {
      usdc += amt * px;
      found = true;
    }
  }
  if (found) return rnd(usdc, 4);

  if (String(trade.taker_order_id || '').toLowerCase() === oid) {
    const sz = parseSize(trade.size);
    const px = Number(trade.price) || 0;
    if (sz > 0 && px > 0) return rnd(sz * px, 4);
  }

  return null;
}

function resolveLiveFillUsdc(order, delta, px, makingAmount, matchedTotal = null) {
  const notional = rnd(delta * px, 4);
  let usdc = null;
  const made = parseUsdc(makingAmount);
  if (made != null && made > 0) {
    const total = parseSize(matchedTotal != null ? matchedTotal : delta);
    // CLOB associate_trades USDC is cumulative for the order — scale to this delta.
    if (total > 1e-12 && Math.abs(total - delta) > 1e-6) {
      usdc = rnd(made * (delta / total), 4);
    } else {
      usdc = made;
    }
  }
  // Reject trade-aggregate amounts that dwarf our own fill (common getTrades pitfall).
  if (usdc != null && usdc > notional * 1.25 + 0.02) usdc = null;
  return usdc;
}

function collectMarketsForPairAudit(state) {
  const seen = new Set();
  const markets = [];
  const push = (m) => {
    const id = String(m?.conditionId || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    markets.push(m);
  };
  for (const pos of Object.values(state.positions || {})) {
    if (pos.settled) continue;
    const upSh = Number(pos.upShares) || 0;
    const downSh = Number(pos.downShares) || 0;
    if (upSh > 1e-8 || downSh > 1e-8) push(marketFromPos(pos));
  }
  for (const o of liveOrders(state)) {
    push(marketStubFromOrder(o));
  }
  return markets;
}

async function getClient() {
  const { getClobClient } = require('./executor');
  return getClobClient();
}

function tripLiveCircuitBreaker(state, market, result = {}) {
  return tripCircuitBreaker(state, market, result, (message, type) => addLog(state, message, type));
}

function maybeResolveLiveCircuitBreaker(state) {
  return resolveCircuitBreaker(state, (message, type) => addLog(state, message, type));
}

/** Preserve an exchange BUY that could not be booked locally, so reconciliation can recover it. */
function trackUncertainLiveBuy(state, { market, prep, orderId, paired, reason }) {
  ensureOrders(state);
  const id = String(orderId || '');
  if (!id) return null;
  const existing = state.open_orders.find((o) => String(o.id) === id);
  if (existing) return existing;
  const order = {
    id,
    live: true,
    status: 'open',
    side: 'BUY',
    outcome: prep.side,
    tokenId: String(prep.tokenId),
    conditionId: market.conditionId,
    slug: market.slug,
    title: market.title,
    windowStart: market.windowStart,
    windowEnd: market.windowEnd,
    upTokenId: market.upTokenId,
    downTokenId: market.downTokenId,
    limit: tickRound(prep.limit),
    originalSize: rnd(Number(prep.shares), 6),
    remaining: rnd(Number(prep.shares), 6),
    filled: 0,
    sizeMatchedBooked: 0,
    reservedUsdc: 0,
    quoteMode: prep.quoteMode || 'maker',
    paired: Boolean(paired),
    plannedPrice: prep.planned,
    marketAskAtPost: prep.marketAsk,
    reconcilePending: true,
    reconcileError: String(reason || 'local tracking failed').slice(0, 160),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.open_orders.push(order);
  return order;
}

function trackLiveOrder(state, {
  market,
  side,
  tokenId,
  shares,
  limitPrice,
  orderId,
  quoteMode = 'maker',
  paired = false,
  plannedPrice = null,
  marketAsk = null,
  sizeMatched = 0,
  makingAmount = null,
}) {
  ensureOrders(state);
  const params = loadParams();
  const limit = tickRound(limitPrice);
  const size = rnd(Number(shares), 6);
  const id = extractOrderId({ orderID: orderId }) || String(orderId || '');
  if (!id || !(limit > 0) || !(size > 0)) {
    return { ok: false, reason: 'invalid live order' };
  }

  const makerRate = feeRateFor(params, 'maker');
  const need = buyCostWithFee(size, limit, makerRate).cost;
  // Live: collateral locked on exchange; reserve is shadow accounting until next CLOB sync
  if (state.cash_usdc + 1e-9 < need) {
    const clob = Number(state.clob_cash_usdc);
    if (Number.isFinite(clob) && clob + 1e-9 >= need) {
      state.cash_usdc = rnd(clob, 4);
    } else {
      return { ok: false, reason: `cash $${state.cash_usdc.toFixed(4)} < reserve $${need}` };
    }
  }

  state.cash_usdc = rnd(state.cash_usdc - need, 4);
  state.reserved_usdc = rnd((Number(state.reserved_usdc) || 0) + need, 4);

  const matched = parseSize(sizeMatched);
  const order = {
    id,
    live: true,
    status: 'open',
    side: 'BUY',
    outcome: side,
    tokenId: String(tokenId),
    conditionId: market.conditionId,
    slug: market.slug,
    title: market.title,
    windowStart: market.windowStart,
    windowEnd: market.windowEnd,
    upTokenId: market.upTokenId,
    downTokenId: market.downTokenId,
    limit,
    originalSize: size,
    remaining: rnd(Math.max(0, size - matched), 6),
    filled: matched,
    sizeMatchedBooked: 0,
    reservedUsdc: need,
    quoteMode,
    paired: Boolean(paired),
    plannedPrice: plannedPrice != null ? Number(plannedPrice) : limit,
    marketAskAtPost: marketAsk,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.open_orders.push(order);

  if (matched > 1e-12) {
    bookLiveFill(state, order, matched, limit, quoteMode, makingAmount);
  }

  return { ok: true, order };
}

function bookLiveFill(state, order, matchedTotal, fillPrice, roleHint, makingAmount = null) {
  const prev = Number(order.sizeMatchedBooked) || 0;
  const total = parseSize(matchedTotal);
  const delta = rnd(total - prev, 6);
  if (!(delta > 1e-12)) return { ok: false, reason: 'no new fill' };

  const params = loadParams();
  const px = tickRound(fillPrice || order.limit);
  const role = roleHint === 'taker' || (order.marketAskAtPost != null && px >= Number(order.marketAskAtPost) - 1e-9)
    ? 'taker'
    : 'maker';
  const feeRate = feeRateFor(params, role);

  let usdcFromApi = resolveLiveFillUsdc(order, delta, px, makingAmount, total);

  const rem = Number(order.remaining) || 0;
  const rel = rnd(((Number(order.reservedUsdc) || 0) * delta) / Math.max(rem + delta, delta), 4);
  releaseReserve(state, order, rel);

  const cash = usdcFromApi != null
    ? withTakerFeeCash('BUY', delta, px, usdcFromApi, feeRate)
    : buyCostWithFee(delta, px, feeRate);

  const r = applyBuy(state, marketStubFromOrder(order), order.outcome, delta, px, {
    live: true,
    orderId: order.id,
    paired: order.paired,
    plannedPrice: order.plannedPrice,
    limitPrice: order.limit,
    marketAsk: order.marketAskAtPost,
    quoteMode: role,
    feeRate,
    liquidity: role,
    usdcFromApi: cash.cost,
  });

  if (!r.ok) {
    state.cash_usdc = rnd(state.cash_usdc - rel, 4);
    state.reserved_usdc = rnd((Number(state.reserved_usdc) || 0) + rel, 4);
    order.reservedUsdc = rnd((Number(order.reservedUsdc) || 0) + rel, 4);
    return r;
  }

  order.sizeMatchedBooked = total;
  order.filled = total;
  order.remaining = rnd(Math.max(0, (Number(order.originalSize) || 0) - total), 6);
  order.updatedAt = new Date().toISOString();
  if (order.remaining <= 1e-12) {
    order.status = 'filled';
    releaseReserve(state, order, order.reservedUsdc);
    order.remaining = 0;
  }
  addLog(
    state,
    `[实盘成交] BUY ${order.outcome} ${delta} @ $${px}` +
      ` (fee $${r.fee}; ${role}; order=${String(order.id).slice(-6)})`,
    'success'
  );
  return { ok: true, ...r, delta, role };
}

const {
  detectPairExposure,
  validatePairedPositionCost,
  shouldSkipStaleCancelForHedge,
  shouldDeferOrphanUnwind,
  hedgeRestAgeSec,
  skewCancelPlan,
  canTakerHedgePairCost,
  projectedPairCostOnLegFill,
  setPairRiskLock,
  clearPairRiskLock,
  setPairInflight,
  clearPairInflight,
  maybeClearPairInflight,
  pairRoundsBlocked,
  orphanForceBeforeEndSec,
  shouldAllowOrphanLossDump,
} = require('./pair_risk');

async function matchOneLiveOrder(state, order) {
  const client = await getClient();
  let remote;
  try {
    remote = await client.getOrder(String(order.id));
  } catch (err) {
    throw new Error(`getOrder failed: ${err.message}`);
  }
  if (!remote) return { remote: null, booked: false };

  const status = String(remote.status || '').toUpperCase();
  const matched = parseSize(remote.size_matched);
  const px = Number(remote.price) || order.limit;
  const isSell = String(order.side || 'BUY').toUpperCase() === 'SELL';
  let makingAmount = null;
  const tradeIds = remote.associate_trades || [];
  if (!isSell && tradeIds.length) {
    let usdc = 0;
    for (const tid of tradeIds.slice(0, 8)) {
      try {
        const trades = await client.getTrades({ id: String(tid) }, true);
        for (const t of trades || []) {
          const part = extractOrderUsdcFromTrade(t, order.id);
          if (part != null && part > 0) usdc += part;
        }
      } catch (_) { /* ignore */ }
    }
    if (usdc > 0) makingAmount = usdc;
  }

  let booked = false;
  if (matched > (Number(order.sizeMatchedBooked) || 0) + 1e-12) {
    if (isSell) {
      const prev = Number(order.sizeMatchedBooked) || 0;
      const delta = rnd(matched - prev, 6);
      const market = marketStubFromOrder(order);
      const taking = parseUsdc(remote.takingAmount);
      const r = bookLiveSellFill(state, market, order.outcome, delta, px, taking);
      booked = Boolean(r.ok);
      if (booked) {
        order.sizeMatchedBooked = matched;
        order.filled = matched;
        order.remaining = rnd(Math.max(0, (Number(order.originalSize) || 0) - matched), 6);
        order.updatedAt = new Date().toISOString();
      }
    } else {
      const r = bookLiveFill(state, order, matched, px, order.quoteMode, makingAmount);
      booked = Boolean(r.ok);
      if (booked && order.paired) {
        await maybePostPendingPairLegAfterFill(state, order);
      }
    }
  }

  if (
    status.includes('CANCELED') ||
    status.includes('CANCELLED') ||
    status.includes('INVALID')
  ) {
    if (order.status === 'open') {
      releaseReserve(state, order, order.reservedUsdc);
      order.status = 'cancelled';
      order.cancelReason = `exchange ${status}`;
      order.remaining = 0;
      order.updatedAt = new Date().toISOString();
    }
  } else if (status.includes('MATCHED') && order.remaining <= 1e-12) {
    order.status = 'filled';
  }

  return { remote, booked, matched, status };
}

async function matchLiveOpenOrders(state) {
  const open = liveOrders(state);
  if (!open.length) return { matched: 0, fills: [] };
  const fills = [];
  const before = open.map((o) => Number(o.sizeMatchedBooked) || 0);
  for (let i = 0; i < open.length; i++) {
    try {
      await matchOneLiveOrder(state, open[i]);
      const after = Number(open[i].sizeMatchedBooked) || 0;
      if (after > before[i] + 1e-12) fills.push({ orderId: open[i].id, matched: after });
    } catch (err) {
      addLog(state, `[实盘查单] ${String(open[i].id).slice(-6)}: ${err.message}`, 'warning');
    }
  }
  if (fills.length) saveState(state);
  pruneOrders(state);
  return { matched: fills.length, fills };
}

async function cancelLiveOrder(state, orderId, reason = 'cancelled') {
  ensureOrders(state);
  const order = state.open_orders.find((o) => o.id === orderId && o.status === 'open' && o.live);
  if (!order) return { ok: false, reason: 'not found' };

  try {
    await matchOneLiveOrder(state, order);
  } catch (err) {
    addLog(state, `[实盘撤单] 查单失败 ${String(orderId).slice(-6)}: ${err.message} — 保留挂单`, 'warning');
    return { ok: false, reason: err.message, order };
  }
  if (order.status !== 'open') return { ok: true, order, alreadyClosed: true };

  let exchangeGone = false;
  try {
    const client = await getClient();
    await client.cancelOrder({ orderID: String(orderId) });
    exchangeGone = true;
  } catch (err) {
    const msg = String(err.message || err);
    if (/not found|already|canceled|cancelled/i.test(msg)) {
      exchangeGone = true;
    } else {
      order.cancelFailed = true;
      order.cancelError = msg.slice(0, 160);
      order.updatedAt = new Date().toISOString();
      addLog(state, `[实盘撤单失败] ${String(orderId).slice(-6)}: ${msg} — 保留本地跟踪`, 'warning');
      return { ok: false, reason: msg, order };
    }
  }

  if (!exchangeGone) return { ok: false, reason: 'exchange cancel uncertain', order };

  // Cancellation and matching race on the exchange. Confirm final size/status
  // before releasing reserve or allowing a replacement order.
  let final;
  try {
    final = await matchOneLiveOrder(state, order);
  } catch (err) {
    order.reconcilePending = true;
    order.reconcileError = String(err.message || err).slice(0, 160);
    order.updatedAt = new Date().toISOString();
    return { ok: false, reason: `post-cancel verify failed: ${err.message}`, order };
  }
  if (order.status === 'open') {
    order.reconcilePending = true;
    order.reconcileError = `post-cancel status ${String(final?.status || 'unknown')}`;
    order.updatedAt = new Date().toISOString();
    return { ok: false, reason: order.reconcileError, order };
  }
  order.cancelReason = order.cancelReason || reason;
  delete order.cancelFailed;
  delete order.cancelError;
  delete order.reconcilePending;
  delete order.reconcileError;
  return { ok: true, order };
}

async function cancelLiveOrdersForMarket(state, conditionId, reason = 'market done') {
  const list = liveOrdersForMarket(state, conditionId);
  if (!list.length) return { ok: true, cancelled: [], failed: [] };

  for (const o of list) {
    try { await matchOneLiveOrder(state, o); } catch (_) { /* best effort */ }
  }

  let marketCancelOk = false;
  try {
    const client = await getClient();
    await client.cancelMarketOrders({ market: String(conditionId) });
    marketCancelOk = true;
  } catch (_) {
    marketCancelOk = false;
  }

  const out = [];
  const failed = [];
  for (const o of [...list]) {
    if (o.status !== 'open') continue;
    if (marketCancelOk) {
      // Re-check fills after cancel (race: matched while cancelling)
      try {
        await matchOneLiveOrder(state, o);
      } catch (err) {
        o.reconcilePending = true;
        o.reconcileError = String(err.message || err).slice(0, 160);
        o.updatedAt = new Date().toISOString();
        failed.push({ order: o, reason: o.reconcileError });
        continue;
      }
      if (o.status !== 'open') {
        out.push(o);
        continue;
      }
      o.reconcilePending = true;
      o.reconcileError = 'post-market-cancel status still open';
      o.updatedAt = new Date().toISOString();
      failed.push({ order: o, reason: o.reconcileError });
    } else {
      const r = await cancelLiveOrder(state, o.id, reason);
      if (r.ok) out.push(o);
      else failed.push({ order: o, reason: r.reason || 'cancel failed' });
    }
  }
  pruneOrders(state);
  return { ok: failed.length === 0, cancelled: out, failed };
}

async function reconcileLiveOpenOrders(state) {
  ensureOrders(state);
  let adopted = 0;
  let closed = 0;
  let pending = 0;
  try {
    const client = await getClient();
    const remoteList = await client.getOpenOrders({}, true);
    const remoteIds = new Set(
      (remoteList || []).map((o) => String(o.id || o.order_id || o.orderID || '')).filter(Boolean)
    );

    for (const o of liveOrders(state)) {
      if (remoteIds.has(String(o.id))) continue;

      let matchResult = null;
      try {
        matchResult = await matchOneLiveOrder(state, o);
      } catch (err) {
        o.reconcilePending = true;
        o.reconcileError = String(err.message || err).slice(0, 160);
        o.updatedAt = new Date().toISOString();
        addLog(
          state,
          `[实盘对账] 查单失败 ${String(o.id).slice(-6)}: ${err.message} — 保留跟踪`,
          'warning'
        );
        pending += 1;
        continue;
      }

      if (o.status !== 'open') continue;
      if (remoteIds.has(String(o.id))) continue;

      const booked = Number(o.sizeMatchedBooked) || 0;
      const remoteMatched = parseSize(matchResult?.matched);
      if (remoteMatched > booked + 1e-12) {
        pending += 1;
        addLog(
          state,
          `[实盘对账] 订单 ${String(o.id).slice(-6)} 有未入账成交，暂不收口`,
          'warning'
        );
        continue;
      }

      const st = String(matchResult?.status || '').toUpperCase();
      if (st.includes('LIVE') || st.includes('OPEN')) {
        pending += 1;
        continue;
      }

      releaseReserve(state, o, o.reservedUsdc);
      o.status = o.filled > 0 || booked > 0 ? 'filled' : 'cancelled';
      o.cancelReason = o.cancelReason || 'reconcile: not on exchange';
      o.remaining = 0;
      o.updatedAt = new Date().toISOString();
      delete o.reconcilePending;
      delete o.reconcileError;
      closed += 1;
    }

    for (const remote of remoteList || []) {
      const id = String(remote.id || remote.order_id || remote.orderID || '');
      if (!id) continue;
      if (state.open_orders.some((o) => String(o.id) === id)) continue;
      const tokenId = String(remote.asset_id || remote.token_id || remote.tokenID || '');
      const side = String(remote.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      if (side !== 'BUY') continue;

      let market = null;
      for (const pos of Object.values(state.positions || {})) {
        if (String(pos.upTokenId) === tokenId || String(pos.downTokenId) === tokenId) {
          market = pos;
          break;
        }
      }
      // Fresh pair may post before any fill → no position yet. Match via tracked orders.
      if (!market) {
        for (const o of state.open_orders || []) {
          if (String(o.tokenId) === tokenId || String(o.upTokenId) === tokenId || String(o.downTokenId) === tokenId) {
            market = {
              conditionId: o.conditionId,
              slug: o.slug,
              title: o.title,
              windowStart: o.windowStart,
              windowEnd: o.windowEnd,
              upTokenId: o.upTokenId,
              downTokenId: o.downTokenId,
            };
            break;
          }
        }
      }

      if (!market) {
        // Never auto-cancel unknown BUYs — mid-flight pair legs look "orphan" before trackLiveOrder.
        addLog(
          state,
          `[实盘对账] 未识别挂单保留 id=${id.slice(-6)} token=${tokenId.slice(-6)}（不自动撤）`,
          'warning'
        );
        continue;
      }

      const outcome = String(market.upTokenId) === tokenId ? 'Up' : 'Down';
      const limit = tickRound(remote.price);
      const size = parseSize(remote.original_size || remote.size);
      const matched = parseSize(remote.size_matched);
      if (!(limit > 0) || !(size > 0)) continue;

      const stub = marketFromPos(market);
      const hasPairContext = liveOrdersForMarket(state, stub.conditionId).some((o) => o.paired)
        || (Number(market.upShares) > 1e-8 && Number(market.downShares) > 1e-8);

      const tracked = trackLiveOrder(state, {
        market: stub,
        side: outcome,
        tokenId,
        shares: size,
        limitPrice: limit,
        orderId: id,
        quoteMode: 'maker',
        paired: hasPairContext,
        sizeMatched: matched,
      });
      if (tracked.ok) {
        adopted += 1;
        addLog(state, `[实盘对账] 接管挂单 ${outcome} ${size}@$${limit} id=${id.slice(-6)}`, 'warning');
      }
    }
  } catch (err) {
    addLog(state, `[实盘对账] 失败: ${err.message}`, 'warning');
    return { ok: false, error: err.message, adopted, closed, pending };
  }
  if (adopted || closed || pending) saveState(state);
  return { ok: true, adopted, closed, pending };
}

async function placeLiveSell(tokenId, shares, limitPrice, orderType = 'FAK') {
  const client = await getClient();
  const { Side, OrderType } = require('@polymarket/clob-client-v2');
  const limit = Math.max(0.01, Math.min(0.99, Number(limitPrice) || 0));
  const size = rnd(Number(shares), 4);
  if (!(size > 0)) throw new Error('zero sell size');
  const type =
    orderType === 'GTC' ? OrderType.GTC
      : orderType === 'FOK' ? OrderType.FOK
        : OrderType.FAK;
  const resp = await client.createAndPostOrder(
    {
      tokenID: String(tokenId),
      price: limit,
      size,
      side: Side.SELL,
    },
    { tickSize: '0.01' },
    type
  );
  if (!resp || resp.success === false) {
    throw new Error(resp?.errorMsg || resp?.error || resp?.message || 'sell rejected');
  }
  return resp;
}

function bookLiveSellFill(state, market, side, matched, px, takingAmount = null) {
  const pos = state.positions[market.conditionId];
  if (!pos || !(matched > 0)) return { ok: false, reason: 'no fill' };
  const params = loadParams();
  const feeRate = feeRateFor(params, 'taker');
  const sellCash = withTakerFeeCash(
    'SELL',
    matched,
    px,
    takingAmount != null && takingAmount > 0 ? takingAmount : null,
    feeRate
  );
  const proceeds = sellCash.proceeds ?? sellCash.usdc;
  state.cash_usdc = rnd((Number(state.cash_usdc) || 0) + proceeds, 4);
  let costCut = 0;
  if (side === 'Up') {
    const costPer = (Number(pos.upCost) || 0) / Math.max(Number(pos.upShares) || matched, matched);
    costCut = rnd(costPer * matched, 4);
    pos.upShares = rnd(Math.max(0, (Number(pos.upShares) || 0) - matched), 6);
    pos.upCost = rnd(Math.max(0, (Number(pos.upCost) || 0) - costCut), 4);
  } else {
    const costPer = (Number(pos.downCost) || 0) / Math.max(Number(pos.downShares) || matched, matched);
    costCut = rnd(costPer * matched, 4);
    pos.downShares = rnd(Math.max(0, (Number(pos.downShares) || 0) - matched), 6);
    pos.downCost = rnd(Math.max(0, (Number(pos.downCost) || 0) - costCut), 4);
  }
  pos.investedUsdc = rnd((Number(pos.upCost) || 0) + (Number(pos.downCost) || 0), 4);
  recordWindowRealized(state, pos, proceeds, costCut);
  addLog(
    state,
    `[实盘平仓] SELL ${side} ${matched} @ $${px} (fee $${sellCash.fee}; proceeds $${proceeds})`,
    'warning'
  );
  return { ok: true, matched, proceeds, costCut };
}

function trackLiveSellOrder(state, {
  market,
  side,
  tokenId,
  shares,
  limitPrice,
  orderId,
  sizeMatched = 0,
}) {
  ensureOrders(state);
  const id = extractOrderId({ orderID: orderId }) || String(orderId || '');
  if (!id) return { ok: false, reason: 'missing sell order id' };

  const limit = tickRound(limitPrice);
  const size = rnd(Number(shares), 6);
  const matched = parseSize(sizeMatched);
  const order = {
    id,
    live: true,
    status: matched >= size - 1e-8 ? 'filled' : 'open',
    side: 'SELL',
    outcome: side,
    tokenId: String(tokenId),
    conditionId: market.conditionId,
    slug: market.slug,
    title: market.title,
    windowStart: market.windowStart,
    windowEnd: market.windowEnd,
    upTokenId: market.upTokenId,
    downTokenId: market.downTokenId,
    limit,
    originalSize: size,
    remaining: rnd(Math.max(0, size - matched), 6),
    filled: matched,
    sizeMatchedBooked: matched,
    reservedUsdc: 0,
    quoteMode: 'maker',
    paired: false,
    unwind: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.open_orders.push(order);
  return { ok: true, order };
}

function bookSellFillFromResponse(state, market, side, resp, px) {
  const matched = parseSellMatched(resp);
  if (!(matched > 0)) return { ok: false, matched: 0 };
  const taking = parseUsdc(resp.takingAmount);
  const fillPx = Number(resp.average_price || resp.price || px);
  return bookLiveSellFill(state, market, side, matched, fillPx, taking);
}

/** Taker-buy missing leg to complete orphan pair before unwind. */
async function tryTakerHedgeMissingLeg(state, market, heldSide) {
  const pos = state.positions[market.conditionId];
  if (!pos) return { ok: false, reason: 'no position' };

  const params = loadParams();
  const upSh = Number(pos.upShares) || 0;
  const downSh = Number(pos.downShares) || 0;
  let missingSide;
  let needSh;

  if (heldSide === 'Up' && upSh > 1e-8 && downSh <= 1e-8) {
    missingSide = 'Down';
    needSh = rnd(upSh, 4);
  } else if (heldSide === 'Down' && downSh > 1e-8 && upSh <= 1e-8) {
    missingSide = 'Up';
    needSh = rnd(downSh, 4);
  } else {
    return { ok: false, reason: 'not orphan' };
  }

  const minSh = Math.max(Number(params.min_order_shares) || 5, 1);
  const chunk = Math.max(Number(params.share_chunk) || minSh, minSh);
  const maxMarket = Number(params.max_market_usdc) || 10;
  const maxTrade = Number(params.max_trade_usdc) || 5;
  const invested = rnd((Number(pos.upCost) || 0) + (Number(pos.downCost) || 0), 4);
  // Lifetime window buys (survives activity zeroing cost basis) — hard budget
  const windowSpent = rnd(Math.max(invested, Number(pos.windowBuyUsdc) || 0), 4);
  const room = rnd(Math.max(0, maxMarket - windowSpent), 4);
  const hedgeAttempts = Number(pos.takerHedgeAttempts) || 0;

  // At most one taker-hedge attempt per window — then unwind only
  if (hedgeAttempts >= 1) {
    addLog(
      state,
      `[实盘补腿] 跳过 ${missingSide} · 本窗已补腿 ${hedgeAttempts} 次，改为平仓`,
      'warning'
    );
    return { ok: false, reason: 'hedge attempt exhausted', missingSide, hedgeAttempts };
  }

  // Hard stop: already at/over per-window budget → unwind, do not pile on
  if (room < 0.05) {
    addLog(
      state,
      `[实盘补腿] 跳过 ${missingSide} · 已达 max_market $${maxMarket}` +
        ` (spent $${windowSpent.toFixed(2)} / invested $${invested.toFixed(2)})`,
      'warning'
    );
    const { setPairRiskLock } = require('./pair_risk');
    setPairRiskLock(pos, 'max market usdc');
    return { ok: false, reason: 'max market usdc', missingSide, invested: windowSpent, maxMarket };
  }

  if (needSh + 1e-9 < minSh) {
    return { ok: false, reason: 'shares below min', needSh };
  }

  const { getBestAsk } = require('./book');
  const tokenId = missingSide === 'Up' ? market.upTokenId : market.downTokenId;
  const ask = await getBestAsk(tokenId);
  if (!ask || !(ask.price > 0)) {
    return { ok: false, reason: 'no ask', missingSide };
  }

  const costCheck = canTakerHedgePairCost(heldSide, pos, ask.price, params);
  if (!costCheck.ok) {
    addLog(
      state,
      `[实盘补腿] 跳过 ${missingSide} @ $${ask.price} · ${costCheck.reason}` +
        (costCheck.completeSum != null
          ? ` pairCost≈${Number(costCheck.completeSum).toFixed(4)} > max ${costCheck.maxSum}+${Number(costCheck.buffer).toFixed(3)}`
          : ''),
      'warning'
    );
    return { ok: false, ...costCheck, missingSide, pairCost: costCheck.completeSum };
  }

  // Cap: one chunk, trade cap, market room — never mirror a bloated inventory (e.g. 30 sh)
  const px = Number(ask.price);
  const maxByTrade = px > 0 ? maxTrade / px : chunk;
  const maxByRoom = px > 0 ? room / px : chunk;
  const size = rnd(
    Math.min(needSh, chunk, maxByTrade, maxByRoom, Number(ask.size) || needSh),
    4
  );
  if (size + 1e-9 < minSh) {
    addLog(
      state,
      `[实盘补腿] 跳过 ${missingSide} · 预算不足 size=${size.toFixed(2)} < min ${minSh}` +
        ` (room $${room.toFixed(2)})`,
      'warning'
    );
    return { ok: false, reason: 'max market usdc', missingSide, size, room };
  }
  if (!(size > 0)) return { ok: false, reason: 'zero size', missingSide };

  const { placeLiveTakerBuy } = require('./executor');
  try {
    pos.takerHedgeAttempts = hedgeAttempts + 1;
    const resp = await placeLiveTakerBuy(tokenId, size, ask.price);
    const orderId = extractOrderId(resp);
    const matched = parseBuyMatchedFromResponse(resp);
    const making = parseUsdc(resp.makingAmount);
    const tracked = trackLiveOrder(state, {
      market,
      side: missingSide,
      tokenId,
      shares: size,
      limitPrice: ask.price,
      orderId,
      quoteMode: 'taker',
      paired: true,
      plannedPrice: ask.price,
      marketAsk: ask.price,
      sizeMatched: matched,
      makingAmount: making,
    });
    if (!tracked.ok && matched <= 0) {
      return { ok: false, reason: tracked.reason || 'track failed', missingSide };
    }
    if (matched <= 0 && orderId) {
      const booked = state.open_orders.find((o) => o.id === String(orderId));
      if (booked) await matchOneLiveOrder(state, booked).catch(() => null);
    }
    const afterUp = Number(state.positions[market.conditionId]?.upShares) || 0;
    const afterDown = Number(state.positions[market.conditionId]?.downShares) || 0;
    const hedged =
      afterUp > 1e-8 && afterDown > 1e-8
      && Math.abs(afterUp - afterDown) < minSh;
    if (matched > 0 || hedged) {
      addLog(
        state,
        `[实盘补腿] TAKER BUY ${missingSide} ${matched || size} @ $${ask.price}` +
          ` · pairCost≈${Number(costCheck.completeSum).toFixed(4)} · ${market.slug}`,
        hedged ? 'success' : 'warning'
      );
    }
    return {
      ok: matched > 0 || hedged,
      matched,
      hedged,
      missingSide,
      pairCost: costCheck.completeSum,
    };
  } catch (err) {
    addLog(state, `[实盘补腿失败] ${missingSide}: ${err.message}`, 'warning');
    return { ok: false, error: err.message, missingSide };
  }
}

async function tryUnwindLeg(state, market, side, shares, opts = {}) {
  const dump = Boolean(opts.dump);
  try {
    const { getBestBid } = require('./book');
    const params = loadParams();
    const tokenId = side === 'Up' ? market.upTokenId : market.downTokenId;
    let bid = await getBestBid(tokenId);
    if (!bid || !(bid.price > 0)) {
      if (!dump) return { ok: false, reason: 'no bid', remaining: shares };
      // Window-end salvage: no bid left — still try floor FAK
      bid = { price: 0.01, size: Number(shares) || 0 };
      addLog(state, `[实盘平仓] ${side} 无 bid · dump @ $0.01`, 'warning');
    }

    const floor = 0.01;
    const slippage = Math.max(0, Number(params.slippage_limit) || 0.05);
    const maxTicks = dump
      ? Math.max(0, Math.round((Number(bid.price) - floor) / 0.01))
      : Math.max(0, Math.min(10, Math.ceil(slippage / 0.01)));
    let remaining = rnd(Number(shares) || 0, 6);
    let totalMatched = 0;

    if (remaining > 1e-8) {
      try {
        const resp = await placeLiveSell(tokenId, remaining, bid.price, 'FOK');
        const fill = bookSellFillFromResponse(state, market, side, resp, bid.price);
        if (fill.ok && fill.matched > 0) {
          totalMatched = rnd(totalMatched + fill.matched, 6);
          remaining = rnd(Math.max(0, remaining - fill.matched), 6);
        }
      } catch (err) {
        addLog(state, `[实盘平仓失败] FOK ${side} @ $${bid.price}: ${err.message}`, 'warning');
      }
    }

    for (let tick = 0; tick <= maxTicks && remaining > 1e-8; tick++) {
      const px = rnd(Math.max(floor, Number(bid.price) - tick * 0.01), 4);
      try {
        const resp = await placeLiveSell(tokenId, remaining, px, 'FAK');
        const fill = bookSellFillFromResponse(state, market, side, resp, px);
        if (fill.ok && fill.matched > 0) {
          totalMatched = rnd(totalMatched + fill.matched, 6);
          remaining = rnd(Math.max(0, remaining - fill.matched), 6);
        }
        if (remaining <= 1e-8) break;
      } catch (err) {
        if (tick === 0) {
          addLog(state, `[实盘平仓失败] ${side} @ $${px}: ${err.message}`, 'warning');
        }
      }
    }

    // Dump: final FAK at floor before giving up (skip passive GTC that won't fill)
    if (dump && remaining > 1e-8) {
      try {
        const resp = await placeLiveSell(tokenId, remaining, floor, 'FAK');
        const fill = bookSellFillFromResponse(state, market, side, resp, floor);
        if (fill.ok && fill.matched > 0) {
          totalMatched = rnd(totalMatched + fill.matched, 6);
          remaining = rnd(Math.max(0, remaining - fill.matched), 6);
        }
      } catch (err) {
        addLog(state, `[实盘平仓失败] dump FAK ${side} @ $${floor}: ${err.message}`, 'warning');
      }
    }

    if (!dump && remaining > 1e-8) {
      try {
        const resp = await placeLiveSell(tokenId, remaining, bid.price, 'GTC');
        const orderId = extractOrderId(resp);
        const fill = bookSellFillFromResponse(state, market, side, resp, bid.price);
        if (fill.ok && fill.matched > 0) {
          totalMatched = rnd(totalMatched + fill.matched, 6);
          remaining = rnd(Math.max(0, remaining - fill.matched), 6);
        }
        if (remaining > 1e-8) {
          if (orderId) {
            trackLiveSellOrder(state, {
              market,
              side,
              tokenId,
              shares: remaining,
              limitPrice: bid.price,
              orderId,
              sizeMatched: 0,
            });
            addLog(
              state,
              `[实盘平仓] GTC SELL ${side} ${remaining} @ $${bid.price} 已挂出 id=${orderId.slice(-6)}`,
              'info'
            );
          } else {
            addLog(
              state,
              `[实盘平仓] GTC 无 order id · 改 FAK ${side} ${remaining} @ $${bid.price}`,
              'warning'
            );
            try {
              const fak = await placeLiveSell(tokenId, remaining, bid.price, 'FAK');
              const fakFill = bookSellFillFromResponse(state, market, side, fak, bid.price);
              if (fakFill.ok && fakFill.matched > 0) {
                totalMatched = rnd(totalMatched + fakFill.matched, 6);
                remaining = rnd(Math.max(0, remaining - fakFill.matched), 6);
              }
            } catch (err) {
              addLog(state, `[实盘平仓失败] GTC→FAK ${side}: ${err.message}`, 'warning');
            }
          }
        }
      } catch (err) {
        addLog(state, `[实盘平仓失败] ${side} GTC: ${err.message}`, 'warning');
      }
    }

    return {
      ok: totalMatched > 0,
      matched: totalMatched,
      remaining,
      fullyClosed: remaining <= 1e-8,
      dump,
    };
  } catch (err) {
    addLog(state, `[实盘平仓失败] ${side}: ${err.message}`, 'warning');
    return { ok: false, error: err.message, remaining: shares, fullyClosed: false, dump };
  }
}

async function tryUnwindLegAll(state, market, side, shares, opts = {}) {
  let remaining = rnd(Number(shares) || 0, 6);
  let totalMatched = 0;
  const rounds = Math.max(1, UNWIND_MAX_ROUNDS);
  const dump = Boolean(opts.dump);

  for (let i = 0; i < rounds && remaining > 1e-8; i++) {
    const r = await tryUnwindLeg(state, market, side, remaining, { dump });
    totalMatched = rnd(totalMatched + (Number(r.matched) || 0), 6);
    remaining = rnd(Number(r.remaining) || 0, 6);
    if (r.fullyClosed || remaining <= 1e-8) {
      return { ok: true, matched: totalMatched, remaining: 0, fullyClosed: true, dump };
    }
    if (!(Number(r.matched) > 0)) break;
  }

  return {
    ok: totalMatched > 0,
    matched: totalMatched,
    remaining,
    fullyClosed: remaining <= 1e-8,
    dump,
  };
}

async function cancelRiskOrdersOrBreak(state, market, reason, result = {}) {
  const cancelled = await cancelLiveOrdersForMarket(state, market.conditionId, reason);
  if (cancelled?.ok) return true;
  tripLiveCircuitBreaker(state, market, {
    reason: `${reason} · cancel unconfirmed`,
    remaining: Number(result.remaining) || cancelled?.failed?.length || 1,
    side: result.side || null,
  });
  addLog(
    state,
    `[实盘风控] ${reason} · 撤单状态未确认，停止后续补腿/平仓`,
    'error'
  );
  return false;
}

function orphanLossAtBid(pos, heldSide, bidPrice, params = loadParams()) {
  const shares = heldSide === 'Up' ? Number(pos?.upShares) || 0 : Number(pos?.downShares) || 0;
  const cost = heldSide === 'Up' ? Number(pos?.upCost) || 0 : Number(pos?.downCost) || 0;
  const bid = Number(bidPrice);
  const threshold = Number(params.max_orphan_loss_usdc);
  if (!(shares > 0) || !(cost > 0) || !(bid > 0) || !(threshold > 0)) {
    return { exceeded: false, loss: 0, threshold, shares, bid: Number.isFinite(bid) ? bid : null };
  }
  const feeRate = Number(params.taker_fee_rate);
  const proceeds = withTakerFeeCash(
    'SELL',
    shares,
    bid,
    null,
    Number.isFinite(feeRate) && feeRate >= 0 ? feeRate : undefined
  ).proceeds;
  const loss = rnd(Math.max(0, cost - proceeds), 4);
  return { exceeded: loss >= threshold - 1e-9, loss, threshold, shares, bid, proceeds, cost };
}

async function evaluateOrphanLoss(pos, heldSide, market, params = loadParams()) {
  const { getBestBid } = require('./book');
  const tokenId = heldSide === 'Up' ? market.upTokenId : market.downTokenId;
  try {
    const bid = await getBestBid(tokenId);
    return orphanLossAtBid(pos, heldSide, bid?.price, params);
  } catch (_) {
    return { exceeded: false, loss: 0, threshold: Number(params.max_orphan_loss_usdc) };
  }
}

async function auditMarketPairExposure(state, market, nowSec = Math.floor(Date.now() / 1000), depth = 0) {
  const open = liveOrdersForMarket(state, market.conditionId);
  const pos = state.positions[market.conditionId];
  const upSh = Number(pos?.upShares) || 0;
  const downSh = Number(pos?.downShares) || 0;
  const hasUpRest = open.some((o) => o.outcome === 'Up' && String(o.side || 'BUY').toUpperCase() === 'BUY');
  const hasDownRest = open.some((o) => o.outcome === 'Down' && String(o.side || 'BUY').toUpperCase() === 'BUY');
  // Inventory-only: resting on the missing leg is NOT a completed hedge
  const invUp = upSh > 1e-8;
  const invDown = downSh > 1e-8;

  if (!invUp && !invDown && !hasUpRest && !hasDownRest) return { hedged: false, ok: true };

  const missingSide = invUp && !invDown ? 'Down' : invDown && !invUp ? 'Up' : null;
  const restAge = missingSide != null ? hedgeRestAgeSec(open, missingSide, nowSec) : null;

  const defer = shouldDeferOrphanUnwind({
    upSh,
    downSh,
    hasUpRest,
    hasDownRest,
    windowStart: market.windowStart ?? pos?.windowStart,
    windowEnd: market.windowEnd ?? pos?.windowEnd,
    nowSec,
    hedgeRestAgeSec: restAge,
  });

  const windowEnd = market.windowEnd ?? pos?.windowEnd;
  const orphanDetectedAtMs = pos?.orphanDetectedAt ? Date.parse(pos.orphanDetectedAt) : null;
  const orphanAgeSec =
    Number.isFinite(orphanDetectedAtMs) && orphanDetectedAtMs > 0
      ? Math.max(0, nowSec - orphanDetectedAtMs / 1000)
      : null;

  if (pos && invUp && !invDown) {
    if (!pos.orphanDetectedAt) pos.orphanDetectedAt = new Date(nowSec * 1000).toISOString();
  } else if (pos && invDown && !invUp) {
    if (!pos.orphanDetectedAt) pos.orphanDetectedAt = new Date(nowSec * 1000).toISOString();
  } else if (pos?.orphanDetectedAt && invUp && invDown) {
    delete pos.orphanDetectedAt;
  } else if (pos?.orphanDetectedAt && !invUp && !invDown) {
    delete pos.orphanDetectedAt;
  }

  if (invUp && !invDown) {
    const lossGate = await evaluateOrphanLoss(pos, 'Up', market);
    const lossDump = shouldAllowOrphanLossDump({
      lossExceeded: lossGate.exceeded,
      defer,
      hasMissingRest: hasDownRest,
      restAge,
      windowEnd,
      nowSec,
      orphanAgeSec,
    });
    if (lossGate.exceeded && !lossDump.allowed) {
      addLog(
        state,
        `[实盘止损] 单边 Up 浮亏 $${lossGate.loss.toFixed(2)} ≥ $${lossGate.threshold.toFixed(2)}` +
          ` · 暂缓强平 (${lossDump.reason || 'hedge rest'}) · ${market.slug}`,
        'info'
      );
    } else if (lossGate.exceeded) {
      addLog(
        state,
        `[实盘止损] 单边 Up 浮亏 $${lossGate.loss.toFixed(2)} ≥ $${lossGate.threshold.toFixed(2)} · ${market.slug}`,
        'warning'
      );
    }
    if (hasDownRest && defer.defer && !lossDump.allowed) {
      return { hedged: false, ok: true, reason: defer.reason || 'Down hedge resting' };
    }
    if (hasDownRest && (defer.force || lossDump.allowed)) {
      const ok = await cancelRiskOrdersOrBreak(
        state,
        market,
        'pair audit: force cancel Down rest',
        { remaining: upSh, side: 'Up' }
      );
      if (!ok) return { hedged: false, ok: false, reason: 'cancel unconfirmed', unwindFailed: true };
    }
    const hedge = await tryTakerHedgeMissingLeg(state, market, 'Up');
    if (hedge.hedged) {
      if (pos) clearPairInflight(pos);
      return { hedged: true, ok: true, reason: 'taker hedge Down', hedgeOk: true };
    }
    if (Number(hedge.matched) > 0) {
      if (depth >= 1) {
        return { hedged: false, ok: true, reason: 'partial hedge · await next scan', matched: hedge.matched };
      }
      return auditMarketPairExposure(state, market, nowSec, depth + 1);
    }
    const forceUnwind =
      hedge.reason === 'max market usdc' ||
      hedge.reason === 'hedge attempt exhausted' ||
      lossDump.allowed ||
      Boolean(defer.force) ||
      (hedge.reason === 'pair cost too high' && !defer.defer);
    if (defer.defer && !forceUnwind) {
      if (pos) setPairInflight(pos, 'orphan grace');
      return { hedged: false, ok: true, reason: defer.reason || 'awaiting Down hedge' };
    }
    if (!await cancelRiskOrdersOrBreak(
      state,
      market,
      'pair audit: missing Down',
      { remaining: upSh, side: 'Up' }
    )) return { hedged: false, ok: false, reason: 'cancel unconfirmed', unwindFailed: true };
    if (pos) setPairInflight(pos, 'unwind pending');
    let unwind = { fullyClosed: upSh <= 1e-8, remaining: upSh };
    if (upSh > 1e-8) {
      const dumpUnwind = Boolean(defer.force || lossDump.allowed);
      unwind = await tryUnwindLegAll(state, market, 'Up', upSh, { dump: dumpUnwind });
    }
    if (!unwind.fullyClosed && (Number(unwind.remaining) || 0) > 1e-8) {
      if (pos) {
        setPairRiskLock(pos, 'missing Down · unwind failed');
        setPairInflight(pos, 'unwind pending');
      }
      addLog(
        state,
        `[实盘风控] 配对缺 Down · ${market.slug} · Up 未平尽 rem=${Number(unwind.remaining).toFixed(2)} — 下轮重试`,
        'error'
      );
      tripLiveCircuitBreaker(state, market, {
        reason: 'missing Down · unwind failed',
        remaining: unwind.remaining,
        side: 'Up',
      });
      return {
        hedged: false,
        ok: false,
        reason: 'missing Down',
        unwindFailed: true,
        remaining: unwind.remaining,
        side: 'Up',
      };
    }
    if (pos && (Number(pos.upShares) || 0) <= 1e-8 && (Number(pos.downShares) || 0) <= 1e-8) {
      clearPairRiskLock(pos);
      clearPairInflight(pos);
    }
    addLog(
      state,
      `[实盘风控] 配对缺 Down 已处理 · ${market.slug}` +
        (defer.force
          ? ` · ${defer.reason === 'hedge rest timeout' ? '对冲挂单超时强制平仓' : '窗口末强制平仓'}`
          : forceUnwind
            ? lossDump.allowed
              ? ' · 浮亏止损强制平仓'
              : ' · 补腿成本过高强制平仓'
            : ''),
      'warning'
    );
    return { hedged: true, ok: true, reason: 'missing Down', unwindOk: true };
  }

  if (invDown && !invUp) {
    const lossGate = await evaluateOrphanLoss(pos, 'Down', market);
    const lossDump = shouldAllowOrphanLossDump({
      lossExceeded: lossGate.exceeded,
      defer,
      hasMissingRest: hasUpRest,
      restAge,
      windowEnd,
      nowSec,
      orphanAgeSec,
    });
    if (lossGate.exceeded && !lossDump.allowed) {
      addLog(
        state,
        `[实盘止损] 单边 Down 浮亏 $${lossGate.loss.toFixed(2)} ≥ $${lossGate.threshold.toFixed(2)}` +
          ` · 暂缓强平 (${lossDump.reason || 'hedge rest'}) · ${market.slug}`,
        'info'
      );
    } else if (lossGate.exceeded) {
      addLog(
        state,
        `[实盘止损] 单边 Down 浮亏 $${lossGate.loss.toFixed(2)} ≥ $${lossGate.threshold.toFixed(2)} · ${market.slug}`,
        'warning'
      );
    }
    if (hasUpRest && defer.defer && !lossDump.allowed) {
      return { hedged: false, ok: true, reason: defer.reason || 'Up hedge resting' };
    }
    if (hasUpRest && (defer.force || lossDump.allowed)) {
      const ok = await cancelRiskOrdersOrBreak(
        state,
        market,
        'pair audit: force cancel Up rest',
        { remaining: downSh, side: 'Down' }
      );
      if (!ok) return { hedged: false, ok: false, reason: 'cancel unconfirmed', unwindFailed: true };
    }
    const hedge = await tryTakerHedgeMissingLeg(state, market, 'Down');
    if (hedge.hedged) {
      if (pos) clearPairInflight(pos);
      return { hedged: true, ok: true, reason: 'taker hedge Up', hedgeOk: true };
    }
    if (Number(hedge.matched) > 0) {
      if (depth >= 1) {
        return { hedged: false, ok: true, reason: 'partial hedge · await next scan', matched: hedge.matched };
      }
      return auditMarketPairExposure(state, market, nowSec, depth + 1);
    }
    const forceUnwind =
      hedge.reason === 'max market usdc' ||
      hedge.reason === 'hedge attempt exhausted' ||
      lossDump.allowed ||
      Boolean(defer.force) ||
      (hedge.reason === 'pair cost too high' && !defer.defer);
    if (defer.defer && !forceUnwind) {
      if (pos) setPairInflight(pos, 'orphan grace');
      return { hedged: false, ok: true, reason: defer.reason || 'awaiting Up hedge' };
    }
    if (!await cancelRiskOrdersOrBreak(
      state,
      market,
      'pair audit: missing Up',
      { remaining: downSh, side: 'Down' }
    )) return { hedged: false, ok: false, reason: 'cancel unconfirmed', unwindFailed: true };
    if (pos) setPairInflight(pos, 'unwind pending');
    let unwind = { fullyClosed: downSh <= 1e-8, remaining: downSh };
    if (downSh > 1e-8) {
      const dumpUnwind = Boolean(defer.force || lossDump.allowed);
      unwind = await tryUnwindLegAll(state, market, 'Down', downSh, { dump: dumpUnwind });
    }
    if (!unwind.fullyClosed && (Number(unwind.remaining) || 0) > 1e-8) {
      if (pos) {
        setPairRiskLock(pos, 'missing Up · unwind failed');
        setPairInflight(pos, 'unwind pending');
      }
      addLog(
        state,
        `[实盘风控] 配对缺 Up · ${market.slug} · Down 未平尽 rem=${Number(unwind.remaining).toFixed(2)} — 下轮重试`,
        'error'
      );
      tripLiveCircuitBreaker(state, market, {
        reason: 'missing Up · unwind failed',
        remaining: unwind.remaining,
        side: 'Down',
      });
      return {
        hedged: false,
        ok: false,
        reason: 'missing Up',
        unwindFailed: true,
        remaining: unwind.remaining,
        side: 'Down',
      };
    }
    if (pos && (Number(pos.upShares) || 0) <= 1e-8 && (Number(pos.downShares) || 0) <= 1e-8) {
      clearPairRiskLock(pos);
      clearPairInflight(pos);
    }
    addLog(
      state,
      `[实盘风控] 配对缺 Up 已处理 · ${market.slug}` +
        (defer.force
          ? ` · ${defer.reason === 'hedge rest timeout' ? '对冲挂单超时强制平仓' : '窗口末强制平仓'}`
          : forceUnwind
            ? lossDump.allowed
              ? ' · 浮亏止损强制平仓'
              : ' · 补腿成本过高强制平仓'
            : ''),
      'warning'
    );
    return { hedged: true, ok: true, reason: 'missing Up', unwindOk: true };
  }

  // Both inventory legs (or empty inventory with only rests — skip cost path)
  if (!(invUp && invDown)) {
    return { hedged: false, ok: true };
  }

  const costCheck = validatePairedPositionCost(state, market);
  if (!costCheck.ok) {
    addLog(
      state,
      `[实盘风控] 配对成本过高 ${market.slug}: pairCost=${Number(costCheck.pairCost).toFixed(4)} > max ${costCheck.maxSum} + buffer`,
      'warning'
    );
    if (pos) {
      setPairRiskLock(pos, 'pair cost too high');
      setPairInflight(pos, 'unwind pending');
    }
    if (!await cancelRiskOrdersOrBreak(
      state,
      market,
      'pair audit: cost too high',
      { remaining: Math.max(upSh, downSh), side: upSh >= downSh ? 'Up' : 'Down' }
    )) return { hedged: false, ok: false, reason: 'cancel unconfirmed', unwindFailed: true };
    if (upSh > 1e-8) await tryUnwindLegAll(state, market, 'Up', upSh, { dump: true });
    if (downSh > 1e-8) await tryUnwindLegAll(state, market, 'Down', downSh, { dump: true });
    const remUp = Number(state.positions[market.conditionId]?.upShares) || 0;
    const remDown = Number(state.positions[market.conditionId]?.downShares) || 0;
    if (remUp > 1e-8 || remDown > 1e-8) {
      const locked = state.positions[market.conditionId];
      if (locked) {
        setPairRiskLock(locked, 'pair cost too high · unwind failed');
        setPairInflight(locked, 'unwind pending');
      }
      tripLiveCircuitBreaker(state, market, {
        reason: 'pair cost too high · unwind failed',
        remaining: Math.max(remUp, remDown),
        side: remUp >= remDown ? 'Up' : 'Down',
      });
      return { hedged: false, ok: false, reason: 'pair cost too high', unwindFailed: true };
    }
    if (pos) {
      clearPairRiskLock(pos);
      clearPairInflight(pos);
    }
    return { hedged: true, ok: true, reason: 'pair cost too high' };
  }

  if (pos) {
    const costOk = validatePairedPositionCost(state, market);
    if (costOk.ok && (upSh <= 1e-8 && downSh <= 1e-8)) clearPairRiskLock(pos);
    else if (costOk.ok && upSh > 1e-8 && downSh > 1e-8) clearPairRiskLock(pos);
    maybeClearPairInflight(pos, open);
  }

  const params = loadParams();
  const minSkew = Math.max(Number(params.min_order_shares) || 5, 1);
  const skew = Math.abs(upSh - downSh);
  const skewPlan = skewCancelPlan(upSh, downSh, open);
  if (!skewPlan.skip && skewPlan.skew >= minSkew) {
    let skewCancelFailed = false;
    for (const o of skewPlan.cancel) {
      const result = await cancelLiveOrder(state, o.id, 'pair audit: size skew');
      if (!result.ok) skewCancelFailed = true;
    }
    if (skewCancelFailed) {
      tripLiveCircuitBreaker(state, market, {
        reason: 'size skew · cancel unconfirmed',
        remaining: skew,
        side: skewPlan.longSide,
      });
      return { hedged: false, ok: false, reason: 'cancel unconfirmed', unwindFailed: true };
    }
    if (skewPlan.cancel.length) {
      addLog(
        state,
        `[实盘风控] 份额失衡 Up=${upSh} Down=${downSh}，已撤 ${skewPlan.longSide} 挂单 · ${market.slug}`,
        'warning'
      );
    }
  }

  // Excess inventory with both legs: dump long excess when rebalance can't finish
  // or window is ending (partial hedge left 10/5 style naked exposure).
  if (skew >= minSkew - 1e-9) {
    const longSide = upSh > downSh ? 'Up' : 'Down';
    const excess = rnd(skew, 6);
    const end = Number(market.windowEnd ?? pos?.windowEnd) || 0;
    const forceBefore = orphanForceBeforeEndSec(params);
    const nearEnd = end > 0 && nowSec >= end - forceBefore;
    const roundsGate = pairRoundsBlocked(upSh, downSh, params);
    const hedgeBurned = Number(pos?.takerHedgeAttempts) || 0;
    const shouldDump =
      nearEnd || roundsGate.blocked || hedgeBurned >= 1;
    if (shouldDump && excess + 1e-9 >= minSkew) {
      if (pos) setPairInflight(pos, 'unwind pending');
      const unwind = await tryUnwindLegAll(state, market, longSide, excess, {
        dump: nearEnd || roundsGate.blocked,
      });
      const remLong =
        longSide === 'Up'
          ? Number(state.positions[market.conditionId]?.upShares) || 0
          : Number(state.positions[market.conditionId]?.downShares) || 0;
      const remShort =
        longSide === 'Up'
          ? Number(state.positions[market.conditionId]?.downShares) || 0
          : Number(state.positions[market.conditionId]?.upShares) || 0;
      if (!unwind.fullyClosed && Math.abs(remLong - remShort) >= minSkew - 1e-9) {
        if (pos) {
          setPairRiskLock(pos, 'size skew · unwind failed');
          setPairInflight(pos, 'unwind pending');
        }
        addLog(
          state,
          `[实盘风控] 份额失衡未平尽 · ${market.slug} · ${longSide} excess rem≈${Number(unwind.remaining || excess).toFixed(2)}`,
          'error'
        );
        tripLiveCircuitBreaker(state, market, {
          reason: 'size skew · unwind failed',
          remaining: unwind.remaining,
          side: longSide,
        });
        return {
          hedged: false,
          ok: false,
          reason: 'size skew',
          unwindFailed: true,
          remaining: unwind.remaining,
          side: longSide,
        };
      }
      if (pos && (Number(pos.upShares) || 0) <= 1e-8 && (Number(pos.downShares) || 0) <= 1e-8) {
        clearPairRiskLock(pos);
        clearPairInflight(pos);
      } else if (pos && Math.abs((Number(pos.upShares) || 0) - (Number(pos.downShares) || 0)) < minSkew) {
        clearPairInflight(pos);
      }
      addLog(
        state,
        `[实盘风控] 份额失衡已处理 · ${market.slug} · 卖掉多余 ${longSide}` +
          (nearEnd ? ' · 窗口末' : roundsGate.blocked ? ' · 轮次已满' : ' · 补腿后'),
        'warning'
      );
      return { hedged: true, ok: true, reason: 'size skew dump', unwindOk: true };
    }
  }

  if (skewPlan.skip && skewPlan.reason === 'awaiting hedge fill') {
    return { hedged: false, ok: true, reason: skewPlan.reason };
  }

  return { hedged: false, ok: true };
}

async function checkAllPairExposures(state) {
  const markets = collectMarketsForPairAudit(state);
  const results = [];
  for (const market of markets) {
    const r = await auditMarketPairExposure(state, market);
    if (r.hedged || r.unwindFailed) {
      results.push({ slug: market.slug, conditionId: market.conditionId, ...r });
    }
  }
  maybeResolveLiveCircuitBreaker(state);
  if (results.length) saveState(state);
  return results;
}

async function enforcePairHedge(state, market, preparedSides) {
  const sidesWanted = new Set(preparedSides || []);
  if (!(sidesWanted.has('Up') && sidesWanted.has('Down'))) {
    return { hedged: false };
  }
  return auditMarketPairExposure(state, market);
}

async function postOneLiveLeg(state, market, prep, paired) {
  const kept = prep._kept;
  let needShares = prep.shares;
  if (kept && kept.status === 'open') {
    const rem = Number(kept.remaining) || 0;
    if (rem + 1e-9 >= prep.shares) {
      return { ok: true, kept: true, side: prep.side };
    }
    needShares = rnd(prep.shares - rem, 6);
  }
  if (!(needShares > 1e-9)) {
    return { ok: true, skipped: true, side: prep.side };
  }

  const pos = state.positions[market.conditionId];
  if (pos) {
    const projected = projectedPairCostOnLegFill(pos, prep.side, needShares, prep.limit);
    if (!projected.ok) {
      addLog(
        state,
        `[实盘跳过] ${prep.side} ${needShares} @ $${prep.limit} · projected pairCost ${Number(projected.pairCost).toFixed(4)} > max ${projected.maxSum}`,
        'warning'
      );
      state.stats.skipped = (Number(state.stats.skipped) || 0) + 1;
      return {
        ok: false,
        side: prep.side,
        reason: projected.reason || 'projected pair cost too high',
        projected,
      };
    }
  }

  const { placeLiveBuy } = require('./executor');
  try {
    const resp = await placeLiveBuy(prep.tokenId, needShares, prep.limit);
    const orderId = extractOrderId(resp);
    const matched = parseBuyMatchedFromResponse(resp);
    const making = parseUsdc(resp.makingAmount);
    const tracked = trackLiveOrder(state, {
      market,
      side: prep.side,
      tokenId: prep.tokenId,
      shares: needShares,
      limitPrice: prep.limit,
      orderId,
      quoteMode: prep.quoteMode || 'maker',
      paired,
      plannedPrice: prep.planned,
      marketAsk: prep.marketAsk,
      sizeMatched: matched,
      makingAmount: making,
    });
    if (!tracked.ok) {
      let cancelConfirmed = false;
      try {
        const client = await getClient();
        await client.cancelOrder({ orderID: String(orderId) });
        cancelConfirmed = true;
      } catch (cancelErr) {
        const uncertain = trackUncertainLiveBuy(state, {
          market,
          prep: { ...prep, shares: needShares },
          orderId,
          paired,
          reason: cancelErr.message || cancelErr,
        });
        tripLiveCircuitBreaker(state, market, {
          reason: 'submitted BUY could not be tracked or cancelled',
          remaining: needShares,
          side: prep.side,
        });
        if (uncertain) saveState(state);
      }
      addLog(state, `[实盘挂单失败] ${prep.side}: ${tracked.reason}`, 'warning');
      state.stats.skipped = (Number(state.stats.skipped) || 0) + 1;
      return {
        ok: false,
        side: prep.side,
        reason: tracked.reason,
        cancelConfirmed,
        uncertain: !cancelConfirmed,
      };
    }
    state.stats.orders_posted = (Number(state.stats.orders_posted) || 0) + 1;
    const booked = Number(tracked.order?.sizeMatchedBooked) || matched;
    if (tracked.order && booked + 1e-6 < needShares) {
      await pollLiveOrderFill(state, tracked.order, { expected: needShares });
    }
    const afterBooked = Number(tracked.order?.sizeMatchedBooked) || 0;
    if (tracked.order && afterBooked > 1e-8 && paired) {
      await maybePostPendingPairLegAfterFill(state, tracked.order);
    }
    addLog(
      state,
      `[实盘挂单] BUY ${prep.side} ${needShares} @ $${prep.limit}` +
        ` (GTC; matched=${afterBooked || matched}; id=${String(orderId).slice(-6)})`,
      afterBooked > 0 ? 'success' : 'info'
    );
    return { ok: true, side: prep.side, tracked };
  } catch (err) {
    addLog(state, `[实盘下单失败] ${prep.side}: ${err.message}`, 'error');
    state.stats.skipped = (Number(state.stats.skipped) || 0) + 1;
    return { ok: false, side: prep.side, error: err.message };
  }
}

function serializePendingPairPrep(prep) {
  return {
    side: prep.side,
    shares: prep.shares,
    limit: prep.limit,
    tokenId: prep.tokenId,
    quoteMode: prep.quoteMode || 'maker',
    planned: prep.planned,
    marketAsk: prep.marketAsk,
    marketBid: prep.marketBid,
  };
}

/** Track pair legs still needing a resting BUY (high-leg-first or partial post failure). */
function updatePendingPairLegs(state, market, prepared, paired) {
  if (!paired || !Array.isArray(prepared) || prepared.length < 2) return;
  const pos = state.positions[market.conditionId];
  if (!pos) return;
  const open = liveOrdersForMarket(state, market.conditionId);
  const openBuySides = new Set(
    open
      .filter(
        (o) =>
          o.status === 'open' && String(o.side || 'BUY').toUpperCase() === 'BUY'
      )
      .map((o) => o.outcome)
  );
  const upSh = Number(pos.upShares) || 0;
  const downSh = Number(pos.downShares) || 0;
  const stillNeed = prepared.filter((p) => {
    if (openBuySides.has(p.side)) return false;
    const sh = p.side === 'Up' ? upSh : downSh;
    const target = Number(p.shares) || 0;
    return sh + 1e-8 < target;
  });
  if (stillNeed.length) {
    pos.pendingPairLegs = stillNeed.map(serializePendingPairPrep);
  } else {
    delete pos.pendingPairLegs;
  }
}

/** After first paired leg fills, post the missing maker leg immediately. */
async function maybePostPendingPairLegAfterFill(state, order) {
  if (!order?.paired) return { posted: false };
  const pos = state.positions[order.conditionId];
  if (!pos?.pendingPairLegs?.length) return { posted: false };

  const upSh = Number(pos.upShares) || 0;
  const downSh = Number(pos.downShares) || 0;
  let missingSide = null;
  if (upSh > 1e-8 && downSh <= 1e-8) missingSide = 'Down';
  else if (downSh > 1e-8 && upSh <= 1e-8) missingSide = 'Up';
  else {
    delete pos.pendingPairLegs;
    return { posted: false, reason: 'balanced or flat' };
  }

  const open = liveOrdersForMarket(state, order.conditionId);
  const hasMissingRest = open.some(
    (o) =>
      o.outcome === missingSide &&
      o.status === 'open' &&
      String(o.side || 'BUY').toUpperCase() === 'BUY'
  );
  if (hasMissingRest) return { posted: false, reason: 'missing leg already resting' };

  const prep = pos.pendingPairLegs.find((p) => p.side === missingSide);
  if (!prep) return { posted: false, reason: 'no prep for missing side' };

  const market = marketStubFromOrder(order);
  setPairInflight(pos, 'await hedge rest');
  addLog(
    state,
    `[实盘配对] ${order.outcome} 成交 · 立即挂 ${missingSide} ${prep.shares} @ $${prep.limit} · ${market.slug}`,
    'info'
  );
  const result = await postOneLiveLeg(state, market, prep, true);
  if (result.ok) {
    pos.pendingPairLegs = (pos.pendingPairLegs || []).filter((p) => p.side !== missingSide);
    if (!pos.pendingPairLegs.length) delete pos.pendingPairLegs;
  }
  return { posted: Boolean(result.ok), result, missingSide };
}

function selectLiveEntryLegs(prepared, paired, params = loadParams()) {
  const legs = Array.isArray(prepared) ? prepared : [];
  const enabled = !(params.live_high_leg_first === 0 || params.live_high_leg_first === false || params.live_high_leg_first === '0');
  if (!paired || !enabled || legs.length < 2) return legs;
  const highest = [...legs].sort((a, b) => {
    const priceDiff = Number(b.limit) - Number(a.limit);
    if (Math.abs(priceDiff) > 1e-12) return priceDiff;
    return String(a.side).localeCompare(String(b.side));
  })[0];
  return highest ? [highest] : [];
}

async function syncLiveQuotes(state, market, prepared, { paired = false } = {}) {
  const desiredPrepared = selectLiveEntryLegs(prepared, paired);
  if (paired && prepared.length >= 2) {
    const pos = getOrCreatePosition(state, market);
    const postedSides = new Set(desiredPrepared.map((p) => p.side));
    const deferred = prepared
      .filter((p) => !postedSides.has(p.side))
      .map(serializePendingPairPrep);
    if (deferred.length) pos.pendingPairLegs = deferred;
    else delete pos.pendingPairLegs;
  }
  const existing = liveOrdersForMarket(state, market.conditionId);
  const wantBySide = new Map();
  for (const p of desiredPrepared) wantBySide.set(p.side, p);
  let cancelled = 0;
  const cancelFailures = [];

  for (const o of existing) {
    const want = wantBySide.get(o.outcome);
    if (!want || Math.abs(Number(want.limit) - Number(o.limit)) > 1e-9) {
      const result = await cancelLiveOrder(state, o.id, 're-quote');
      if (result.ok) cancelled += 1;
      else cancelFailures.push({ orderId: o.id, reason: result.reason || 'cancel failed' });
    } else {
      want._kept = o;
    }
  }
  if (cancelFailures.length) {
    addLog(
      state,
      `[实盘撤单] 重挂已阻止 · ${market.slug} · ${cancelFailures.length} 笔撤单未确认`,
      'error'
    );
    tripLiveCircuitBreaker(state, market, {
      reason: 're-quote cancel failed',
      remaining: cancelFailures.length,
    });
    return {
      posted: cancelFailures.map((f) => ({ ok: false, reason: f.reason, orderId: f.orderId })),
      cancelled,
      cancelFailures,
    };
  }
  if (cancelled) {
    state.stats.orders_cancelled = (Number(state.stats.orders_cancelled) || 0) + cancelled;
    addLog(state, `[实盘撤单] 重挂 ${cancelled} 笔 @ ${market.slug}`, 'info');
  }

  const postResults = await Promise.all(
    desiredPrepared.map((prep) => postOneLiveLeg(state, market, prep, paired))
  );

  if (paired && prepared.length >= 2) {
    updatePendingPairLegs(state, market, prepared, paired);
    const failed = postResults.filter((r) => r && r.ok === false);
    if (failed.length > 0) {
      addLog(
        state,
        `[实盘风控] 配对下单部分失败 @ ${market.slug}，立即审计`,
        'warning'
      );
      await auditMarketPairExposure(state, market);
    }
  }

  await matchLiveOpenOrders(state);
  if (isLive()) {
    try {
      const { syncLiveFillsQuick } = require('./activity_backfill');
      await syncLiveFillsQuick(state);
    } catch (err) {
      addLog(state, `[成交同步] ${err.message}`, 'warning');
    }
  }
  if (paired && prepared.length >= 2) {
    const pos = state.positions[market.conditionId];
    const upSh = Number(pos?.upShares) || 0;
    const downSh = Number(pos?.downShares) || 0;
    const openAfter = liveOrdersForMarket(state, market.conditionId);
    const hasUpRest = openAfter.some((o) => o.outcome === 'Up');
    const hasDownRest = openAfter.some((o) => o.outcome === 'Down');
    const exp = detectPairExposure(upSh, downSh, hasUpRest, hasDownRest);
    const costCheck = validatePairedPositionCost(state, market);
    const minSkew = Math.max(Number(loadParams().min_order_shares) || 5, 1);
    const skew = Math.abs(upSh - downSh);
    if (!costCheck.ok || exp.kind === 'one_sided' || skew >= minSkew) {
      await auditMarketPairExposure(state, market);
    }
  } else if (paired) {
    validatePairedPositionCost(state, market);
  }

  return { posted: postResults, cancelled };
}

async function cancelLiveStaleOrders(state, nowSec = Math.floor(Date.now() / 1000)) {
  const params = loadParams();
  const cancelled = [];
  for (const o of liveOrders(state)) {
    const pos = state.positions[o.conditionId];
    if (shouldSkipStaleCancelForHedge(o, pos)) continue;

    const end = Number(o.windowEnd) || 0;
    if (end && nowSec >= end) {
      const r = await cancelLiveOrder(state, o.id, 'window ended');
      if (r.ok) cancelled.push(o);
      continue;
    }
    const start = Number(o.windowStart) || 0;
    if (start && nowSec - start > (Number(params.entry_end_sec) || 280)) {
      const r = await cancelLiveOrder(state, o.id, 'past entry window');
      if (r.ok) cancelled.push(o);
    }
  }
  if (cancelled.length) {
    addLog(state, `[实盘撤单] ${cancelled.length} 笔（窗口/入场结束）`, 'info');
  }
  pruneOrders(state);
  return cancelled;
}

module.exports = {
  parseSize,
  parseUsdc,
  liveOrders,
  liveOrdersForMarket,
  liveReservedUsdc,
  trackLiveOrder,
  bookLiveFill,
  cancelLiveOrder,
  cancelLiveOrdersForMarket,
  cancelLiveStaleOrders,
  matchLiveOpenOrders,
  matchOneLiveOrder,
  pollLiveOrderFill,
  parseBuyMatchedFromResponse,
  extractOrderId,
  extractOrderUsdcFromTrade,
  resolveLiveFillUsdc,
  reconcileLiveOpenOrders,
  syncLiveQuotes,
  enforcePairHedge,
  auditMarketPairExposure,
  tripLiveCircuitBreaker,
  maybeResolveLiveCircuitBreaker,
  trackUncertainLiveBuy,
  selectLiveEntryLegs,
  updatePendingPairLegs,
  maybePostPendingPairLegAfterFill,
  orphanLossAtBid,
  checkAllPairExposures,
  validatePairedPositionCost,
  detectPairExposure,
  placeLiveSell,
  tryUnwindLeg,
  tryUnwindLegAll,
  tryTakerHedgeMissingLeg,
};
