const GAMMA = 'https://gamma-api.polymarket.com';
const WINDOW_SEC = 300;

function windowStartUnix(tsSec = Math.floor(Date.now() / 1000)) {
  return tsSec - (tsSec % WINDOW_SEC);
}

function parseJsonField(v, fallback = []) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (_) { return fallback; }
  }
  return fallback;
}

async function fetchJson(url, timeoutMs = 8000) {
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

function normalizeMarket(event, market) {
  if (!event || !market) return null;
  const slug = String(market.slug || event.slug || '');
  const m = slug.match(/btc-updown-5m-(\d+)/);
  if (!m) return null;
  const windowStart = Number(m[1]);
  const outcomes = parseJsonField(market.outcomes, ['Up', 'Down']);
  const tokens = parseJsonField(market.clobTokenIds, []).map(String);
  if (tokens.length < 2) return null;
  const upIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'up');
  const downIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'down');
  const ui = upIdx >= 0 ? upIdx : 0;
  const di = downIdx >= 0 ? downIdx : 1;
  return {
    slug,
    title: market.question || event.title || slug,
    conditionId: String(market.conditionId || ''),
    windowStart,
    windowEnd: windowStart + WINDOW_SEC,
    endDate: market.endDate || event.endDate || null,
    acceptingOrders: market.acceptingOrders !== false && !market.closed && !event.closed,
    closed: Boolean(market.closed || event.closed),
    upTokenId: tokens[ui],
    downTokenId: tokens[di],
    outcomes: { up: outcomes[ui] || 'Up', down: outcomes[di] || 'Down' },
  };
}

async function fetchMarketByWindowStart(windowStart) {
  const slug = `btc-updown-5m-${windowStart}`;
  const data = await fetchJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  const event = Array.isArray(data) ? data[0] : data;
  if (!event) return null;
  const market = (event.markets || [])[0];
  return normalizeMarket(event, market);
}

/** Current + next window (so we can pre-warm near boundaries). */
async function discoverTradeableMarkets(nowSec = Math.floor(Date.now() / 1000)) {
  const start = windowStartUnix(nowSec);
  const out = [];
  for (const ws of [start, start + WINDOW_SEC]) {
    try {
      const m = await fetchMarketByWindowStart(ws);
      if (m && m.acceptingOrders && !m.closed) out.push(m);
    } catch (_) {
      /* ignore missing windows */
    }
  }
  return out;
}

function secondsIntoWindow(market, nowSec = Math.floor(Date.now() / 1000)) {
  return nowSec - Number(market.windowStart);
}

function secondsLeft(market, nowSec = Math.floor(Date.now() / 1000)) {
  return Number(market.windowEnd) - nowSec;
}

module.exports = {
  WINDOW_SEC,
  windowStartUnix,
  fetchMarketByWindowStart,
  discoverTradeableMarkets,
  secondsIntoWindow,
  secondsLeft,
  normalizeMarket,
};
