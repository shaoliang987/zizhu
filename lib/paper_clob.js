/**
 * Paper CLOB — simulate Polymarket GTC buy/sell mechanics against live books.
 *
 * BUY maker (limit below ask):
 *   - Post resting order, reserve cash (notional at limit; maker fee = 0)
 *   - Queue at bid: track size ahead; fills only after ahead drains
 *   - If ask ≤ limit: crossed → taker fill at ask (+ taker fee)
 *   - If best bid > limit: traded through → maker fill at limit
 *   - Last-trade ≤ limit can also drain the queue (tape proxy)
 *
 * BUY taker (limit at/through ask):
 *   - Immediate match vs ask size; residual rests as maker GTC
 */
const { buyCostWithFee, withTakerFeeCash, rnd } = require('./fees');
const { getBook, getLastTradePrice, bestAskFromBook, bestBidFromBook } = require('./book');
const { validatePairedPositionCost, shouldSkipStaleCancelForHedge, shouldDeferOrphanUnwind, hedgeRestAgeSec, skewCancelPlan, setPairRiskLock, clearPairRiskLock } = require('./pair_risk');
const { applyBuy, addLog, saveState, recordWindowRealized } = require('./ledger');
const { loadParams } = require('./strategy');

const TICK = 0.01;

function tickRound(px) {
  const n = Number(px);
  if (!(n > 0)) return null;
  return rnd(Math.round(n / TICK) * TICK, 4);
}

function ensureOrders(state) {
  if (!Array.isArray(state.open_orders)) state.open_orders = [];
  if (!Number.isFinite(state.reserved_usdc)) state.reserved_usdc = 0;
  return state.open_orders;
}

function feeRateFor(params, role) {
  if (role === 'maker') {
    const m = Number(params.maker_fee_rate);
    return Number.isFinite(m) && m >= 0 ? m : 0;
  }
  const t = Number(params.taker_fee_rate);
  if (Number.isFinite(t) && t >= 0) return t;
  return undefined;
}

function reserveCost(shares, limit, feeRate) {
  return buyCostWithFee(shares, limit, feeRate).cost;
}

