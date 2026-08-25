#!/usr/bin/env node
/**
 * Generate pairing stats report for paper + live.
 * Writes: data/reports/pair-stats-latest.{json,md}
 *         data/reports/history/pair-stats-YYYYMMDD-HHMM.json
 *
 * Run: node scripts/pair-stats-report.js
 */
const fs = require('fs');
const path = require('path');
const { collectPairStats } = require('./paper-pair-stats');

const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'data', 'reports');
const HISTORY_DIR = path.join(REPORT_DIR, 'history');
const MARKER = path.join(REPORT_DIR, 'conservative-params-since.json');
const INTERVAL_SEC = Number(process.env.STATS_INTERVAL_SEC) || 7200;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadMarker() {
  if (!fs.existsSync(MARKER)) {
    const marker = {
      since: new Date().toISOString(),
      note: 'Conservative arbitrage profile A applied',
      params: JSON.parse(fs.readFileSync(path.join(ROOT, 'strategy_params.json'), 'utf8')),
    };
    ensureDir(REPORT_DIR);
    fs.writeFileSync(MARKER, `${JSON.stringify(marker, null, 2)}\n`);
    return marker;
  }
  return JSON.parse(fs.readFileSync(MARKER, 'utf8'));
}

function hkt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    timeZone: 'Asia/Hong_Kong',
    hour12: false,
  });
}

function verdict(paperSince) {
  const s = paperSince.summary;
  const okRate = s.pairSuccessPct;
  const cost = s.avgPairCost;
  const lines = [];
  if (!s.windowsTraded) {
    lines.push('⏳ 新参数下尚无成交窗口，继续观察。');
    return lines;
  }
  if (okRate != null && okRate >= 80 && cost != null && cost <= 0.98) {
    lines.push('✅ 达标：配对成功率 ≥80% 且平均 pairCost ≤0.98，可考虑小仓 live 试跑。');
  } else {
    if (okRate != null && okRate < 80) {
      lines.push(`⚠️ 配对成功率 ${okRate}% < 80% — 继续 paper 或收紧参数。`);
    }
    if (cost != null && cost > 0.98) {
      lines.push(`⚠️ 平均 pairCost ${cost} > 0.98 — 利差不足或失衡仍多。`);
    }
    if (s.windowsTraded < 20) {
      lines.push(`ℹ️ 样本仅 ${s.windowsTraded} 窗，建议累计 ≥20 窗再判断。`);
    }
  }
  return lines;
}

function renderMarkdown(report) {
  const { generatedAt, marker, paper, paperSince, live, liveSince } = report;
  const lines = [
    '# 配对质量定时报告',
    '',
    `生成时间 (HKT): **${hkt(generatedAt)}**`,
    `统计间隔: 每 ${Math.round(INTERVAL_SEC / 60)} 分钟`,
    `保守参数起点: ${hkt(marker.since)}`,
    '',
    '## 判定',
    ...verdict(paperSince).map((l) => `- ${l}`),
    '',
    '## Paper（新参数以来）',
    '',
    '| 指标 | 值 |',
    '|------|-----|',
    `| 有成交窗口 | ${paperSince.summary.windowsTraded} |`,
    `| 配对成功 | ${paperSince.summary.pairSuccess} (${fmt(paperSince.summary.pairSuccessPct)}) |`,
    `| 份额平衡 | ${paperSince.summary.balanced} (${fmt(paperSince.summary.balancedPct)}) |`,
    `| pairCost 达标 | ${paperSince.summary.edgeOk} (${fmt(paperSince.summary.edgeOkPct)}) |`,
    `| 平均 pairCost | ${paperSince.summary.avgPairCost ?? '—'} |`,
    `| 已结算 PnL | $${paperSince.summary.realizedPnl ?? 0} (${paperSince.summary.settled} 窗) |`,
    '',
    '### 最近成交窗口',
    '',
    '| 窗口 | Up | Down | pair | cost | PnL | OK |',
    '|------|-----|------|------|------|-----|-----|',
  ];

  for (const r of paperSince.recentTraded.slice(-10)) {
    lines.push(
      `| ${r.slug.slice(-22)} | ${r.finalUp} | ${r.finalDown} | ${r.paired} | ${r.pairCost ?? '—'} | ${fmtPnl(r.realized)} | ${r.success ? 'Y' : 'N'} |`
    );
  }

  lines.push(
    '',
    '## Paper（全历史）',
    '',
    `- 有成交: ${paper.summary.windowsTraded} 窗 · 配对成功 ${paper.summary.pairSuccess} (${fmt(paper.summary.pairSuccessPct)})`,
    `- 已结算 PnL: $${paper.summary.realizedPnl ?? 0}`,
    '',
    '## Live（新参数以来）',
    '',
    `- 有成交: ${liveSince.summary.windowsTraded} 窗 · 配对成功 ${liveSince.summary.pairSuccess}`,
    `- 已结算 PnL: $${liveSince.summary.realizedPnl ?? 0}`,
    '',
    '---',
    '查看完整 JSON: `data/reports/pair-stats-latest.json`',
    ''
  );

  return lines.join('\n');
}

function fmt(v) {
  return v == null ? '—' : `${v}%`;
}

function fmtPnl(v) {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const hktDate = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong' }));
  return `${hktDate.getFullYear()}${p(hktDate.getMonth() + 1)}${p(hktDate.getDate())}-${p(hktDate.getHours())}${p(hktDate.getMinutes())}`;
}

function main() {
  ensureDir(REPORT_DIR);
  ensureDir(HISTORY_DIR);

  const marker = loadMarker();
  const since = marker.since;

  const paper = collectPairStats(path.join(ROOT, 'data', 'paper'));
  const paperSince = collectPairStats(path.join(ROOT, 'data', 'paper'), { since });
  const live = collectPairStats(path.join(ROOT, 'data', 'live'));
  const liveSince = collectPairStats(path.join(ROOT, 'data', 'live'), { since });

  const report = {
    generatedAt: new Date().toISOString(),
    intervalSec: INTERVAL_SEC,
    marker,
    paper,
    paperSince,
    live,
    liveSince,
    verdict: verdict(paperSince),
  };

  const jsonPath = path.join(REPORT_DIR, 'pair-stats-latest.json');
  const mdPath = path.join(REPORT_DIR, 'pair-stats-latest.md');
  const histPath = path.join(HISTORY_DIR, `pair-stats-${stamp()}.json`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderMarkdown(report));
  fs.writeFileSync(histPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`[pair-stats-report] ${hkt(report.generatedAt)}`);
  console.log(`  paper since: ${paperSince.summary.windowsTraded} windows, success ${fmt(paperSince.summary.pairSuccessPct)}, avgCost ${paperSince.summary.avgPairCost ?? '—'}`);
  console.log(`  wrote ${mdPath}`);
  for (const line of report.verdict) console.log(`  ${line}`);
}

if (require.main === module) {
  main();
}

module.exports = { main, renderMarkdown };
