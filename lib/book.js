const { marketWs, WS_QUOTE_WAIT_MS } = require('./market_ws');

const CLOB = process.env.CLOB_API_URL || 'https://clob.polymarket.com';

async function fetchJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchBookHttp(tokenId) {
  return fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
}

/** Prefer fresh WS book snapshot; else HTTP /book. */
async function getBook(tokenId) {
  const id = String(tokenId || '');
  if (id) {
    marketWs.subscribe([id]);
    const wsBook = marketWs.getFreshBook(id);
    if (wsBook) return wsBook;
  }
  return fetchBookHttp(tokenId);
}

function bestAskFromBook(book) {
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  if (!asks.length) return null;
  let best = null;
  for (const a of asks) {
    const price = Number(a.price);
    const size = Number(a.size);
    if (!(price > 0) || !(size > 0)) continue;
    if (!best || price < best.price) best = { price, size };
  }
  return best;
}

function bestBidFromBook(book) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  if (!bids.length) return null;
  let best = null;
  for (const b of bids) {
    const price = Number(b.price);
    const size = Number(b.size);
    if (!(price > 0) || !(size > 0)) continue;
    if (!best || price > best.price) best = { price, size };
  }
  return best;
}

async function getBestAsk(tokenId) {
  const top = marketWs.getFreshTop(tokenId);
  if (top?.ask) return top.ask;
  const book = await getBook(tokenId);
  return bestAskFromBook(book);
}

async function getBestBid(tokenId) {
  const top = marketWs.getFreshTop(tokenId);
  if (top?.bid) return top.bid;
  const book = await getBook(tokenId);
  return bestBidFromBook(book);
}

/** Ask-only snapshot (legacy taker path). */
async function getPairAsks(market) {
  const q = await getPairQuotes(market);
  return {
    up: q.up?.ask || null,
    down: q.down?.ask || null,
    pairSum: q.askSum,
    askSum: q.askSum,
    bidSum: q.bidSum,
  };
}

function topComplete(top) {
  return !!(top && (top.bid || top.ask));
}

/**
 * Full top-of-book for both legs.
 * Prefers CLOB market WS; HTTP /book per leg if WS missing/stale.
 */
async function getPairQuotes(market) {
  const upId = String(market?.upTokenId || '');
  const downId = String(market?.downTokenId || '');
  const ids = [upId, downId].filter(Boolean);

  let upTop = null;
  let downTop = null;
  let source = 'http';

  if (ids.length) {
    try {
      await marketWs.ensureTops(ids, WS_QUOTE_WAIT_MS);
      upTop = upId ? marketWs.getFreshTop(upId) : null;
      downTop = downId ? marketWs.getFreshTop(downId) : null;
      if (topComplete(upTop) && topComplete(downTop)) {
        source = upTop.source || downTop.source || 'ws';
      } else if (topComplete(upTop) || topComplete(downTop)) {
        source = 'ws+http';
      }
    } catch (_) {
      /* fall through to HTTP */
    }
  }

  async function legFromHttp(tokenId) {
    if (!tokenId) return { ask: null, bid: null };
    try {
      const book = await fetchBookHttp(tokenId);
      return {
        ask: bestAskFromBook(book),
        bid: bestBidFromBook(book),
      };
    } catch (_) {
      return { ask: null, bid: null };
    }
  }

  let upAsk = upTop?.ask || null;
  let upBid = upTop?.bid || null;
  let downAsk = downTop?.ask || null;
  let downBid = downTop?.bid || null;

  if (!upAsk || !upBid) {
    const httpUp = await legFromHttp(upId);
    if (!upAsk) upAsk = httpUp.ask;
    if (!upBid) upBid = httpUp.bid;
  }
  if (!downAsk || !downBid) {
    const httpDown = await legFromHttp(downId);
    if (!downAsk) downAsk = httpDown.ask;
    if (!downBid) downBid = httpDown.bid;
  }

  const askSum = upAsk && downAsk ? upAsk.price + downAsk.price : null;
  const bidSum = upBid && downBid ? upBid.price + downBid.price : null;
  return {
    up: { ask: upAsk, bid: upBid },
    down: { ask: downAsk, bid: downBid },
    askSum,
    bidSum,
    pairSum: askSum,
    source,
  };
}

async function getLastTradePrice(tokenId) {
  try {
    const data = await fetchJson(
      `${CLOB}/last-trade-price?token_id=${encodeURIComponent(tokenId)}`
    );
    const p = Number(data?.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch (_) {
    return null;
  }
}

/** Official CLOB midpoint (current market price). */
async function getMidpoint(tokenId) {
  try {
    const data = await fetchJson(
      `${CLOB}/midpoint?token_id=${encodeURIComponent(tokenId)}`
    );
    const p = Number(data?.mid ?? data?.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch (_) {
    return null;
  }
}

/**
 * Current market price for a token:
 * WS mid → HTTP midpoint → last-trade → book mid
 */
async function getMarketPrice(tokenId) {
  const id = String(tokenId || '');
  if (id) {
    marketWs.subscribe([id]);
    const top = marketWs.getFreshTop(id);
    if (top?.bid && top?.ask) {
      return {
        price: (top.bid.price + top.ask.price) / 2,
        source: top.source || 'ws',
      };
    }
  }

  const mid = await getMidpoint(tokenId);
  if (mid != null) return { price: mid, source: 'midpoint' };
  const last = await getLastTradePrice(tokenId);
  if (last != null) return { price: last, source: 'last-trade' };
  try {
    const book = await getBook(tokenId);
    const ask = bestAskFromBook(book);
    const bid = bestBidFromBook(book);
    if (ask && bid) {
      return { price: (ask.price + bid.price) / 2, source: 'book-mid' };
    }
    if (ask) return { price: ask.price, source: 'ask' };
    if (bid) return { price: bid.price, source: 'bid' };
  } catch (_) {
    /* ignore */
  }
  return { price: null, source: 'missing' };
}

async function getPairMarketPrices(market) {
  const [up, down] = await Promise.all([
    getMarketPrice(market.upTokenId),
    getMarketPrice(market.downTokenId),
  ]);
  return { up, down };
}

module.exports = {
  getBook,
  getBestAsk,
  getBestBid,
  getPairAsks,
  getPairQuotes,
  getLastTradePrice,
  getMidpoint,
  getMarketPrice,
  getPairMarketPrices,
  bestAskFromBook,
  bestBidFromBook,
};
