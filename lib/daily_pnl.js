/**
 * Daily PnL by market calendar day (ET date on title).
 * Live prefers Polymarket closed-positions; paper uses strategy ledger.
 */
const { positionInvested, readFills } = require('./ledger');
const { rnd } = require('./fees');
const { isDryRun } = require('./mode');

const MONTH_INDEX = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Titles like "Bitcoin Up or Down - August 7, 11:30PM-11:35PM ET"
 * → YYYY-MM-DD in America/New_York calendar sense of that market day.
 */
function marketDayKeyFromTitle(title, fallbackIso) {
  const s = String(title || '');
  const m = s.match(/\b([A-Za-z]+)\s+(\d{1,2})(?:,|\s)(?:\s*(\d{4})\b)?/);
  if (m && MONTH_INDEX[m[1].toLowerCase()] != null) {
    const month = MONTH_INDEX[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    const etYearFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
    });
    let year;
    if (m[3]) {
      year = parseInt(m[3], 10);
    } else if (fallbackIso) {
      try {
        const n = Number(fallbackIso);
        const d = Number.isFinite(n) && n > 1e9
          ? new Date(n < 1e12 ? n * 1000 : n)
          : new Date(fallbackIso);
        if (!Number.isNaN(d.getTime())) year = parseInt(etYearFmt.format(d), 10);
      } catch (_) { /* ignore */ }
    }
    if (!Number.isFinite(year)) {
      year = parseInt(etYearFmt.format(new Date()), 10) || new Date().getFullYear();
    }
    const candidate = Date.UTC(year, month, day);
    if (!m[3] && candidate - Date.now() > 180 * 86400000) year -= 1;
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (fallbackIso) {
    try {
      const n = Number(fallbackIso);
      const d = Number.isFinite(n) && n > 1e9
        ? new Date(n < 1e12 ? n * 1000 : n)
        : new Date(fallbackIso);
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      return fmt.format(d);
    } catch (_) { /* ignore */ }
  }
  return null;
}

function emptyDailyBucket(day) {
  return {
    day,
    realized_pnl_usdc: 0,
    unrealized_pnl_usdc: 0,
    invested_usdc: 0,
    open_positions: 0,
    closed_positions: 0,
    trade_count: 0,
    total_pnl_usdc: 0,
  };
}

function finalizeDailyBuckets(byDay, source = 'strategy_ledger') {
  const days = Object.values(byDay)
    .map((b) => {
      b.realized_pnl_usdc = rnd(b.realized_pnl_usdc, 4);
      b.unrealized_pnl_usdc = rnd(b.unrealized_pnl_usdc, 4);
      b.invested_usdc = rnd(b.invested_usdc, 4);
      b.total_pnl_usdc = rnd(b.realized_pnl_usdc + b.unrealized_pnl_usdc, 4);
      return b;
    })
    .sort((a, b) => a.day.localeCompare(b.day));

  const totalRealized = days.reduce((s, d) => s + d.realized_pnl_usdc, 0);
  const totalUnrealized = days.reduce((s, d) => s + d.unrealized_pnl_usdc, 0);

  return {
    timezone: 'America/New_York',
    source,
    days,
    summary: {
      day_count: days.length,
      realized_pnl_usdc: rnd(totalRealized, 4),
      unrealized_pnl_usdc: rnd(totalUnrealized, 4),
      total_pnl_usdc: rnd(totalRealized + totalUnrealized, 4),
    },
  };
}

