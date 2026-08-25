#!/usr/bin/env node
/**
 * Pairing quality stats from trades.jsonl + settlement_log + state.
 * Run: node scripts/paper-pair-stats.js [STATE_DIR]
 */
const fs = require('fs');
const path = require('path');

function loadJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function rnd(n, d = 4) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function pct(n, d) {
  if (!d) return null;
  return rnd((n / d) * 100, 1);
}

function pairedCost(upSh, downSh, upCost, downCost) {
  const u = Number(upSh) || 0;
  const d = Number(downSh) || 0;
  if (u < 1e-8 || d < 1e-8) return null;
  return rnd((Number(upCost) || 0) / u + (Number(downCost) || 0) / d, 4);
}

function imbalancePct(upSh, downSh) {
  const u = Number(upSh) || 0;
  const d = Number(downSh) || 0;
  const tot = u + d;
  if (tot < 1e-8) return 0;
  return rnd((Math.abs(u - d) / tot) * 100, 2);
}

function parseTs(s) {
  if (!s) return null;
  try {
    const str = String(s);
    const dt = str.endsWith('Z')
      ? new Date(str)
      : new Date(str.includes('T') ? str : `${str}Z`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  } catch (_) {
    return null;
  }
}

function summarizeWindow({ slug, title, trades, settle, position, pairSumMax }) {
  const buys = trades.filter((t) => String(t.type || '').includes('BUY') || t.side);
  const upBuys = buys.filter((t) => t.side === 'Up');
  const downBuys = buys.filter((t) => t.side === 'Down');
  const tradeUpSh = upBuys.reduce((a, t) => a + (Number(t.shares) || 0), 0);
  const tradeDownSh = downBuys.reduce((a, t) => a + (Number(t.shares) || 0), 0);
  const tradeUpCost = upBuys.reduce((a, t) => a + (Number(t.cost) || 0), 0);
  const tradeDownCost = downBuys.reduce((a, t) => a + (Number(t.cost) || 0), 0);

  const posUp = Number(position?.upShares) || 0;
  const posDown = Number(position?.downShares) || 0;
  const posUpCost = Number(position?.upCost) || 0;
  const posDownCost = Number(position?.downCost) || 0;

  const cleared = position?.settled || (posUp <= 1e-8 && posDown <= 1e-8 && (tradeUpSh > 0 || tradeDownSh > 0));
  const finalUp = cleared ? tradeUpSh : (posUp > 1e-8 || posDown > 1e-8 ? posUp : tradeUpSh);
  const finalDown = cleared ? tradeDownSh : (posUp > 1e-8 || posDown > 1e-8 ? posDown : tradeDownSh);
  const finalUpCost = cleared ? tradeUpCost : (posUpCost > 0 || posDownCost > 0 ? posUpCost : tradeUpCost);
  const finalDownCost = cleared ? tradeDownCost : (posUpCost > 0 || posDownCost > 0 ? posDownCost : tradeDownCost);

  const paired = Math.min(finalUp, finalDown);
  const imb = Math.abs(finalUp - finalDown);
  const imbPct = imbalancePct(finalUp, finalDown);
  const cost = pairedCost(finalUp, finalDown, finalUpCost, finalDownCost);
  const balanced = imb <= 0.01;
  const edgeOk = cost != null && cost <= pairSumMax + 1e-9;
  const pairedOk = paired >= 4.99;
  const success = pairedOk && balanced && edgeOk;

  const tradeTimes = buys.map((t) => parseTs(t.ts)).filter(Boolean);
  const firstTradeAt = tradeTimes.length ? new Date(Math.min(...tradeTimes.map((d) => d.getTime()))).toISOString() : null;
  const lastTradeAt = tradeTimes.length ? new Date(Math.max(...tradeTimes.map((d) => d.getTime()))).toISOString() : null;

  return {
    slug,
    title: (title || slug || '').slice(0, 80),
    nBuys: buys.length,
    finalUp: rnd(finalUp, 2),
    finalDown: rnd(finalDown, 2),
    paired: rnd(paired, 2),
    imb: rnd(imb, 2),
    imbPct,
    pairCost: cost,
    realized: settle != null ? Number(settle.realized) : (position?.realizedPnl != null ? Number(position.realizedPnl) : null),
    settled: Boolean(settle || position?.settled),
    balanced,
    edgeOk,
    pairedOk,
    success,
    firstTradeAt,
    lastTradeAt,
  };
}

function collectPairStats(stateDir, opts = {}) {
  const root = path.resolve(stateDir);
  const tradesPath = path.join(root, 'trades.jsonl');
  const settlePath = path.join(root, 'settlement_log.jsonl');
  const statePath = path.join(root, 'state.json');

  const trades = loadJsonl(tradesPath);
  const settles = loadJsonl(settlePath);
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { positions: {} };

  let pairSumMax = Number(opts.pairSumMax) || 0.97;
  if (!opts.pairSumMax) {
    try {
      const params = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'strategy_params.json'), 'utf8'));
      pairSumMax = Number(params.pair_sum_max) || pairSumMax;
    } catch (_) { /* ignore */ }
  }

  const since = opts.since ? new Date(opts.since) : null;

  const bySlug = new Map();
  for (const t of trades) {
    const slug = t.slug;
    if (!slug) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(t);
  }

  const settleBySlug = new Map(settles.map((s) => [s.slug, s]));
  const rows = [];

  for (const [slug, slugTrades] of bySlug) {
    const cid = slugTrades[0]?.conditionId;
    const pos = cid ? state.positions?.[cid] : Object.values(state.positions || {}).find((p) => p.slug === slug);
    const row = summarizeWindow({
      slug,
      title: slugTrades[0]?.title,
      trades: slugTrades,
      settle: settleBySlug.get(slug),
      position: pos,
      pairSumMax,
    });
    if (since && row.lastTradeAt && new Date(row.lastTradeAt) < since) continue;
    rows.push(row);
  }

  for (const pos of Object.values(state.positions || {})) {
    if (!pos.slug || bySlug.has(pos.slug)) continue;
    if (!(Number(pos.upShares) || Number(pos.downShares))) continue;
    const row = summarizeWindow({
      slug: pos.slug,
      title: pos.title,
      trades: [],
      settle: settleBySlug.get(pos.slug),
      position: pos,
      pairSumMax,
    });
    if (since && row.lastTradeAt && new Date(row.lastTradeAt) < since) continue;
    rows.push(row);
  }

  rows.sort((a, b) => a.slug.localeCompare(b.slug));

  const traded = rows.filter((r) => r.nBuys > 0);
  const withPair = traded.filter((r) => r.pairedOk);
  const balanced = traded.filter((r) => r.balanced);
  const edgeOk = traded.filter((r) => r.edgeOk);
  const success = traded.filter((r) => r.success);
  const settled = rows.filter((r) => r.settled && r.realized != null);
  const pnlSum = settled.reduce((a, r) => a + (Number(r.realized) || 0), 0);

  const costs = traded.filter((r) => r.pairCost != null).map((r) => r.pairCost);
  const avgPairCost = costs.length ? rnd(costs.reduce((a, c) => a + c, 0) / costs.length, 4) : null;

  return {
    label: path.basename(root),
    stateDir: root,
    pairSumMax,
    since: since ? since.toISOString() : null,
    generatedAt: new Date().toISOString(),
    summary: {
      windowsTraded: traded.length,
      pairSuccess: success.length,
      pairSuccessPct: pct(success.length, traded.length),
      withPair: withPair.length,
      withPairPct: pct(withPair.length, traded.length),
      balanced: balanced.length,
      balancedPct: pct(balanced.length, traded.length),
      edgeOk: edgeOk.length,
      edgeOkPct: pct(edgeOk.length, traded.length),
      settled: settled.length,
      realizedPnl: rnd(pnlSum, 4),
      avgWindowPnl: settled.length ? rnd(pnlSum / settled.length, 4) : null,
      avgPairCost,
    },
    recentTraded: traded.slice(-15),
    windows: rows,
  };
}

