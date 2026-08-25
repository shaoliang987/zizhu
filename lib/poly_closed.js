/**
 * Official Polymarket closed-positions → per-window / per-day realized PnL.
 * Prefer this over strategy ledger for live reporting (matches portfolio UI).
 */
const { rnd } = require('./fees');
const { isDryRun } = require('./mode');

const DATA_API = process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com';

let _cache = { at: 0, rows: null, error: null };

function funderAddress() {
  const addr = String(process.env.POLYMARKET_FUNDER_ADDRESS || '').trim();
  if (!addr) throw new Error('POLYMARKET_FUNDER_ADDRESS missing');
  return addr;
}

/**
 * Fetch closed position legs (each outcome is a row). Paginate until short page.
 */
async function fetchClosedPositionLegs({ force = false, limit = 100, maxPages = 10 } = {}) {
  if (isDryRun()) return [];

  const now = Date.now();
  if (!force && _cache.rows && now - _cache.at < 30_000) {
    return _cache.rows;
  }

  const addr = funderAddress();
  const all = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const url =
      `${DATA_API}/closed-positions?user=${encodeURIComponent(addr)}` +
      `&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      if (_cache.rows) return _cache.rows;
      throw new Error(`data-api /closed-positions ${res.status}`);
    }
    const data = await res.json();
    const rows = Array.isArray(data) ? data : [];
    all.push(...rows);
    if (rows.length < limit) break;
    offset += rows.length;
  }

  _cache = { at: now, rows: all, error: null };
  return all;
}

/**
 * Net realized PnL per conditionId (sum of Up/Down legs).
 */
function aggregateClosedByCondition(legs = []) {
  const byId = new Map();
  for (const row of legs || []) {
    const id = row?.conditionId;
    if (!id) continue;
    let w = byId.get(id);
    if (!w) {
      w = {
        conditionId: id,
        title: row.title || null,
        slug: row.slug || row.eventSlug || null,
        endDate: row.endDate || null,
        realized_pnl_usdc: 0,
        total_bought: 0,
        legs: [],
        outcome: null,
        up_mark: null,
        down_mark: null,
      };
      byId.set(id, w);
    }
    const pnl = Number(row.realizedPnl);
    const bought = Number(row.totalBought);
    if (Number.isFinite(pnl)) w.realized_pnl_usdc = rnd(w.realized_pnl_usdc + pnl, 6);
    if (Number.isFinite(bought)) w.total_bought = rnd(w.total_bought + bought, 6);
    w.legs.push({
      outcome: row.outcome,
      realizedPnl: Number.isFinite(pnl) ? pnl : null,
      avgPrice: row.avgPrice != null ? Number(row.avgPrice) : null,
      curPrice: row.curPrice != null ? Number(row.curPrice) : null,
      totalBought: Number.isFinite(bought) ? bought : null,
    });
    const outcome = String(row.outcome || '');
    const cur = Number(row.curPrice);
    if (outcome === 'Up' && Number.isFinite(cur)) w.up_mark = cur;
    if (outcome === 'Down' && Number.isFinite(cur)) w.down_mark = cur;
    if (w.title == null && row.title) w.title = row.title;
    if (w.slug == null && (row.slug || row.eventSlug)) w.slug = row.slug || row.eventSlug;
  }

  for (const w of byId.values()) {
    w.realized_pnl_usdc = rnd(w.realized_pnl_usdc, 4);
    const outcomes = new Set(w.legs.map((l) => String(l.outcome || '')));
    // API often returns only the winning leg — net would look like a huge win.
    w.complete = outcomes.has('Up') && outcomes.has('Down');
    if (w.up_mark != null && w.up_mark >= 0.99) w.outcome = 'Up';
    else if (w.down_mark != null && w.down_mark >= 0.99) w.outcome = 'Down';
    else if (w.up_mark != null || w.down_mark != null) {
      w.outcome = (Number(w.up_mark) || 0) >= (Number(w.down_mark) || 0) ? 'Up' : 'Down';
    }
  }
  return byId;
}

async function fetchClosedByCondition(opts = {}) {
  const legs = await fetchClosedPositionLegs(opts);
  return aggregateClosedByCondition(legs);
}

module.exports = {
  fetchClosedPositionLegs,
  aggregateClosedByCondition,
  fetchClosedByCondition,
  funderAddress,
};