function buildDailyPnlFromLedger(state, marks = []) {
  const byDay = {};
  const bucket = (day) => {
    if (!day) return null;
    if (!byDay[day]) byDay[day] = emptyDailyBucket(day);
    return byDay[day];
  };

  const markById = Object.fromEntries(
    (marks || []).map((m) => [m.conditionId, m])
  );

  for (const pos of Object.values(state.positions || {})) {
    if (!pos) continue;
    const day = marketDayKeyFromTitle(
      pos.title,
      pos.settledAt || pos.updatedAt || pos.windowEnd || pos.createdAt
    );
    const b = bucket(day);
    if (!b) continue;

    const realized = Number(pos.realizedPnl) || 0;
    const upSh = Number(pos.upShares) || 0;
    const downSh = Number(pos.downShares) || 0;
    const open = !pos.settled && (upSh > 1e-8 || downSh > 1e-8);

    if (open) {
      const m = markById[pos.conditionId];
      const unreal = m && m.unrealized != null && Number.isFinite(Number(m.unrealized))
        ? Number(m.unrealized)
        : 0;
      b.unrealized_pnl_usdc += unreal;
      b.invested_usdc += positionInvested(pos);
      b.open_positions += 1;
    } else if (pos.settled || Math.abs(realized) > 1e-8) {
      b.realized_pnl_usdc += realized;
      b.closed_positions += 1;
    }
  }

  try {
    for (const t of readFills() || []) {
      if (!t || (t.type !== 'PAPER_BUY' && t.type !== 'LIVE_BUY')) continue;
      const day = marketDayKeyFromTitle(t.title, t.ts);
      const b = bucket(day);
      if (b) b.trade_count += 1;
    }
  } catch (_) { /* ignore */ }

  return finalizeDailyBuckets(byDay, 'strategy_ledger');
}

/**
 * Live daily PnL: complete official closed legs when available, else strategy ledger.
 * Skips empty shells (no local fills) and incomplete one-leg official rows.
 */
function buildDailyPnlFromClosed(state, marks, closedByCondition) {
  const byDay = {};
  const bucket = (day) => {
    if (!day) return null;
    if (!byDay[day]) byDay[day] = emptyDailyBucket(day);
    return byDay[day];
  };

  const tradedIds = new Set();
  try {
    for (const t of readFills() || []) {
      if (!t || (t.type !== 'PAPER_BUY' && t.type !== 'LIVE_BUY')) continue;
      if (t.conditionId) tradedIds.add(t.conditionId);
    }
  } catch (_) { /* ignore */ }

  const markById = Object.fromEntries(
    (marks || []).map((m) => [m.conditionId, m])
  );

  const usedIds = new Set();

  // 1) Complete official closed (both Up+Down legs)
  for (const [id, closed] of closedByCondition.entries()) {
    if (!tradedIds.has(id) || !closed.complete) continue;
    const day = marketDayKeyFromTitle(closed.title, closed.endDate);
    const b = bucket(day);
    if (!b) continue;
    b.realized_pnl_usdc += Number(closed.realized_pnl_usdc) || 0;
    b.closed_positions += 1;
    usedIds.add(id);
  }

  // 2) Strategy ledger for settled positions not covered by complete official
  for (const pos of Object.values(state.positions || {})) {
    if (!pos || !pos.conditionId) continue;
    if (usedIds.has(pos.conditionId)) continue;
    if (!tradedIds.has(pos.conditionId)) continue;

    const day = marketDayKeyFromTitle(
      pos.title,
      pos.settledAt || pos.updatedAt || pos.windowEnd || pos.createdAt
    );
    const b = bucket(day);
    if (!b) continue;

    const upSh = Number(pos.upShares) || 0;
    const downSh = Number(pos.downShares) || 0;
    const open = !pos.settled && (upSh > 1e-8 || downSh > 1e-8);

    if (open) {
      const m = markById[pos.conditionId];
      const unreal = m && m.unrealized != null && Number.isFinite(Number(m.unrealized))
        ? Number(m.unrealized)
        : 0;
      b.unrealized_pnl_usdc += unreal;
      b.invested_usdc += positionInvested(pos);
      b.open_positions += 1;
    } else if (pos.settled) {
      b.realized_pnl_usdc += Number(pos.realizedPnl) || 0;
      b.closed_positions += 1;
      usedIds.add(pos.conditionId);
    }
  }

  try {
    for (const t of readFills() || []) {
      if (!t || (t.type !== 'PAPER_BUY' && t.type !== 'LIVE_BUY')) continue;
      const day = marketDayKeyFromTitle(t.title, t.ts);
      const b = bucket(day);
      if (b) b.trade_count += 1;
    }
  } catch (_) { /* ignore */ }

  return finalizeDailyBuckets(byDay, 'polymarket_closed');
}

/**
 * @param {object} state
 * @param {Array} marks from markOpenPositions
 * @param {Map|null} closedByCondition optional pre-fetched official closed map
 */
