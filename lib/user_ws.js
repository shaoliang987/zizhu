const WebSocket = require('ws');

const USER_WS_URL =
  process.env.CLOB_USER_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const MAX_QUEUE = Math.max(100, parseInt(process.env.CLOB_USER_WS_MAX_QUEUE || '5000', 10));
const CONNECT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.CLOB_USER_WS_CONNECT_TIMEOUT_MS || '10000', 10));

function finiteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseUserMessage(raw, tokenMap = new Map()) {
  const out = [];
  const rows = Array.isArray(raw) ? raw : [raw];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.event_type || item.type || '').toLowerCase();
    if (type === 'order') {
      const orderId = String(item.id || item.order_id || '').trim();
      if (!orderId) continue;
      const action = String(item.type || item.status || '').toUpperCase();
      const tokenId = String(item.asset_id || item.token_id || '');
      const token = tokenMap.get(tokenId) || null;
      if (action.includes('CANCEL')) {
        out.push({ kind: 'order_cancelled', orderId, tokenId, ...token });
        continue;
      }
      if (action === 'UPDATE' || action === 'PLACEMENT' || action.includes('MATCH')) {
        const matchedTotal = finiteNumber(item.size_matched);
        if (matchedTotal != null && matchedTotal > 0) {
          out.push({
            kind: 'order_fill_total',
            orderId,
            tokenId,
            matchedTotal,
            price: finiteNumber(item.price),
            ...token,
          });
        }
      }
      continue;
    }
    if (type !== 'trade') continue;
    const status = String(item.status || '').toUpperCase();
    if (status !== 'MATCHED' && status !== 'CONFIRMED') continue;
    const orderId = String(item.taker_order_id || '').trim();
    const tokenId = String(item.asset_id || item.token_id || '');
    const size = finiteNumber(item.size);
    const price = finiteNumber(item.price);
    if (!orderId || !(size > 0) || !(price > 0)) continue;
    out.push({
      kind: 'trade_fill',
      orderId,
      tradeId: String(item.id || item.trade_id || '').trim() || null,
      tokenId,
      size,
      price,
      ...tokenMap.get(tokenId),
    });
  }
  return out;
}

const userWs = {
  ws: null,
  stopped: true,
  connecting: false,
  reconnectTimer: null,
  credentialTimer: null,
  pingTimer: null,
  markets: new Map(),
  tokenMap: new Map(),
  queue: [],
  creds: null,
  lastError: null,
  connectedAt: null,
  subscriptionSent: false,
  eventReceivedAt: null,
  queueOverflow: 0,
  getCreds: null,
  log: () => {},

  setLogger(fn) { this.log = typeof fn === 'function' ? fn : () => {}; },
  async start(getCreds) {
    this.stopped = false;
    this.getCreds = getCreds;
    try { this.creds = await getCreds(); } catch (err) {
      this.lastError = err.message;
      this.log(`CLOB user WS credentials failed: ${err.message}`, 'warning');
      if (!this.stopped && !this.credentialTimer) {
        this.credentialTimer = setTimeout(async () => {
          this.credentialTimer = null;
          await this.start(this.getCreds);
        }, 5000);
      }
      return;
    }
    this.ensureConnected();
  },
  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.credentialTimer) clearTimeout(this.credentialTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.credentialTimer = null;
    this.pingTimer = null;
    if (this.ws) try { this.ws.terminate(); } catch (_) { /* ignore */ }
    this.ws = null;
    this.subscriptionSent = false;
  },
  syncMarkets(markets = []) {
    const next = new Map();
    const tokens = new Map();
    for (const m of markets) {
      if (!m?.conditionId) continue;
      next.set(String(m.conditionId), m);
      if (m.upTokenId) tokens.set(String(m.upTokenId), { conditionId: String(m.conditionId), outcome: 'Up' });
      if (m.downTokenId) tokens.set(String(m.downTokenId), { conditionId: String(m.conditionId), outcome: 'Down' });
    }
    const changed = [...next.keys()].sort().join(',') !== [...this.markets.keys()].sort().join(',');
    this.markets = next;
    this.tokenMap = tokens;
    if (changed && this.ws) {
      try { this.ws.terminate(); } catch (_) { /* ignore */ }
    } else if (!this.stopped) {
      this.ensureConnected();
    }
  },
  enqueue(events) {
    if (!events?.length) return;
    this.queue.push(...events);
    if (this.queue.length > MAX_QUEUE) {
      const excess = this.queue.length - MAX_QUEUE;
      this.queue.splice(0, excess);
      this.queueOverflow += excess;
      this.lastError = `user event queue overflow: dropped ${this.queueOverflow}`;
      this.log(`CLOB user WS queue overflow · dropped=${this.queueOverflow} · REST reconciliation required`, 'error');
    }
  },
  drain() { return this.queue.splice(0, this.queue.length); },
  status() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      subscriptionSent: this.subscriptionSent,
      eventReceivedAt: this.eventReceivedAt,
      queued: this.queue.length,
      queueOverflow: this.queueOverflow,
      markets: this.markets.size,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
    };
  },
  ensureConnected() {
    if (this.stopped || this.connecting || !this.creds || !this.markets.size) return;
    this.connecting = true;
    const ws = new WebSocket(USER_WS_URL);
    this.ws = ws;
    let handledClose = false;
    const connectTimeout = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) {
        this.lastError = 'user websocket connect timeout';
        try { ws.terminate(); } catch (_) { /* ignore */ }
      }
    }, CONNECT_TIMEOUT_MS);
    ws.on('open', () => {
      if (this.ws !== ws) return;
      clearTimeout(connectTimeout);
      this.connecting = false;
      this.lastError = null;
      this.connectedAt = new Date().toISOString();
      ws.send(JSON.stringify({
        auth: { apiKey: this.creds.key, secret: this.creds.secret, passphrase: this.creds.passphrase },
        markets: [...this.markets.keys()],
        type: 'user',
      }));
      this.subscriptionSent = true;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) try { ws.send('PING'); } catch (_) { /* ignore */ }
      }, 10_000);
      this.log(`CLOB user WS connected (${this.markets.size} market sub)`, 'info');
    });
    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      const text = String(data);
      if (/^pong$/i.test(text)) return;
      try {
        const events = parseUserMessage(JSON.parse(text), this.tokenMap);
        if (events.length) this.eventReceivedAt = new Date().toISOString();
        this.enqueue(events);
      } catch (_) { /* ignore malformed */ }
    });
    const closed = (err) => {
      if (handledClose) return;
      handledClose = true;
      clearTimeout(connectTimeout);
      if (err) this.lastError = err.message || String(err);
      // A delayed close from an old socket must not clear a newer connection's
      // heartbeat/status or schedule another reconnect.
      if (this.ws !== ws) return;
      this.ws = null;
      this.connecting = false;
      this.connectedAt = null;
      this.subscriptionSent = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (!this.stopped && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.ensureConnected();
        }, 2000);
      }
    };
    ws.on('error', (err) => {
      if (this.ws === ws) {
        this.lastError = err.message || String(err);
        try { ws.terminate(); } catch (_) { /* ignore */ }
      }
      closed(err);
    });
    ws.on('close', () => closed());
  },
};

module.exports = { parseUserMessage, userWs };
