/**
 * Polymarket CLOB market WebSocket — live best bid/ask (+ optional book snapshot).
 * HTTP /book remains fallback when WS is down or quote is stale.
 *
 * Subscriptions are additive on the server — always unsubscribe removed asset IDs
 * (see Polymarket market WS "Subscription Update" / operation subscribe|unsubscribe).
 */
const WebSocket = require('ws');

const CLOB_WS_MARKET_URL =
  process.env.CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WS_QUOTE_MAX_AGE_MS = parseInt(process.env.WS_QUOTE_MAX_AGE_MS || '8000', 10);
const WS_BOOK_MAX_AGE_MS = parseInt(process.env.WS_BOOK_MAX_AGE_MS || '8000', 10);
const WS_QUOTE_WAIT_MS = parseInt(process.env.WS_QUOTE_WAIT_MS || '350', 10);

let _log = () => {};

function setLogger(fn) {
  _log = typeof fn === 'function' ? fn : () => {};
}

function parsePositivePrice(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePositiveSize(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function bestFromLevels(levels, side) {
  const arr = Array.isArray(levels) ? levels : [];
  let best = null;
  for (const lvl of arr) {
    const price = parsePositivePrice(lvl?.price);
    const size = parsePositiveSize(lvl?.size);
    if (price == null || size == null) continue;
    if (!best) {
      best = { price, size };
      continue;
    }
    if (side === 'bid' && price > best.price) best = { price, size };
    if (side === 'ask' && price < best.price) best = { price, size };
  }
  return best;
}

const marketWs = {
  ws: null,
  connecting: null,
  pingTimer: null,
  reconnectTimer: null,
  stopped: true,
  /** @type {Set<string>} */
  subscribed: new Set(),
  /** @type {Map<string, { bid: number|null, ask: number|null, bidSize: number|null, askSize: number|null, updatedAt: number, source: string }>} */
  quotes: new Map(),
  /** @type {Map<string, { book: object, updatedAt: number }>} */
  books: new Map(),
  /** @type {Map<string, Array<() => void>>} */
  waiters: new Map(),
  lastError: null,
  connectedAt: null,

  start() {
    this.stopped = false;
  },

  stop() {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._closeSocket();
    this.connecting = null;
  },

  _closeSocket() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      } else {
        ws.close();
      }
    } catch (_) { /* ignore */ }
  },

  status() {
    const open = !!(this.ws && this.ws.readyState === WebSocket.OPEN);
    return {
      enabled: !this.stopped,
      connected: open,
      subscribed: this.subscribed.size,
      quotes: this.quotes.size,
      books: this.books.size,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
    };
  },

  ensureConnected() {
    if (this.stopped) return Promise.resolve();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;

    // Drop half-open / errored socket before opening another (avoids FD leak).
    if (this.ws) this._closeSocket();

    this.connecting = new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        resolve();
      };

      try {
        const ws = new WebSocket(CLOB_WS_MARKET_URL);
        this.ws = ws;

        ws.on('open', () => {
          if (this.ws !== ws) {
            try { ws.terminate(); } catch (_) { /* ignore */ }
            done();
            return;
          }
          this.lastError = null;
          this.connectedAt = new Date().toISOString();
          if (this.pingTimer) clearInterval(this.pingTimer);
          this.pingTimer = setInterval(() => {
            try {
              if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send('PING');
            } catch (_) { /* ignore */ }
          }, 10_000);
          const ids = [...this.subscribed];
          if (ids.length) this._sendInitialSubscribe(ids);
          _log(`CLOB market WS connected (${ids.length} token sub)`, 'info');
          done();
        });

        ws.on('message', (data) => {
          if (this.ws !== ws) return;
          this.onMessage(data);
        });

        ws.on('error', (err) => {
          this.lastError = err.message;
          _log(`CLOB market WS error: ${err.message}`, 'warning');
          if (this.ws === ws) this.ws = null;
          done();
        });

        ws.on('close', () => {
          if (this.ws === ws) this.ws = null;
          if (this.pingTimer) clearInterval(this.pingTimer);
          this.pingTimer = null;
          this.connecting = null;
          this.connectedAt = null;
          if (!this.stopped && this.subscribed.size > 0) {
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => void this.ensureConnected(), 1500);
          }
        });
      } catch (err) {
        this.lastError = err.message;
        _log(`CLOB market WS connect failed: ${err.message}`, 'warning');
        this.ws = null;
        done();
      }
    });

    return this.connecting;
  },

  /** First subscribe on a fresh connection (type: market). */
  _sendInitialSubscribe(assetIds) {
    const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
    if (!ids.length) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({
        assets_ids: ids,
        type: 'market',
        custom_feature_enabled: true,
      }));
    } catch (_) { /* ignore */ }
  },

  /** Dynamic add on an existing connection. */
  _sendSubscribe(assetIds) {
    const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
    if (!ids.length) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({
        assets_ids: ids,
        operation: 'subscribe',
        custom_feature_enabled: true,
      }));
    } catch (_) { /* ignore */ }
  },

  /** Dynamic remove — required; server subscriptions are additive. */
  _sendUnsubscribe(assetIds) {
    const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
    if (!ids.length) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({
        assets_ids: ids,
        operation: 'unsubscribe',
      }));
    } catch (_) { /* ignore */ }
  },

  _pruneCaches() {
    for (const id of [...this.quotes.keys()]) {
      if (!this.subscribed.has(id)) this.quotes.delete(id);
    }
    for (const id of [...this.books.keys()]) {
      if (!this.subscribed.has(id)) this.books.delete(id);
    }
    for (const id of [...this.waiters.keys()]) {
      if (this.subscribed.has(id)) continue;
      const wait = this.waiters.get(id) || [];
      this.waiters.delete(id);
      for (const fn of wait) {
        try { fn(); } catch (_) { /* ignore */ }
      }
    }
  },

  /** Replace active token set; unsubscribe removed IDs on the live socket. */
  syncSubscriptions(assetIds) {
    const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
    const prev = this.subscribed;
    const same = ids.length === prev.size && ids.every((id) => prev.has(id));
    const removed = [...prev].filter((id) => !ids.includes(id));
    const added = ids.filter((id) => !prev.has(id));

    this.subscribed = new Set(ids);
    this._pruneCaches();

    if (!ids.length) {
      if (removed.length && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this._sendUnsubscribe(removed);
      }
      return;
    }

    this.start();
    if (same && this.ws && this.ws.readyState === WebSocket.OPEN) return;

    void this.ensureConnected().then(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (removed.length) this._sendUnsubscribe(removed);
      if (added.length) this._sendSubscribe(added);
      else if (!same) this._sendInitialSubscribe(ids);
      if (!same) {
        _log(
          `CLOB market WS sync ${ids.length} tokens (+${added.length}/-${removed.length})`,
          'info'
        );
      }
    });
  },

  subscribe(assetIds) {
    const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
    if (!ids.length) return;
    const added = [];
    for (const id of ids) {
      if (!this.subscribed.has(id)) {
        this.subscribed.add(id);
        added.push(id);
      }
    }
    this.start();
    void this.ensureConnected().then(() => {
      if (!added.length) return;
      this._sendSubscribe(added);
    });
  },

  upsertQuote(assetId, patch, source) {
    const id = String(assetId || '');
    if (!id || !this.subscribed.has(id)) return;
    const prev = this.quotes.get(id) || {
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      updatedAt: 0,
      source,
    };
    const next = {
      bid: Object.prototype.hasOwnProperty.call(patch, 'bid') ? patch.bid : prev.bid,
      ask: Object.prototype.hasOwnProperty.call(patch, 'ask') ? patch.ask : prev.ask,
      bidSize: Object.prototype.hasOwnProperty.call(patch, 'bidSize') ? patch.bidSize : prev.bidSize,
      askSize: Object.prototype.hasOwnProperty.call(patch, 'askSize') ? patch.askSize : prev.askSize,
      updatedAt: Date.now(),
      source: source || prev.source || 'ws',
    };
    this.quotes.set(id, next);
    const wait = this.waiters.get(id);
    if (wait && wait.length) {
      this.waiters.delete(id);
      for (const fn of wait) {
        try { fn(); } catch (_) { /* ignore */ }
      }
    }
  },

  onMessage(data) {
    const raw = typeof data === 'string' ? data : data.toString();
    if (!raw || raw === 'PONG' || raw === 'PING') return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const et = ev.event_type || ev.type;

      if (et === 'book') {
        const assetId = ev.asset_id || ev.assetId
          || (ev.payload && (ev.payload.tokenId || ev.payload.asset_id));
        if (!assetId || !this.subscribed.has(String(assetId))) continue;
        const book = ev.payload && (ev.payload.bids || ev.payload.asks) ? ev.payload : ev;
        if (Array.isArray(book.bids) || Array.isArray(book.asks)) {
          this.books.set(String(assetId), { book, updatedAt: Date.now() });
        }
        const bid = bestFromLevels(book.bids, 'bid');
        const ask = bestFromLevels(book.asks, 'ask');
        this.upsertQuote(assetId, {
          bid: bid ? bid.price : null,
          ask: ask ? ask.price : null,
          bidSize: bid ? bid.size : null,
          askSize: ask ? ask.size : null,
        }, 'ws_book');
      } else if (et === 'best_bid_ask') {
        const assetId = ev.asset_id || ev.assetId || ev.token_id || ev.tokenId
          || (ev.payload && (ev.payload.asset_id || ev.payload.tokenId));
        if (!assetId || !this.subscribed.has(String(assetId))) continue;
        const src = ev.payload || ev;
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(src, 'best_bid')
          || Object.prototype.hasOwnProperty.call(src, 'bestBid')) {
          patch.bid = parsePositivePrice(src.best_bid ?? src.bestBid);
        }
        if (Object.prototype.hasOwnProperty.call(src, 'best_ask')
          || Object.prototype.hasOwnProperty.call(src, 'bestAsk')) {
          patch.ask = parsePositivePrice(src.best_ask ?? src.bestAsk);
        }
        if (Object.prototype.hasOwnProperty.call(src, 'best_bid_size')
          || Object.prototype.hasOwnProperty.call(src, 'bestBidSize')) {
          patch.bidSize = parsePositiveSize(src.best_bid_size ?? src.bestBidSize);
        }
        if (Object.prototype.hasOwnProperty.call(src, 'best_ask_size')
          || Object.prototype.hasOwnProperty.call(src, 'bestAskSize')) {
          patch.askSize = parsePositiveSize(src.best_ask_size ?? src.bestAskSize);
        }
        this.upsertQuote(assetId, patch, 'ws_bba');
      } else if (et === 'price_change') {
        const changes = ev.price_changes || (ev.payload && ev.payload.price_changes) || [];
        for (const ch of changes) {
          if (!ch) continue;
          const assetId = ch.asset_id || ch.assetId || ch.token_id || ch.tokenId;
          if (!assetId || !this.subscribed.has(String(assetId))) continue;
          const patch = {};
          if (Object.prototype.hasOwnProperty.call(ch, 'best_bid')
            || Object.prototype.hasOwnProperty.call(ch, 'bestBid')) {
            patch.bid = parsePositivePrice(ch.best_bid ?? ch.bestBid);
          }
          if (Object.prototype.hasOwnProperty.call(ch, 'best_ask')
            || Object.prototype.hasOwnProperty.call(ch, 'bestAsk')) {
            patch.ask = parsePositivePrice(ch.best_ask ?? ch.bestAsk);
          }
          if (Object.prototype.hasOwnProperty.call(ch, 'best_bid_size')
            || Object.prototype.hasOwnProperty.call(ch, 'bestBidSize')) {
            patch.bidSize = parsePositiveSize(ch.best_bid_size ?? ch.bestBidSize);
          }
          if (Object.prototype.hasOwnProperty.call(ch, 'best_ask_size')
            || Object.prototype.hasOwnProperty.call(ch, 'bestAskSize')) {
            patch.askSize = parsePositiveSize(ch.best_ask_size ?? ch.bestAskSize);
          }
          if (!Object.keys(patch).length) continue;
          this.upsertQuote(assetId, patch, 'ws_pc');
        }
      }
    }
  },

  getFreshQuote(tokenId) {
    const q = this.quotes.get(String(tokenId));
    if (!q) return null;
    if (Date.now() - q.updatedAt > WS_QUOTE_MAX_AGE_MS) return null;
    return q;
  },

  getFreshBook(tokenId) {
    const row = this.books.get(String(tokenId));
    if (!row) return null;
    if (Date.now() - row.updatedAt > WS_BOOK_MAX_AGE_MS) return null;
    return row.book;
  },

  /** Top-of-book: { bid|ask: { price, size }|null, source } */
  getFreshTop(tokenId) {
    const q = this.getFreshQuote(tokenId);
    if (!q) return null;
    return {
      bid: q.bid != null ? { price: q.bid, size: q.bidSize != null ? q.bidSize : 0 } : null,
      ask: q.ask != null ? { price: q.ask, size: q.askSize != null ? q.askSize : 0 } : null,
      source: q.source,
      updatedAt: q.updatedAt,
    };
  },

  waitForQuote(tokenId, timeoutMs = WS_QUOTE_WAIT_MS) {
    const id = String(tokenId);
    return new Promise((resolve) => {
      const existing = this.getFreshQuote(id);
      if (existing && (existing.bid != null || existing.ask != null)) {
        resolve(existing);
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const arr = this.waiters.get(id);
        if (arr) {
          const i = arr.indexOf(finish);
          if (i >= 0) arr.splice(i, 1);
          if (!arr.length) this.waiters.delete(id);
        }
        resolve(this.getFreshQuote(id));
      };
      if (!this.waiters.has(id)) this.waiters.set(id, []);
      this.waiters.get(id).push(finish);
      setTimeout(finish, Math.max(50, timeoutMs));
    });
  },

  async ensureTops(tokenIds, waitMs = WS_QUOTE_WAIT_MS) {
    const ids = [...new Set((tokenIds || []).map(String).filter(Boolean))];
    this.subscribe(ids);
    await this.ensureConnected();
    await Promise.all(ids.map(async (id) => {
      const q = this.getFreshQuote(id);
      if (q && (q.bid != null || q.ask != null)) return;
      await this.waitForQuote(id, waitMs);
    }));
  },
};

module.exports = {
  marketWs,
  setLogger,
  WS_QUOTE_MAX_AGE_MS,
  WS_QUOTE_WAIT_MS,
};