function newOrderId() {
  return `paper_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Post a paper GTC BUY. Reserves cash for full remaining size at limit
 * using maker fee (0) — if later matched as taker, extra fee comes from free cash.
 */
function postPaperBuy(state, {
  market,
  side,
  tokenId,
  shares,
  limitPrice,
  quoteMode = 'maker',
  paired = false,
  plannedPrice = null,
  marketAsk = null,
  marketBid = null,
  bidSizeAtJoin = null,
}) {
  ensureOrders(state);
  const params = loadParams();
  const limit = tickRound(limitPrice);
  const size = rnd(Number(shares), 6);
  if (!(limit > 0) || !(size > 0)) {
    return { ok: false, reason: 'invalid order' };
  }

  const makerRate = feeRateFor(params, 'maker');
  const need = reserveCost(size, limit, makerRate);
  if (state.cash_usdc + 1e-9 < need) {
    return { ok: false, reason: `cash $${state.cash_usdc.toFixed(4)} < reserve $${need}` };
  }

  state.cash_usdc = rnd(state.cash_usdc - need, 4);
  state.reserved_usdc = rnd((Number(state.reserved_usdc) || 0) + need, 4);

  // Join back of queue at this price: size already resting at best bid (if we join that level)
  let queueAhead = 0;
  let lastSeenBidSize = 0;
  if (marketBid != null && Math.abs(Number(marketBid) - limit) < 1e-9) {
    queueAhead = Math.max(0, Number(bidSizeAtJoin) || 0);
    lastSeenBidSize = queueAhead;
  } else if (marketBid != null && Number(marketBid) > limit + 1e-12) {
    // Improving the bid — first at new level
    queueAhead = 0;
    lastSeenBidSize = 0;
  }

  const order = {
    id: newOrderId(),
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
    remaining: size,
    filled: 0,
    reservedUsdc: need,
    quoteMode,
    paired: Boolean(paired),
    plannedPrice: plannedPrice != null ? Number(plannedPrice) : limit,
    marketAskAtPost: marketAsk,
    queueAhead: rnd(queueAhead, 6),
    lastSeenBidSize: rnd(lastSeenBidSize, 6),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  state.open_orders.push(order);
  return { ok: true, order };
}

function releaseReserve(state, order, amount) {
  const amt = Math.min(Number(order.reservedUsdc) || 0, Math.max(0, Number(amount) || 0));
  if (!(amt > 0)) return 0;
  order.reservedUsdc = rnd((Number(order.reservedUsdc) || 0) - amt, 4);
  state.reserved_usdc = rnd(Math.max(0, (Number(state.reserved_usdc) || 0) - amt), 4);
  state.cash_usdc = rnd(state.cash_usdc + amt, 4);
  return amt;
}

function cancelPaperOrder(state, orderId, reason = 'cancelled') {
  ensureOrders(state);
  const order = state.open_orders.find((o) => o.id === orderId && o.status === 'open');
  if (!order) return { ok: false, reason: 'not found' };
  // Never paper-cancel a live exchange order — that orphans GTC on CLOB
  if (order.live) {
    return { ok: false, reason: 'live order — use cancelLiveOrder' };
  }
  releaseReserve(state, order, order.reservedUsdc);
  order.status = 'cancelled';
  order.cancelReason = reason;
  order.updatedAt = new Date().toISOString();
  order.remaining = 0;
  return { ok: true, order };
}

function cancelOrdersForMarket(state, conditionId, reason = 'market done') {
  ensureOrders(state);
  const out = [];
  for (const o of state.open_orders) {
    if (o.status === 'open' && o.conditionId === conditionId && !o.live) {
      cancelPaperOrder(state, o.id, reason);
      out.push(o);
    }
  }
  pruneOrders(state);
  return out;
}

function cancelStaleOrders(state, nowSec = Math.floor(Date.now() / 1000)) {
  ensureOrders(state);
  const params = loadParams();
  const cancelled = [];
  for (const o of state.open_orders) {
    if (o.status !== 'open') continue;
    if (o.live) continue; // live handled by cancelLiveStaleOrders
    const pos = state.positions[o.conditionId];
    if (shouldSkipStaleCancelForHedge(o, pos)) continue;

    const end = Number(o.windowEnd) || 0;
    if (end && nowSec >= end) {
      cancelPaperOrder(state, o.id, 'window ended');
      cancelled.push(o);
      continue;
    }
    const start = Number(o.windowStart) || 0;
    if (start && nowSec - start > (Number(params.entry_end_sec) || 280)) {
      cancelPaperOrder(state, o.id, 'past entry window');
      cancelled.push(o);
    }
  }
  if (cancelled.length) {
    addLog(state, `[纸上撤单] ${cancelled.length} 笔（窗口/入场结束）`, 'info');
  }
  pruneOrders(state);
  return cancelled;
}

function pruneOrders(state, keep = 40) {
  ensureOrders(state);
  const open = state.open_orders.filter((o) => o.status === 'open');
  const done = state.open_orders
    .filter((o) => o.status !== 'open')
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, keep);
  state.open_orders = [...open, ...done];
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

/**
 * Apply a fill against a resting paper order.
 * role: 'maker' | 'taker'
 */
function fillPaperOrder(state, order, fillShares, fillPrice, role) {
  const params = loadParams();
  const shares = rnd(Math.min(Number(order.remaining) || 0, Number(fillShares) || 0), 6);
  const px = tickRound(fillPrice);
  if (!(shares > 0) || !(px > 0)) return { ok: false, reason: 'empty fill' };

  const feeRate = feeRateFor(params, role);
  const { cost, fee, notional } = buyCostWithFee(shares, px, feeRate);

  // Release reserved notional for these shares (reserved at limit × maker fee)
  const reserveRelease = rnd(
    ((Number(order.reservedUsdc) || 0) * shares) / Math.max(Number(order.remaining), shares),
    4
  );
  // Move reserve → free, then applyBuy spends actual cost from free cash
  releaseReserve(state, order, reserveRelease);

  const market = marketStubFromOrder(order);
  const r = applyBuy(state, market, order.outcome, shares, px, {
    live: false,
    paperClob: true,
    orderId: order.id,
    paired: order.paired,
    plannedPrice: order.plannedPrice,
    limitPrice: order.limit,
    marketAsk: order.marketAskAtPost,
    quoteMode: role,
    feeRate,
    liquidity: role,
  });

  if (!r.ok) {
    // Re-reserve what we released if apply failed
    const need = reserveRelease;
    if (state.cash_usdc + 1e-9 >= need) {
      state.cash_usdc = rnd(state.cash_usdc - need, 4);
      state.reserved_usdc = rnd((Number(state.reserved_usdc) || 0) + need, 4);
      order.reservedUsdc = rnd((Number(order.reservedUsdc) || 0) + need, 4);
    }
    return r;
  }

  // If taker cost > released reserve, applyBuy already took the difference from cash.
  // If maker and release > cost, applyBuy took less — cash is correct.
  order.filled = rnd((Number(order.filled) || 0) + shares, 6);
  order.remaining = rnd(Math.max(0, (Number(order.remaining) || 0) - shares), 6);
  order.updatedAt = new Date().toISOString();
  if (order.remaining <= 1e-9) {
    // Return any leftover reserve
    if (order.reservedUsdc > 0) releaseReserve(state, order, order.reservedUsdc);
    order.status = 'filled';
    order.remaining = 0;
  }

  addLog(
    state,
    `[纸上成交] BUY ${order.outcome} ${shares} @ $${px}` +
      ` (fee $${fee}; ${role}; GTC ${order.id.slice(-6)}; rem=${order.remaining})` +
      ` notional $${notional}`,
    'success'
  );

  return { ok: true, shares, price: px, fee, cost, role, order };
}

/**
 * Match one resting BUY against a live book snapshot (+ last trade).
 * ctx (shared across same-token orders, FIFO):
 *   askLeft — remaining ask size for taker crosses
 *   bidDecLeft — remaining bid-size decrease to allocate at this limit
 *   tapeUsed — whether a last-trade print already filled someone this scan
 */
function matchBuyAgainstBook(state, order, book, lastTrade, ctx = {}) {
  if (order.status !== 'open' || !(order.remaining > 0)) return [];
  const params = loadParams();
  const bidFillFrac = Number.isFinite(Number(params.paper_bid_fill_fraction))
    ? Math.min(1, Math.max(0, Number(params.paper_bid_fill_fraction)))
    : 0.5;
  const tapeClip = Math.max(
    0.01,
    Number(params.paper_tape_fill_shares) > 0 ? Number(params.paper_tape_fill_shares) : 1
  );

  const ask = bestAskFromBook(book);
  const bid = bestBidFromBook(book);
  const fills = [];
  let remaining = order.remaining;
  const limit = Number(order.limit);

  // 1) Crossed the spread → taker (shared ask liquidity)
  if (ask && ask.price <= limit + 1e-12) {
    const askLeft = ctx.askLeft != null ? Number(ctx.askLeft) : (Number(ask.size) || remaining);
    const sz = Math.min(remaining, Math.max(0, askLeft));
    if (sz > 1e-12) {
      const r = fillPaperOrder(state, order, sz, ask.price, 'taker');
      if (r.ok) {
        fills.push(r);
        remaining = order.remaining;
        if (ctx.askLeft != null) ctx.askLeft = rnd(Math.max(0, askLeft - sz), 6);
      }
    }
    if (!(remaining > 0)) return fills;
  }

  // 2) Best bid traded through our price → maker fill (cap by shared through-pool)
  if (bid && bid.price > limit + 1e-12) {
    const pool = ctx.throughLeft != null ? Number(ctx.throughLeft) : remaining;
    const sz = Math.min(remaining, Math.max(0, pool));
    if (sz > 1e-12) {
      const r = fillPaperOrder(state, order, sz, limit, 'maker');
      if (r.ok) {
        fills.push(r);
        if (ctx.throughLeft != null) ctx.throughLeft = rnd(Math.max(0, pool - sz), 6);
      }
    }
    return fills;
  }

  // 3) At our price: queue drain from bid-size decreases (shared + partial fill)
  if (bid && Math.abs(bid.price - limit) < 1e-9) {
    const bidSize = Number(bid.size) || 0;
    if (order.lastSeenBidSize == null) {
      order.lastSeenBidSize = bidSize;
      if (order.queueAhead == null) order.queueAhead = bidSize;
    } else {
      const prev = Number(order.lastSeenBidSize) || 0;
      // First order at this limit owns computing the shared decrease pool
      if (ctx.bidDecLeft == null && ctx._bidDecInit !== limit) {
        ctx._bidDecInit = limit;
        ctx.bidDecLeft = Math.max(0, prev - bidSize);
      }
      let decrease = ctx.bidDecLeft != null ? Number(ctx.bidDecLeft) : Math.max(0, prev - bidSize);
      if (decrease > 0) {
        const ahead = Math.max(0, Number(order.queueAhead) || 0);
        if (ahead > 0) {
          const absorbed = Math.min(ahead, decrease);
          order.queueAhead = rnd(ahead - absorbed, 6);
          decrease = rnd(decrease - absorbed, 6);
        }
        // Only a fraction of size drop is treated as trade; rest assumed cancel
        const tradeable = rnd(decrease * bidFillFrac, 6);
        if (tradeable > 1e-12 && order.remaining > 0 && (Number(order.queueAhead) || 0) <= 1e-9) {
          const sz = Math.min(order.remaining, tradeable);
          const r = fillPaperOrder(state, order, sz, limit, 'maker');
          if (r.ok) {
            fills.push(r);
            decrease = rnd(Math.max(0, decrease - sz / Math.max(bidFillFrac, 1e-9)), 6);
          }
        } else {
          // leftover decrease after queue was cancels — consume from pool
          decrease = 0;
        }
        if (ctx.bidDecLeft != null) ctx.bidDecLeft = Math.max(0, decrease);
      } else if (bidSize > prev) {
        // New size joined behind us — queueAhead unchanged
      }
      order.lastSeenBidSize = bidSize;
    }
  }

  // 4) Last-trade print: drain queue or fill a small tape clip (once per token/scan)
  if (
    tapeClip > 0
    && order.status === 'open'
    && lastTrade != null
    && Math.abs(lastTrade - limit) <= TICK + 1e-12
  ) {
    const prevTrade = order.lastTradeSeen;
    if (prevTrade == null || Math.abs(prevTrade - lastTrade) > 1e-12) {
      order.lastTradeSeen = lastTrade;
      const ahead = Math.max(0, Number(order.queueAhead) || 0);
      if (ahead > 1e-9) {
        order.queueAhead = rnd(Math.max(0, ahead - tapeClip), 6);
      } else if (order.remaining > 0 && !ctx.tapeUsed) {
        const sz = Math.min(order.remaining, tapeClip);
        const r = fillPaperOrder(state, order, sz, limit, 'maker');
        if (r.ok) {
          fills.push(r);
          ctx.tapeUsed = true;
        }
      }
    }
  } else if (lastTrade != null) {
    order.lastTradeSeen = lastTrade;
  }

  order.updatedAt = new Date().toISOString();
  return fills;
}

async function matchOpenOrders(state) {
  ensureOrders(state);
  const open = state.open_orders.filter((o) => o.status === 'open' && o.side === 'BUY' && !o.live);
  if (!open.length) return { matched: 0, fills: [] };

  const byToken = new Map();
  for (const o of open) {
    if (!byToken.has(o.tokenId)) byToken.set(o.tokenId, []);
    byToken.get(o.tokenId).push(o);
  }

  const allFills = [];
  for (const [tokenId, orders] of byToken) {
    let book;
    let lastTrade = null;
    try {
      [book, lastTrade] = await Promise.all([
        getBook(tokenId),
        getLastTradePrice(tokenId),
      ]);
    } catch (err) {
      addLog(state, `[纸上撮合] book 失败 ${tokenId.slice(0, 10)}…: ${err.message}`, 'warning');
      continue;
    }

    // FIFO: earlier posts consume shared ask / bid-decrease / tape first
    orders.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    const ask = bestAskFromBook(book);
    const bid = bestBidFromBook(book);
    const ctx = {
      askLeft: ask ? Number(ask.size) || 0 : 0,
      // through-fill pool: don't let N orders each fully fill on one trade-through
      throughLeft: bid && ask
        ? Math.max(Number(bid.size) || 0, Number(ask.size) || 0)
        : (bid ? Number(bid.size) || 0 : 0),
      tapeUsed: false,
      bidDecLeft: null,
      _bidDecInit: null,
    };

    for (const order of orders) {
      // Reset bid-decrease pool when limit level changes
      if (ctx._bidDecInit != null && Math.abs(Number(order.limit) - Number(ctx._bidDecInit)) > 1e-9) {
        ctx.bidDecLeft = null;
        ctx._bidDecInit = null;
      }
      const fills = matchBuyAgainstBook(state, order, book, lastTrade, ctx);
      allFills.push(...fills);
    }
  }

  pruneOrders(state);
  if (allFills.length) saveState(state);
  return { matched: allFills.length, fills: allFills };
}

/** Immediate taker attempt against current ask; returns unfilled size. */
function takeAskNow(state, prep, market, params) {
  const ask = Number(prep.marketAsk);
  const askSize = prep.askSize != null ? Number(prep.askSize) : null;
  const limit = Number(prep.limit);
  if (!(ask > 0) || ask > limit + 1e-12) {
    return { filled: 0, remaining: prep.shares };
  }
  const sz = askSize != null ? Math.min(prep.shares, askSize) : prep.shares;
  if (!(sz > 0)) return { filled: 0, remaining: prep.shares };

  // Reserve then fill as taker (or applyBuy directly for immediate)
  const feeRate = feeRateFor(params, 'taker');
  const r = applyBuy(state, market, prep.side, sz, ask, {
    live: false,
    paperClob: true,
    paired: prep.paired,
    plannedPrice: prep.planned,
    limitPrice: limit,
    marketAsk: ask,
    quoteMode: 'taker',
    feeRate,
    liquidity: 'taker',
  });
  if (!r.ok) return { filled: 0, remaining: prep.shares, error: r.reason };
  addLog(
    state,
    `[纸上成交] BUY ${prep.side} ${sz} @ $${ask} (fee $${r.fee}; taker; lift-ask)`,
    'success'
  );
  return { filled: sz, remaining: rnd(prep.shares - sz, 6), result: r };
}

function openOrders(state) {
  ensureOrders(state);
  return state.open_orders.filter((o) => o.status === 'open');
}

function ordersForMarket(state, conditionId) {
  return openOrders(state).filter((o) => o.conditionId === conditionId);
}

/**
 * H2: Sync resting paper quotes without cancel-all thrash.
 * Keep open orders with matching side+limit; top-up size if short; cancel others.
 */
function syncPaperQuotes(state, market, prepared, {
  paired = false,
  bidSum = null,
} = {}) {
  const existing = ordersForMarket(state, market.conditionId).filter((o) => !o.live);
  const wantBySide = new Map(prepared.map((p) => [p.side, p]));
  let cancelled = 0;
  const results = [];

  for (const o of existing) {
    const want = wantBySide.get(o.outcome);
    if (!want || Math.abs(Number(want.limit) - Number(o.limit)) > 1e-9) {
      cancelPaperOrder(state, o.id, 're-quote');
      cancelled += 1;
    } else {
      want._kept = o;
    }
  }
  if (cancelled) {
    state.stats.orders_cancelled = (Number(state.stats.orders_cancelled) || 0) + cancelled;
    addLog(state, `[纸上撤单] 重挂 ${cancelled} 笔 @ ${market.slug}`, 'info');
  }

  for (const prep of prepared) {
    const kept = prep._kept;
    let needShares = prep.shares;
    if (kept && kept.status === 'open') {
      const rem = Number(kept.remaining) || 0;
      if (rem + 1e-9 >= prep.shares) {
        results.push({ ok: true, kept: true, order: kept });
        continue;
      }
      needShares = rnd(prep.shares - rem, 6);
    }
    if (!(needShares > 1e-9)) continue;

    const posted = postPaperBuy(state, {
      market,
      side: prep.side,
      tokenId: prep.tokenId,
      shares: needShares,
      limitPrice: prep.limit,
      quoteMode: 'maker',
      paired,
      plannedPrice: prep.planned,
      marketAsk: prep.marketAsk,
      marketBid: prep.marketBid,
      bidSizeAtJoin: prep.bidSize,
    });
    if (!posted.ok) {
      addLog(state, `[纸上挂单失败] ${prep.side}: ${posted.reason}`, 'warning');
      state.stats.skipped += 1;
      results.push(posted);
    } else {
      state.stats.orders_posted = (Number(state.stats.orders_posted) || 0) + 1;
      addLog(
        state,
        `[纸上挂单] BUY ${prep.side} ${needShares} @ $${prep.limit}` +
          ` (GTC; queueAhead=${posted.order.queueAhead}` +
          `${bidSum != null ? `; bidSum=${Number(bidSum).toFixed(3)}` : ''}` +
          `; id=${posted.order.id.slice(-6)})`,
        'info'
      );
      results.push({ ok: true, posted: posted.order });
    }
  }

  pruneOrders(state);
  if (paired) {
    const costCheck = validatePairedPositionCost(state, market);
    if (!costCheck.ok) {
      addLog(
        state,
        `[纸上风控] 配对成本过高 ${market.slug}: pairCost=${Number(costCheck.pairCost).toFixed(4)} > max ${costCheck.maxSum} + buffer`,
        'warning'
      );
    }
  }
  return { results, cancelled };
}

function paperMarketFromPos(pos) {
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

function collectPaperMarketsForAudit(state) {
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
    if (upSh > 1e-8 || downSh > 1e-8) push(paperMarketFromPos(pos));
  }
  for (const o of openOrders(state).filter((x) => !x.live)) {
    push(marketStubFromOrder(o));
  }
  return markets;
}

/** Paper: simulate sell at bid with taker fee for unwind. */
async function paperUnwindLeg(state, market, side, shares) {
  const { getBestBid } = require('./book');
  const params = loadParams();
  const tokenId = side === 'Up' ? market.upTokenId : market.downTokenId;
  const bid = await getBestBid(tokenId);
  if (!bid || !(bid.price > 0)) {
    return { ok: false, reason: 'no bid', remaining: shares, fullyClosed: false };
  }
  const bidSize = Number(bid.size) || 0;
  const want = rnd(Number(shares) || 0, 6);
  if (bidSize + 1e-9 < want) {
    return { ok: false, reason: 'insufficient bid (FOK)', remaining: want, fullyClosed: false };
  }
  const matched = want;
  if (!(matched > 0)) {
    return { ok: false, reason: 'zero size', remaining: shares, fullyClosed: false };
  }

  const px = tickRound(bid.price);
  const feeRate = feeRateFor(params, 'taker');
  const sellCash = withTakerFeeCash('SELL', matched, px, null, feeRate);
  const proceeds = sellCash.proceeds ?? sellCash.usdc;
  const pos = state.positions[market.conditionId];
  if (!pos) {
    return { ok: false, reason: 'no position', remaining: shares, fullyClosed: false };
  }

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
    `[纸上平仓] SELL ${side} ${matched} @ $${px} (fee $${sellCash.fee}; proceeds $${proceeds})`,
    'warning'
  );

  const remaining = rnd(Math.max(0, (Number(shares) || 0) - matched), 6);
  return {
    ok: true,
    matched,
    remaining,
    fullyClosed: remaining <= 1e-8,
  };
}

async function auditPaperPairExposure(state, market, nowSec = Math.floor(Date.now() / 1000)) {
  const open = ordersForMarket(state, market.conditionId).filter((o) => !o.live);
  const pos = state.positions[market.conditionId];
  const upSh = Number(pos?.upShares) || 0;
  const downSh = Number(pos?.downShares) || 0;
  const hasUpRest = open.some((o) => o.outcome === 'Up' && String(o.side || 'BUY').toUpperCase() === 'BUY');
  const hasDownRest = open.some((o) => o.outcome === 'Down' && String(o.side || 'BUY').toUpperCase() === 'BUY');
  // Inventory-only: resting missing-leg is not a completed hedge
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

  if (invUp && !invDown) {
    if (hasDownRest && defer.defer) {
      return { hedged: false, ok: true, reason: defer.reason || 'Down hedge resting' };
    }
    if (defer.defer) {
      return { hedged: false, ok: true, reason: defer.reason || 'awaiting Down hedge' };
    }
    cancelOrdersForMarket(state, market.conditionId, 'paper pair audit: missing Down');
    if (upSh > 1e-8) {
      const r = await paperUnwindLeg(state, market, 'Up', upSh);
      if (!r.fullyClosed && (Number(r.remaining) || 0) > 1e-8) {
        addLog(state, `[纸上风控] 配对缺 Down · ${market.slug} · Up rem=${Number(r.remaining).toFixed(2)}`, 'error');
        return { hedged: false, ok: false, reason: 'missing Down', unwindFailed: true };
      }
    }
    addLog(
      state,
      `[纸上风控] 配对缺 Down 已处理 · ${market.slug}` +
        (defer.force ? ` · ${defer.reason || 'force'}` : ''),
      'warning'
    );
    return { hedged: true, ok: true, reason: 'missing Down' };
  }

  if (invDown && !invUp) {
    if (hasUpRest && defer.defer) {
      return { hedged: false, ok: true, reason: defer.reason || 'Up hedge resting' };
    }
    if (defer.defer) {
      return { hedged: false, ok: true, reason: defer.reason || 'awaiting Up hedge' };
    }
    cancelOrdersForMarket(state, market.conditionId, 'paper pair audit: missing Up');
    if (downSh > 1e-8) {
      const r = await paperUnwindLeg(state, market, 'Down', downSh);
      if (!r.fullyClosed && (Number(r.remaining) || 0) > 1e-8) {
        addLog(state, `[纸上风控] 配对缺 Up · ${market.slug} · Down rem=${Number(r.remaining).toFixed(2)}`, 'error');
        return { hedged: false, ok: false, reason: 'missing Up', unwindFailed: true };
      }
    }
    addLog(
      state,
      `[纸上风控] 配对缺 Up 已处理 · ${market.slug}` +
        (defer.force ? ` · ${defer.reason || 'force'}` : ''),
      'warning'
    );
    return { hedged: true, ok: true, reason: 'missing Up' };
  }

  if (!(invUp && invDown)) {
    return { hedged: false, ok: true };
  }

  const costCheck = validatePairedPositionCost(state, market);
  if (!costCheck.ok) {
    addLog(
      state,
      `[纸上风控] 配对成本过高 ${market.slug}: pairCost=${Number(costCheck.pairCost).toFixed(4)} > max ${costCheck.maxSum} + buffer`,
      'warning'
    );
    if (pos) setPairRiskLock(pos, 'pair cost too high');
    cancelOrdersForMarket(state, market.conditionId, 'paper pair audit: cost too high');
    if (upSh > 1e-8) {
      const r = await paperUnwindLeg(state, market, 'Up', upSh);
      if (!r.fullyClosed && (Number(r.remaining) || 0) > 1e-8) {
        if (pos) setPairRiskLock(pos, 'pair cost too high · unwind failed');
        return { hedged: false, ok: false, reason: 'pair cost too high', unwindFailed: true };
      }
    }
    if (downSh > 1e-8) {
      const r = await paperUnwindLeg(state, market, 'Down', downSh);
      if (!r.fullyClosed && (Number(r.remaining) || 0) > 1e-8) {
        if (pos) setPairRiskLock(pos, 'pair cost too high · unwind failed');
        return { hedged: false, ok: false, reason: 'pair cost too high', unwindFailed: true };
      }
    }
    if (pos && (Number(pos.upShares) || 0) <= 1e-8 && (Number(pos.downShares) || 0) <= 1e-8) {
      clearPairRiskLock(pos);
    }
    return { hedged: true, ok: true, reason: 'pair cost too high' };
  }

  const params = loadParams();
  const minSkew = Math.max(Number(params.min_order_shares) || 5, 1);
  const skewPlan = skewCancelPlan(upSh, downSh, open);
  if (!skewPlan.skip && skewPlan.skew >= minSkew) {
    for (const o of skewPlan.cancel) {
      cancelPaperOrder(state, o.id, 'paper pair audit: size skew');
    }
    if (skewPlan.cancel.length) {
      addLog(
        state,
        `[纸上风控] 份额失衡 Up=${upSh} Down=${downSh}，已撤 ${skewPlan.longSide} 挂单 · ${market.slug}`,
        'warning'
      );
    }
    return { hedged: true, ok: true, reason: skewPlan.reason || 'size skew' };
  }
  if (skewPlan.skip && skewPlan.reason === 'awaiting hedge fill') {
    return { hedged: false, ok: true, reason: skewPlan.reason };
  }

  return { hedged: false, ok: true };
}

async function checkAllPaperPairExposures(state) {
  const markets = collectPaperMarketsForAudit(state);
  const results = [];
  for (const market of markets) {
    const r = await auditPaperPairExposure(state, market);
    if (r.hedged || r.unwindFailed) {
      results.push({ slug: market.slug, conditionId: market.conditionId, ...r });
    }
  }
  if (results.length) saveState(state);
  return results;
}

module.exports = {
  TICK,
  tickRound,
  ensureOrders,
  postPaperBuy,
  cancelPaperOrder,
  cancelOrdersForMarket,
  cancelStaleOrders,
  matchOpenOrders,
  matchBuyAgainstBook,
  takeAskNow,
  openOrders,
  ordersForMarket,
  feeRateFor,
  fillPaperOrder,
  syncPaperQuotes,
  releaseReserve,
  pruneOrders,
  auditPaperPairExposure,
  checkAllPaperPairExposures,
  paperUnwindLeg,
};
