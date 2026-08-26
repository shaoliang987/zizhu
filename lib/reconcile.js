/**
 * Reconciliation by 5m market window — fills + settlements (+ open marks).
 * Ledger vs marks: per-position detail and per-window summary for pair-arb.
 */
const { readJsonl } = require('./paths');
const { readFills, positionInvested } = require('./ledger');
const { rnd } = require('./fees');
const { isDryRun } = require('./mode');

function windowLabelFromTitle(title, slug) {
  const s = String(title || '');
  const m = s.match(/-\s*(.+)$/);
  if (m) return m[1].trim();
  if (slug) return String(slug);
  return title || '—';
}

function readSettlements() {
  try {
    return readJsonl('settlement_log.jsonl') || [];
  } catch (_) {
    return [];
  }
}

/** Latest settlement row per conditionId (log may contain duplicates). */
function latestSettlementByCondition(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row || !row.conditionId) continue;
    const prev = map.get(row.conditionId);
    if (!prev || String(row.ts || '') >= String(prev.ts || '')) {
      const merged = { ...row };
      if (merged.upMark == null && prev?.upMark != null) merged.upMark = prev.upMark;
      if (merged.downMark == null && prev?.downMark != null) merged.downMark = prev.downMark;
      map.set(row.conditionId, merged);
    } else if (prev) {
      if (prev.upMark == null && row.upMark != null) prev.upMark = row.upMark;
      if (prev.downMark == null && row.downMark != null) prev.downMark = row.downMark;
    }
  }
  return map;
}

function outcomeFromMarks(upMark, downMark) {
  const u = Number(upMark);
  const d = Number(downMark);
  if (u >= 0.99 && d <= 0.01) return 'Up';
  if (d >= 0.99 && u <= 0.01) return 'Down';
  if (Number.isFinite(u) && Number.isFinite(d) && Math.abs(u + d - 1) < 0.02) {
    return u >= d ? 'Up' : 'Down';
  }
  return null;
}