function buildDailyPnl(state, marks = [], closedByCondition = null) {
  // After activity backfill, position.realizedPnl is cash-aligned — prefer ledger.
  if (state?.stats?.activity_backfilled_at) {
    return buildDailyPnlFromLedger(state, marks);
  }
  if (!isDryRun() && closedByCondition && closedByCondition.size > 0) {
    return buildDailyPnlFromClosed(state, marks, closedByCondition);
  }
  return buildDailyPnlFromLedger(state, marks);
}

/**
 * Force daily summary to cash/equity truth (initial → now).
 * Per-day strategy rows kept; residual shown as「记账偏差」so days sum to account.
 */
function applyCashTruthToDaily(report, state, account = null) {
  if (!report || !state) return report;

  const capital = Number(state.initial_capital_usdc) || 0;
  const unrealized = Number(report.summary?.unrealized_pnl_usdc) || 0;
  const hasOpen = (report.days || []).some((d) => (Number(d.open_positions) || 0) > 0)
    || (Number(report.summary?.unrealized_pnl_usdc) || 0) !== 0
    || (Number(report.summary?.invested_usdc) || 0) > 0.01;

  let truthTotal = null;
  if (account?.equity_usdc != null && Number.isFinite(Number(account.equity_usdc))) {
    truthTotal = rnd(Number(account.equity_usdc) - capital, 4);
  } else if (!hasOpen) {
    const cash = account?.cash_usdc != null
      ? Number(account.cash_usdc)
      : Number(state.clob_cash_usdc != null ? state.clob_cash_usdc : state.cash_usdc) || 0;
    truthTotal = rnd(cash - capital, 4);
  }
  if (truthTotal == null) return report;

  const truthRealized = rnd(truthTotal - unrealized, 4);
  const strategyRealized = rnd(Number(report.summary.realized_pnl_usdc) || 0, 4);
  const makerRebate = rnd(Number(state.stats?.maker_rebate_usdc) || 0, 4);
  const residual = rnd(truthRealized - strategyRealized - makerRebate, 4);

  report.summary.strategy_realized_pnl_usdc = strategyRealized;
  report.summary.maker_rebate_usdc = makerRebate;
  report.summary.realized_residual_usdc = rnd(residual + makerRebate, 4);
  report.summary.realized_pnl_usdc = truthRealized;
  report.summary.total_pnl_usdc = truthTotal;
  report.summary.initial_capital_usdc = capital;
  report.cash_truth = true;

  // Drop prior residual / rebate rows if re-calibrating
  report.days = (report.days || []).filter((d) => !d.is_residual && !d.is_rebate);
  if (makerRebate > 0.05) {
    report.days.push({
      day: 'Maker 返佣',
      realized_pnl_usdc: makerRebate,
      unrealized_pnl_usdc: 0,
      invested_usdc: 0,
      open_positions: 0,
      closed_positions: 0,
      trade_count: 0,
      total_pnl_usdc: makerRebate,
      is_rebate: true,
    });
  }
  if (Math.abs(residual) > 0.05) {
    report.days.push({
      day: '记账偏差',
      realized_pnl_usdc: residual,
      unrealized_pnl_usdc: 0,
      invested_usdc: 0,
      open_positions: 0,
      closed_positions: 0,
      trade_count: 0,
      total_pnl_usdc: residual,
      is_residual: true,
    });
  }
  report.days.sort((a, b) => {
    if (a.is_residual || a.is_rebate) return 1;
    if (b.is_residual || b.is_rebate) return -1;
    return String(a.day).localeCompare(String(b.day));
  });

  report.note =
    `合计 = 当前权益 − 初始 $${capital.toFixed(2)}` +
    ` · 逐日账本 ${strategyRealized >= 0 ? '+' : ''}$${strategyRealized.toFixed(2)}` +
    (makerRebate > 0.05 ? ` · 返佣 +$${makerRebate.toFixed(2)}` : '') +
    (Math.abs(residual) > 0.05
      ? ` · 偏差 ${residual >= 0 ? '+' : ''}$${residual.toFixed(2)}（漏记成交/成本）`
      : '');
  return report;
}

module.exports = {
  buildDailyPnl,
  buildDailyPnlFromLedger,
  buildDailyPnlFromClosed,
  applyCashTruthToDaily,
  marketDayKeyFromTitle,
  emptyDailyBucket,
  finalizeDailyBuckets,
};