function printStats(report) {
  const s = report.summary;
  console.log(`\n配对质量统计 · ${report.label} · pair_sum_max=${report.pairSumMax}`);
  if (report.since) console.log(`统计起点: ${report.since}`);
  console.log('='.repeat(72));
  console.log(`有成交窗口: ${s.windowsTraded}`);
  console.log(`配对成功 (≥5份且平衡且 pairCost≤${report.pairSumMax}): ${s.pairSuccess} (${fmtPct(s.pairSuccessPct)})`);
  console.log(`有配对份额 (min≥5): ${s.withPair} (${fmtPct(s.withPairPct)})`);
  console.log(`份额平衡 (imb≈0): ${s.balanced} (${fmtPct(s.balancedPct)})`);
  console.log(`pairCost 达标: ${s.edgeOk} (${fmtPct(s.edgeOkPct)})`);
  if (s.avgPairCost != null) console.log(`平均 pairCost: ${s.avgPairCost}`);
  if (s.settled) {
    console.log(`已结算窗口: ${s.settled} · 已实现合计 $${s.realizedPnl} · 均窗 $${s.avgWindowPnl}`);
  }

  console.log('\n最近 15 个有成交窗口:');
  console.log('slug'.padEnd(28), 'buys', 'Up', 'Down', 'pair', 'imb%', 'cost', 'PnL', 'OK');
  for (const r of report.recentTraded) {
    console.log(
      r.slug.slice(-26).padEnd(28),
      String(r.nBuys).padStart(4),
      String(r.finalUp).padStart(5),
      String(r.finalDown).padStart(5),
      String(r.paired).padStart(5),
      String(r.imbPct).padStart(5),
      (r.pairCost != null ? r.pairCost.toFixed(3) : '—').padStart(6),
      (r.realized != null ? (r.realized >= 0 ? '+' : '') + r.realized.toFixed(2) : '—').padStart(7),
      r.success ? 'Y' : 'N'
    );
  }
  console.log('');
}

function fmtPct(v) {
  return v == null ? '—' : `${v}%`;
}

function main() {
  const stateDir = process.argv[2] || process.env.STATE_DIR || path.join(__dirname, '..', 'data', 'paper');
  const report = collectPairStats(stateDir);
  printStats(report);
}

if (require.main === module) {
  main();
}

module.exports = { collectPairStats, printStats, summarizeWindow };