function centsLabel(price) {
  // Number(null) === 0 in JS — treat null/undefined as missing, not 0¢
  if (price == null || price === '') return '—';
  const p = Number(price);
  if (!Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(1)}¢ ($${p.toFixed(2)})`;
}

function settlePriceLabel(outcome, upMark, downMark) {
  if (outcome === 'Up' && upMark != null) return `Up ${centsLabel(upMark)}`;
  if (outcome === 'Down' && downMark != null) return `Down ${centsLabel(downMark)}`;
  if (upMark != null || downMark != null) {
    return `Up ${centsLabel(upMark)} / Down ${centsLabel(downMark)}`;
  }
  return '—';
}

function emptyWindow(conditionId) {
  return {
    conditionId,
    slug: null,
    title: null,
    window_label: '—',
    windowStart: null,
    windowEnd: null,
    fill_count: 0,
    up_fills: 0,
    down_fills: 0,
    up_shares: 0,
    down_shares: 0,
    total_shares: 0,
    up_cost: 0,
    down_cost: 0,
    total_cost: 0,
    fees: 0,
    avg_price: null,
    status: 'open',
    outcome: null,
    up_mark: null,
    down_mark: null,
    settle_price_label: '—',
    realized_pnl_usdc: 0,
    unrealized_pnl_usdc: 0,
    total_pnl_usdc: 0,
    win: null,
    settled_at: null,
    settle_reason: null,
  };
}

/**
 * @param {object} state
 * @param {Array} marks from markOpenPositions
 */
function buildReconcileReport(state, marks = []) {
  const byId = new Map();
  const ensure = (id) => {
    if (!byId.has(id)) byId.set(id, emptyWindow(id));
    return byId.get(id);
  };

  const fills = [];
  for (const t of readFills() || []) {
    if (!t || !t.conditionId) continue;
    const typ = String(t.type || '');
    const isBuy = typ === 'PAPER_BUY' || typ === 'LIVE_BUY';
    const isSell = typ === 'LIVE_SELL' || typ === 'PAPER_SELL';
    if (!isBuy && !isSell) continue;
    fills.push(t);
    if (!isBuy) continue; // cost/share aggregates are buy-only
    const w = ensure(t.conditionId);
    w.slug = t.slug || w.slug;
    w.title = t.title || w.title;
    w.window_label = windowLabelFromTitle(w.title, w.slug);
    w.fill_count += 1;
    const sh = Number(t.shares) || 0;
    const cost = Number(t.cost) != null && Number.isFinite(Number(t.cost))
      ? Number(t.cost)
      : (Number(t.notional) || 0) + (Number(t.fee) || 0);
    const fee = Number(t.fee) || 0;
    if (t.side === 'Up') {
      w.up_fills += 1;
      w.up_shares = rnd(w.up_shares + sh, 6);
      w.up_cost = rnd(w.up_cost + cost, 4);
    } else if (t.side === 'Down') {
      w.down_fills += 1;
      w.down_shares = rnd(w.down_shares + sh, 6);
      w.down_cost = rnd(w.down_cost + cost, 4);
    }
    w.total_shares = rnd(w.up_shares + w.down_shares, 6);
    w.total_cost = rnd(w.up_cost + w.down_cost, 4);
    w.fees = rnd(w.fees + fee, 6);
  }

  for (const w of byId.values()) {
    w.avg_price = w.total_shares > 1e-9 ? rnd(w.total_cost / w.total_shares, 4) : null;
  }

  const settleMap = latestSettlementByCondition(readSettlements());
  for (const [id, row] of settleMap.entries()) {
    const w = ensure(id);
    w.slug = row.slug || w.slug;
    w.title = row.title || w.title;
    w.window_label = windowLabelFromTitle(w.title, w.slug);
    w.status = 'settled';
    if (row.upMark != null) w.up_mark = Number(row.upMark);
    if (row.downMark != null) w.down_mark = Number(row.downMark);
    w.outcome = outcomeFromMarks(w.up_mark, w.down_mark);
    w.realized_pnl_usdc = rnd(Number(row.realized) || 0, 4);
    w.settled_at = row.ts || null;
    w.settle_reason = row.reason || null;
    if (w.fees <= 0 && row.fees != null) w.fees = rnd(Number(row.fees) || 0, 6);
    w.settle_price_label = settlePriceLabel(w.outcome, w.up_mark, w.down_mark);
    w.win = w.realized_pnl_usdc > 1e-8 ? true : w.realized_pnl_usdc < -1e-8 ? false : null;
  }

  const markById = Object.fromEntries((marks || []).map((m) => [m.conditionId, m]));
  for (const pos of Object.values(state.positions || {})) {
    if (!pos || !pos.conditionId) continue;
    const w = ensure(pos.conditionId);
    w.slug = pos.slug || w.slug;
    w.title = pos.title || w.title;
    w.window_label = windowLabelFromTitle(w.title, w.slug);
    w.windowStart = pos.windowStart || w.windowStart;
    w.windowEnd = pos.windowEnd || w.windowEnd;

    if (pos.settled) {
      w.status = 'settled';
      if (w.realized_pnl_usdc === 0 && pos.realizedPnl != null) {
        w.realized_pnl_usdc = rnd(Number(pos.realizedPnl) || 0, 4);
      }
      if (w.up_mark == null && pos.upMark != null) w.up_mark = Number(pos.upMark);
      if (w.down_mark == null && pos.downMark != null) w.down_mark = Number(pos.downMark);
      if (!w.outcome) w.outcome = outcomeFromMarks(w.up_mark, w.down_mark);
      if (w.win == null) {
        w.win = w.realized_pnl_usdc > 1e-8 ? true : w.realized_pnl_usdc < -1e-8 ? false : null;
      }
      w.settle_price_label = settlePriceLabel(w.outcome, w.up_mark, w.down_mark);
      continue;
    }

    const upSh = Number(pos.upShares) || 0;
    const downSh = Number(pos.downShares) || 0;
    if (upSh > 1e-8 || downSh > 1e-8) {
      w.status = 'open';
      if (w.total_cost <= 0) {
        w.up_shares = upSh;
        w.down_shares = downSh;
        w.up_cost = Number(pos.upCost) || 0;
        w.down_cost = Number(pos.downCost) || 0;
        w.total_shares = rnd(upSh + downSh, 6);
        w.total_cost = rnd(positionInvested(pos), 4);
        w.avg_price = w.total_shares > 1e-9 ? rnd(w.total_cost / w.total_shares, 4) : null;
      }
      const m = markById[pos.conditionId];
      if (m && m.unrealized != null && Number.isFinite(Number(m.unrealized))) {
        w.unrealized_pnl_usdc = rnd(Number(m.unrealized), 4);
      }
    }
  }

  for (const w of byId.values()) {
    w.total_pnl_usdc = rnd(
      (Number(w.realized_pnl_usdc) || 0) + (Number(w.unrealized_pnl_usdc) || 0),
      4
    );
    w.avg_price_cents = w.avg_price != null ? rnd(w.avg_price * 100, 1) : null;
  }

  const windows = [...byId.values()].sort((a, b) => {
    const ae = Number(a.windowEnd) || 0;
    const be = Number(b.windowEnd) || 0;
    if (ae !== be) return be - ae;
    return String(b.settled_at || b.title || '').localeCompare(String(a.settled_at || a.title || ''));
  });

  const tradeFills = fills
    .map((t) => ({
      ts: t.ts,
      type: t.type,
      conditionId: t.conditionId,
      slug: t.slug,
      title: t.title,
      window_label: windowLabelFromTitle(t.title, t.slug),
      side: t.side,
      shares: Number(t.shares) || 0,
      price: Number(t.price) || 0,
      cost: Number(t.cost) || 0,
      fee: Number(t.fee) || 0,
      liquidity: t.liquidity || null,
      orderId: t.orderId || null,
    }))
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

  const summary = {
    fill_count: tradeFills.length,
    window_count: windows.length,
    open_windows: windows.filter((w) => w.status === 'open').length,
    settled_windows: windows.filter((w) => w.status === 'settled').length,
    total_cost_usdc: rnd(windows.reduce((s, w) => s + (Number(w.total_cost) || 0), 0), 4),
    realized_pnl_usdc: rnd(windows.reduce((s, w) => s + (Number(w.realized_pnl_usdc) || 0), 0), 4),
    unrealized_pnl_usdc: rnd(
      windows.reduce((s, w) => s + (Number(w.unrealized_pnl_usdc) || 0), 0),
      4
    ),
  };
  summary.total_pnl_usdc = rnd(summary.realized_pnl_usdc + summary.unrealized_pnl_usdc, 4);

  return {
    source: 'strategy_ledger',
    note: '仅含 PAPER_BUY / LIVE_BUY 成交，按 5m 窗口汇总，便于与账本核对',
    summary,
    windows,
    fills: tradeFills,
  };
}

/**
 * Align reconcile *summary* with account cash-truth.
 * Per-window realized stays strategy/official-closed (do not smear drift into days).
 */
function applyLiveReconcileCalibration(report, state, account = null) {
  if (!report || !state) return report;

  const capital = Number(state.initial_capital_usdc) || 0;
  const windows = report.windows || [];
  const summaryUnrealized = rnd(
    windows.reduce((s, w) => s + (Number(w.unrealized_pnl_usdc) || 0), 0),
    4
  );
  const strategyRealized = rnd(
    windows.reduce((s, w) => s + (Number(w.realized_pnl_usdc) || 0), 0),
    4
  );

  let targetRealized = null;
  if (!isDryRun() && account?.equity_usdc != null) {
    const accountTotal = rnd(account.equity_usdc - capital, 4);
    targetRealized = rnd(accountTotal - summaryUnrealized, 4);
  } else if (state.stats?.realized_pnl_clob_drift_usdc != null) {
    targetRealized = rnd(Number(state.stats.realized_pnl_usdc) || 0, 4);
  } else {
    const hasOpen = windows.some((w) => w.status === 'open');
    if (!hasOpen) {
      targetRealized = rnd((Number(state.cash_usdc) || 0) - capital, 4);
    }
  }

  report.summary.strategy_realized_pnl_usdc = strategyRealized;
  report.summary.unrealized_pnl_usdc = summaryUnrealized;

  if (targetRealized == null) {
    report.summary.realized_pnl_usdc = strategyRealized;
    report.summary.total_pnl_usdc = rnd(strategyRealized + summaryUnrealized, 4);
    return report;
  }

  const drift = rnd(targetRealized - strategyRealized, 4);
  report.summary.realized_pnl_clob_drift_usdc = drift;
  report.summary.strategy_realized_pnl_usdc = strategyRealized;
  // Primary totals = account cash/equity truth (initial → now)
  report.summary.realized_pnl_usdc = targetRealized;
  report.summary.account_realized_pnl_usdc = targetRealized;
  report.summary.unrealized_pnl_usdc = summaryUnrealized;
  report.summary.total_pnl_usdc = rnd(targetRealized + summaryUnrealized, 4);
  report.summary.account_total_pnl_usdc = rnd(targetRealized + summaryUnrealized, 4);

  if (Math.abs(drift) > 0.05) {
    report.source = isDryRun() ? 'paper_cash_truth' : 'clob_calibrated';
    report.note =
      (report.note ? `${report.note} · ` : '') +
      `汇总已实现按账户口径 ${targetRealized >= 0 ? '+' : ''}$${targetRealized.toFixed(2)}` +
      `（= 权益 − 初始）· 窗口加总 ${strategyRealized >= 0 ? '+' : ''}$${strategyRealized.toFixed(2)}` +
      ` · 偏差 ${drift >= 0 ? '+' : ''}$${drift.toFixed(2)} 不摊入各窗口`;
  }
  return report;
}

/**
 * Overlay official closed-positions realized onto reconcile windows (live).
 * After activity backfill, skip overlay and keep ledger settlement PnL.
 */
function applyOfficialClosedPnl(report, closedByCondition, state = null) {
  if (!report) return report;

  if (state?.stats?.activity_backfilled_at) {
    report.source = 'activity_backfill';
    report.note = '已实现取自 Polymarket activity 回补账本（买入+卖出+赎回）';
    const realized = rnd(
      (report.windows || []).reduce((s, w) => s + (Number(w.realized_pnl_usdc) || 0), 0),
      4
    );
    const unrealized = rnd(
      (report.windows || []).reduce((s, w) => s + (Number(w.unrealized_pnl_usdc) || 0), 0),
      4
    );
    report.summary.realized_pnl_usdc = realized;
    report.summary.unrealized_pnl_usdc = unrealized;
    report.summary.total_pnl_usdc = rnd(realized + unrealized, 4);
    report.summary.window_count = (report.windows || []).length;
    report.summary.open_windows = (report.windows || []).filter((w) => w.status === 'open').length;
    report.summary.settled_windows = (report.windows || []).filter((w) => w.status === 'settled').length;
    return report;
  }

  if (!closedByCondition || closedByCondition.size === 0) return report;
  const tradedIds = new Set();
  for (const t of readFills() || []) {
    if (!t || (t.type !== 'PAPER_BUY' && t.type !== 'LIVE_BUY')) continue;
    if (t.conditionId) tradedIds.add(t.conditionId);
  }

  const byId = new Map((report.windows || []).map((w) => [w.conditionId, w]));

  for (const [id, closed] of closedByCondition.entries()) {
    if (!tradedIds.has(id)) continue;
    if (!closed.complete) continue;

    let w = byId.get(id);
    if (!w) {
      w = emptyWindow(id);
      byId.set(id, w);
      report.windows.push(w);
    }
    w.slug = closed.slug || w.slug;
    w.title = closed.title || w.title;
    w.window_label = windowLabelFromTitle(w.title, w.slug);
    w.status = 'settled';
    w.strategy_realized_pnl_usdc =
      w.strategy_realized_pnl_usdc != null
        ? w.strategy_realized_pnl_usdc
        : rnd(Number(w.realized_pnl_usdc) || 0, 4);
    w.realized_pnl_usdc = rnd(Number(closed.realized_pnl_usdc) || 0, 4);
    w.unrealized_pnl_usdc = 0;
    w.total_pnl_usdc = w.realized_pnl_usdc;
    if (closed.up_mark != null) w.up_mark = closed.up_mark;
    if (closed.down_mark != null) w.down_mark = closed.down_mark;
    w.outcome = closed.outcome || outcomeFromMarks(w.up_mark, w.down_mark);
    w.win = w.realized_pnl_usdc > 1e-8 ? true : w.realized_pnl_usdc < -1e-8 ? false : null;
    if (closed.total_bought > 0 && !(Number(w.total_cost) > 0)) {
      w.total_cost = rnd(closed.total_bought, 4);
    }
    w.settle_price_label = settlePriceLabel(w.outcome, w.up_mark, w.down_mark);
    w.official_closed = true;
  }

  report.windows = [...byId.values()].sort((a, b) => {
    const ae = Number(a.windowEnd) || 0;
    const be = Number(b.windowEnd) || 0;
    if (ae !== be) return be - ae;
    return String(b.settled_at || b.title || '').localeCompare(String(a.settled_at || a.title || ''));
  });

  for (const w of report.windows) {
    if (w.status === 'settled' && !w.official_closed) {
      w.pending_official = true;
      w.win = w.realized_pnl_usdc > 1e-8 ? true : w.realized_pnl_usdc < -1e-8 ? false : null;
      w.total_pnl_usdc = rnd(
        (Number(w.realized_pnl_usdc) || 0) + (Number(w.unrealized_pnl_usdc) || 0),
        4
      );
    }
  }

  const realized = rnd(
    report.windows.reduce((s, w) => s + (Number(w.realized_pnl_usdc) || 0), 0),
    4
  );
  const unrealized = rnd(
    report.windows.reduce((s, w) => s + (Number(w.unrealized_pnl_usdc) || 0), 0),
    4
  );
  report.summary.realized_pnl_usdc = realized;
  report.summary.unrealized_pnl_usdc = unrealized;
  report.summary.total_pnl_usdc = rnd(realized + unrealized, 4);
  report.summary.window_count = report.windows.length;
  report.summary.open_windows = report.windows.filter((w) => w.status === 'open').length;
  report.summary.settled_windows = report.windows.filter((w) => w.status === 'settled').length;
  report.source = 'polymarket_closed';
  report.note =
    '已实现：官方 closed（Up+Down 两腿齐全）优先，否则用策略结算；仅含本地有成交的窗口';
  return report;
}

module.exports = {
  buildReconcileReport,
  applyLiveReconcileCalibration,
  applyOfficialClosedPnl,
  windowLabelFromTitle,
  outcomeFromMarks,
  centsLabel,
  settlePriceLabel,
  latestSettlementByCondition,
};
