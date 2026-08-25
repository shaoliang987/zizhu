#!/usr/bin/env node
/**
 * Autonomous BTC 5m Up/Down pair bot.
 * Strategy: buy equal-share Up+Down when pair sum ≤ pair_sum_max
 * inside the active window, hold to settlement.
 */
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { ensureDataDir, writeJson } = require('./lib/paths');
const {
  envTruthy,
  isDryRun,
  isLive,
  isLockMode,
  ledgerName,
  isBotPaused,
  setPaused,
} = require('./lib/mode');
const { loadParams, saveParams } = require('./lib/strategy');
const { buildReconcileReport, applyLiveReconcileCalibration, applyOfficialClosedPnl } = require('./lib/reconcile');
const { fetchClosedByCondition } = require('./lib/poly_closed');
const { discoverTradeableMarkets, secondsIntoWindow, secondsLeft } = require('./lib/markets');
const { scanMarketSignal } = require('./lib/signal');
const { executePlan } = require('./lib/executor');
const { settleEndedPositions, checkAndSettleOpenPositions } = require('./lib/settle');
const {
  loadState,
  saveState,
  addLog,
  openPositions,
  clearRecords,
} = require('./lib/ledger');
const { markOpenPositions, buildPnlSnapshot } = require('./lib/pnl');
const { buildDailyPnl, applyCashTruthToDaily } = require('./lib/daily_pnl');
const { fetchAccountCashUsdc, fetchAccountEquityUsdc, applyLiveAccountPnl, applyPaperAccountPnl, syncLiveLedgerFromClob, syncPaperLedgerPnl } = require('./lib/account');
const {
  matchOpenOrders,
  cancelStaleOrders,
  openOrders,
  ordersForMarket,
  checkAllPaperPairExposures,
} = require('./lib/paper_clob');
const {
  matchLiveOpenOrders,
  cancelLiveStaleOrders,
  reconcileLiveOpenOrders,
  checkAllPairExposures,
} = require('./lib/live_clob');
const { retryPendingRedeems } = require('./lib/redeem');
const { marketWs, setLogger: setMarketWsLogger } = require('./lib/market_ws');
const { withStateLock } = require('./lib/state_lock');
const { buildRiskSummary } = require('./lib/risk_status');
const { recordPlanOutcome, maybeFlushSkipSummary, resetSkipStats } = require('./lib/skip_stats');

const PORT = parseInt(process.env.PORT || (isDryRun() ? '8087' : '8086'), 10);
const BIND_HOST = (process.env.BIND_HOST || '127.0.0.1').trim();
const API_TOKEN = (process.env.BOT_API_TOKEN || process.env.API_TOKEN || '').trim();
const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, 'web');

let state = loadState();
let scanInFlight = false;
let settleCheckInFlight = false;
let lastSignal = null;
let lastMarkets = [];
let timer = null;
let settleCheckTimer = null;

function stripPrefix(pathname) {
  const prefixes = ['/testpaper', '/test'];
  for (const p of prefixes) {
    if (pathname === p) return '/';
    if (pathname.startsWith(`${p}/`)) return pathname.slice(p.length) || '/';
  }
  return pathname;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function apiAuthRequired(pathname, method) {
  if (method === 'GET') return false;
  if (!pathname.startsWith('/api/')) return false;
  return true;
}

function checkApiAuth(req, res) {
  if (!API_TOKEN) return true;
  const hdr = String(req.headers.authorization || '');
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  const queryToken = req.url && req.url.includes('token=')
    ? new URL(req.url, 'http://localhost').searchParams.get('token')
    : '';
  const token = bearer || String(req.headers['x-api-token'] || '').trim() || queryToken || '';
  if (token === API_TOKEN) return true;
  sendJson(res, 401, { error: 'unauthorized — set Authorization: Bearer <BOT_API_TOKEN>' });
  return false;
}

async function runScanBody() {
  state = loadState();
  state.stats.scans += 1;
  const params = loadParams();

  if (isDryRun()) {
    cancelStaleOrders(state);
    await matchOpenOrders(state);
    await checkAllPaperPairExposures(state);
    syncPaperLedgerPnl(state);
  } else if (isLive()) {
    await reconcileLiveOpenOrders(state);
    await cancelLiveStaleOrders(state);
    await matchLiveOpenOrders(state);
    if (Number(params.activity_sync_enabled) !== 0) {
      const { syncLiveFillsQuick } = require('./lib/activity_backfill');
      await syncLiveFillsQuick(state);
    }
    await syncLiveLedgerFromClob(state, { force: false });
  }

  await settleEndedPositions(state);

  if (isLive()) {
    await checkAllPairExposures(state);
    if (state.liveCircuitBreaker?.active || state.bot_status === 'paused') {
      saveState(state);
      return;
    }
    await retryPendingRedeems(state);
  }

  const markets = await discoverTradeableMarkets();
  lastMarkets = markets.map((m) => ({
    slug: m.slug,
    title: m.title,
    t: secondsIntoWindow(m),
    left: secondsLeft(m),
    conditionId: m.conditionId,
  }));

  const tokenIds = [];
  for (const m of markets) {
    if (m.upTokenId) tokenIds.push(m.upTokenId);
    if (m.downTokenId) tokenIds.push(m.downTokenId);
  }
  for (const pos of openPositions(state)) {
    if (pos.upTokenId) tokenIds.push(pos.upTokenId);
    if (pos.downTokenId) tokenIds.push(pos.downTokenId);
  }
  marketWs.syncSubscriptions(tokenIds);

  for (const market of markets) {
    const pos = state.positions[market.conditionId] || null;
    const marketOrders = ordersForMarket(state, market.conditionId);
    const pendingUsdc = marketOrders.reduce((a, o) => a + (Number(o.reservedUsdc) || 0), 0);
    const { pairAsks, pairQuotes, plan } = await scanMarketSignal(market, pos, params, {
      pendingUsdc,
      openOrders: marketOrders,
      state,
    });
    lastSignal = {
      ts: new Date().toISOString(),
      slug: market.slug,
      title: market.title,
      t: secondsIntoWindow(market),
      pairSum: plan.pairSum ?? pairAsks.pairSum,
      askSum: pairQuotes?.askSum ?? pairAsks.askSum ?? null,
      bidSum: pairQuotes?.bidSum ?? pairAsks.bidSum ?? null,
      upAsk: pairQuotes?.up?.ask?.price ?? null,
      downAsk: pairQuotes?.down?.ask?.price ?? null,
      upBid: pairQuotes?.up?.bid?.price ?? null,
      downBid: pairQuotes?.down?.bid?.price ?? null,
      quoteMode: plan.quoteMode || params.quote_mode || 'maker',
      plan,
    };

    if (plan.action === 'BUY') {
      state.stats.signals += 1;
      addLog(
        state,
        `[信号] ${market.title.slice(0, 48)} · ${plan.mode} · pairSum=${Number(plan.pairSum).toFixed(3)} · legs=${plan.legs.length}`,
        'info'
      );
      await executePlan(state, market, plan);
      if (state.liveCircuitBreaker?.active || state.bot_status === 'paused') break;
    } else {
      recordPlanOutcome(plan);
    }
  }

  maybeFlushSkipSummary(state, params, addLog);

  if (isLive()) {
    await syncLiveLedgerFromClob(state, { force: false });
  }

  state.last_scan = new Date().toISOString();
  saveState(state);
}

async function runScan() {
  if (scanInFlight) return;
  const riskRecoveryActive = isLive() && state.liveCircuitBreaker?.active;
  if (isBotPaused() || (state.bot_status === 'paused' && !riskRecoveryActive)) return;
  scanInFlight = true;
  try {
    await withStateLock(async () => {
      try {
        await runScanBody();
      } catch (err) {
        addLog(state, `[扫描错误] ${err.message}`, 'error');
        saveState(state);
      }
    });
  } finally {
    scanInFlight = false;
  }
}

function scheduleScans() {
  if (timer) clearInterval(timer);
  const ms = Math.max(500, Number(loadParams().scan_interval_ms) || 2000);
  timer = setInterval(() => {
    runScan().catch(() => {});
  }, ms);
}

/** Periodic settle-check (default 10m). Runs even when trading is paused. */
async function runSettleCheck() {
  if (settleCheckInFlight) return;
  settleCheckInFlight = true;
  try {
    await withStateLock(async () => {
      state = loadState();
      try {
        if (isLive()) {
          const params = loadParams();
          if (Number(params.activity_sync_enabled) !== 0) {
            const { syncActivityLedger } = require('./lib/activity_backfill');
            await syncActivityLedger(state, { maxPages: 5 });
            state = loadState();
          }
        }
        await checkAndSettleOpenPositions(state);
      } catch (err) {
        addLog(state, `[结算检查] 定时任务失败: ${err.message}`, 'error');
        saveState(state);
      }
    });
  } finally {
    settleCheckInFlight = false;
  }
}

function scheduleSettleChecks() {
  if (settleCheckTimer) clearInterval(settleCheckTimer);
  settleCheckTimer = null;
  const sec = Number(loadParams().settle_check_interval_sec);
  if (!Number.isFinite(sec) || sec <= 0) return;
  const ms = Math.max(60_000, Math.floor(sec * 1000));
  settleCheckTimer = setInterval(() => {
    runSettleCheck().catch(() => {});
  }, ms);
  addLog(
    state,
    `[结算检查] 已启用定时任务 · 每 ${Math.round(ms / 1000)}s`,
    'info'
  );
  saveState(state);
}

async function handleApi(req, res, pathname) {
  if (apiAuthRequired(pathname, req.method) && !checkApiAuth(req, res)) return;

  if (pathname === '/api/status' && req.method === 'GET') {
    state = loadState();
    // Fast path: WS marks only (no CLOB HTTP). Heavy daily/reconcile via their own APIs.
    const marks = await markOpenPositions(state, { allowHttp: false });
    const pnl = buildPnlSnapshot(state, marks);
    let accountCashError = null;
    let accountEquityError = null;
    if (!isDryRun()) {
      try {
        const account = await fetchAccountEquityUsdc({ force: false });
        applyLiveAccountPnl(pnl, account);
        accountCashError = account.cash_error || null;
        accountEquityError = account.positions_error || null;
      } catch (err) {
        accountCashError = err.message;
        accountEquityError = err.message;
      }
    } else {
      applyPaperAccountPnl(pnl, state);
    }
    pnl.ledger_cash_usdc = state.cash_usdc;
    return sendJson(res, 200, {
      status: state.bot_status,
      paused: isBotPaused() || state.bot_status === 'paused',
      dry_run: isDryRun(),
      ledger: ledgerName(),
      mode_locked: isLockMode(),
      strategy: 'btc5m_pair_arb',
      params: loadParams(),
      stats: state.stats,
      pnl,
      cash_usdc: state.cash_usdc,
      reserved_usdc: Number(state.reserved_usdc) || 0,
      account_cash_usdc: pnl.account_cash_usdc,
      account_cash_error: accountCashError,
      account_equity_error: accountEquityError,
      positions_value_usdc: pnl.positions_value_usdc,
      last_scan: state.last_scan,
      last_signal: lastSignal,
      markets: lastMarkets,
      clob_ws: marketWs.status(),
      open_positions: openPositions(state),
      open_orders: openOrders(state),
      marks,
      logs: state.logs.slice(0, 80),
      risk: buildRiskSummary(state, {
        apiAuthRequired: Boolean(API_TOKEN),
        bindHost: BIND_HOST,
      }),
    });
  }

  if (pathname === '/api/daily-pnl' && req.method === 'GET') {
    state = loadState();
    const marks = await markOpenPositions(state);
    let closedMap = null;
    if (!isDryRun()) {
      try {
        closedMap = await fetchClosedByCondition({ force: false });
      } catch (_) {
        closedMap = null;
      }
    }
    let daily = buildDailyPnl(state, marks, closedMap);
    try {
      const account = !isDryRun()
        ? await fetchAccountEquityUsdc({ force: false })
        : { cash_usdc: state.cash_usdc, equity_usdc: state.cash_usdc };
      daily = applyCashTruthToDaily(daily, state, account);
    } catch (_) {
      daily = applyCashTruthToDaily(daily, state, null);
    }
    return sendJson(res, 200, daily);
  }

  if (pathname === '/api/reconcile' && req.method === 'GET') {
    state = loadState();
    const marks = await markOpenPositions(state);
    let report = buildReconcileReport(state, marks);
    if (!isDryRun()) {
      try {
        const closedMap = await fetchClosedByCondition({ force: false });
        report = applyOfficialClosedPnl(report, closedMap, state);
      } catch (_) {
        /* keep strategy ledger windows */
      }
    }
    try {
      const account = !isDryRun() ? await fetchAccountEquityUsdc({ force: false }) : null;
      report = applyLiveReconcileCalibration(report, state, account);
    } catch (_) {
      report = applyLiveReconcileCalibration(report, state, null);
    }
    return sendJson(res, 200, report);
  }

  if (pathname === '/api/params' && req.method === 'GET') {
    return sendJson(res, 200, loadParams());
  }

  if (pathname === '/api/params' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      withStateLock(async () => {
      try {
        state = loadState();
        const patch = JSON.parse(body || '{}');
        const prevCapital = Number(state.initial_capital_usdc);
        const next = saveParams(patch);
        const notes = [];

        if (patch.initial_capital_usdc != null) {
          const capital = Number(next.initial_capital_usdc);
          if (!(capital > 0) || !Number.isFinite(capital)) {
            return sendJson(res, 400, { error: 'initial_capital_usdc 须为正数' });
          }
          const oldCap = Number.isFinite(prevCapital) && prevCapital > 0
            ? prevCapital
            : capital;
          state.initial_capital_usdc = capital;

          if (isDryRun()) {
            const open = openPositions(state);
            const pendingOrders = (state.open_orders || []).filter((o) => o.status === 'open');
            const flat = open.length === 0 && pendingOrders.length === 0
              && !(Number(state.reserved_usdc) > 1e-9);
            if (flat) {
              state.cash_usdc = capital;
              notes.push(`纸上现金已重置为 $${capital}`);
            } else {
              const delta = capital - oldCap;
              state.cash_usdc = Math.max(0, Number(state.cash_usdc) + delta);
              notes.push(
                `初始资金 $${oldCap}→$${capital}` +
                (delta !== 0 ? `，现金同步 ${delta >= 0 ? '+' : ''}${delta}` : '') +
                '（有持仓/挂单未清空）'
              );
            }
          } else {
            notes.push(`初始资金参数已设为 $${capital}（实盘现金以交易所为准）`);
          }
        }

        addLog(
          state,
          `[参数] 已更新 ${Object.keys(patch).join(',')}` +
          (notes.length ? ` · ${notes.join('；')}` : ''),
          'info'
        );
        saveState(state);
        scheduleScans();
        sendJson(res, 200, { ...next, notes, state_capital: state.initial_capital_usdc, cash_usdc: state.cash_usdc });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      }).catch((err) => sendJson(res, 500, { error: err.message }));
    });
    return;
  }

  if (pathname === '/api/pause' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const { paused } = JSON.parse(body || '{}');
        const nextPaused = Boolean(paused);
        state = loadState();
        if (!nextPaused && state.liveCircuitBreaker?.active) {
          return sendJson(res, 409, {
            error: '实盘断路器仍处于活动状态；裸仓和未完成订单清除后才能恢复交易。',
            circuit_breaker: state.liveCircuitBreaker,
          });
        }
        // Apply immediately so UI/next scan see it without waiting on scan lock
        setPaused(nextPaused);
        state.bot_status = nextPaused ? 'paused' : 'running';
        sendJson(res, 200, { paused: nextPaused, status: state.bot_status });
        withStateLock(async () => {
          const s = loadState();
          s.bot_status = nextPaused ? 'paused' : 'running';
          addLog(s, nextPaused ? '[暂停] 策略已暂停' : '[恢复] 策略继续运行', 'info');
          saveState(s);
          state = s;
        }).catch(() => {});
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (pathname === '/api/scan' && req.method === 'POST') {
    await runScan();
    return sendJson(res, 200, { ok: true, last_signal: lastSignal });
  }

  if (pathname === '/api/clear' && req.method === 'POST') {
    if (isLive()) {
      return sendJson(res, 403, {
        ok: false,
        error: '实盘禁止清除账本（会丢失挂单/持仓跟踪）。请先暂停并确认交易所仓位后再手动处理。',
      });
    }
    return withStateLock(async () => {
      state = loadState();
      state = clearRecords(state);
      resetSkipStats();
      delete state.skip_summary_last_at;
      addLog(state, '[清除] 已重置账本', 'warning');
      saveState(state);
      return sendJson(res, 200, { ok: true });
    });
  }

  if (pathname === '/api/settle' && req.method === 'POST') {
    return withStateLock(async () => {
      state = loadState();
      const n = await settleEndedPositions(state);
      return sendJson(res, 200, { settled: n });
    });
  }

  // Manual settle check: query Polymarket resolution, settle if resolved
  if (pathname === '/api/settle-check' && req.method === 'POST') {
    return withStateLock(async () => {
      state = loadState();
      try {
        const result = await checkAndSettleOpenPositions(state);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err.message });
      }
    });
  }

  // Force re-quote CLOB midpoint marks for open positions (baloneigh-style)
  if (pathname === '/api/refresh-marks' && req.method === 'POST') {
    state = loadState();
    const marks = await markOpenPositions(state);
    const pnl = buildPnlSnapshot(state, marks);
    if (!isDryRun()) {
      try {
        const account = await fetchAccountEquityUsdc({ force: true });
        applyLiveAccountPnl(pnl, account);
      } catch (_) {
        /* keep ledger equity */
      }
    } else {
      applyPaperAccountPnl(pnl, state);
    }
    pnl.ledger_cash_usdc = state.cash_usdc;
    const updated = marks.filter((m) => m.upMark != null || m.downMark != null).length;
    const failed = marks.filter((m) => m.upMark == null && m.downMark == null).length;
    return sendJson(res, 200, {
      success: true,
      updated,
      failed,
      marks,
      open_positions: openPositions(state),
      pnl,
      account_cash_usdc: pnl.account_cash_usdc,
    });
  }

  if (pathname === '/api/sync-account' && req.method === 'POST') {
    if (isDryRun()) {
      state = loadState();
      const marks = await markOpenPositions(state);
      const pnl = buildPnlSnapshot(state, marks);
      const cash = pnl.paper_account_cash_usdc;
      return sendJson(res, 200, {
        success: true,
        dry_run: true,
        account_cash_usdc: cash,
        message: cash === 0
          ? '纸上账户现金为 $0'
          : `纸上现金 = 初始 + 已实现 − 持仓成本 = $${Number(cash).toFixed(2)}`,
      });
    }
    try {
      const account = await fetchAccountEquityUsdc({ force: true });
      const cash = account.cash_usdc;
      const equity = account.equity_usdc;
      const posVal = account.positions_value_usdc;
      const cashN = Number(cash);
      const equityN = Number(equity);
      const posN = Number(posVal);
      const cashAmount = Number.isFinite(cashN) ? cashN : null;
      const equityAmount = Number.isFinite(equityN) ? equityN : null;
      const posAmount = Number.isFinite(posN) ? posN : null;
      return sendJson(res, 200, {
        success: true,
        dry_run: false,
        account_cash_usdc: cashAmount,
        equity_usdc: equityAmount,
        positions_value_usdc: posAmount,
        message: cashAmount == null
          ? '实盘余额同步失败：未返回抵押余额'
          : equityAmount == null
            ? `实盘 CLOB 抵押余额 = $${cashAmount.toFixed(2)}`
            : `实盘权益 = $${equityAmount.toFixed(2)}（现金 $${cashAmount.toFixed(2)} + 持仓 $${(posAmount || 0).toFixed(2)}）`,
      });
    } catch (err) {
      return sendJson(res, 500, { success: false, dry_run: false, error: err.message });
    }
  }

  sendJson(res, 404, { error: 'not found' });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    let pathname = stripPrefix(parsed.pathname || '/');

    try {
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
        return;
      }

      let filePath = path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname);
      if (!filePath.startsWith(WEB_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(WEB_DIR, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': contentType(filePath) });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });
}

async function main() {
  ensureDataDir();
  writeJson('active-mode.json', {
    dryRun: isDryRun(),
    instance: process.env.INSTANCE_NAME || ledgerName(),
  });

  state = loadState();
  // Live always boots paused unless START_PAUSED=0/false (safety default).
  if (isLive() && envTruthy('START_PAUSED', true)) {
    setPaused(true);
    state.bot_status = 'paused';
    addLog(state, '[启动] LIVE 默认暂停 — 面板点「恢复」后再交易（START_PAUSED=0 可关闭此行为）', 'warning');
  } else if (isBotPaused()) {
    state.bot_status = 'paused';
  } else {
    state.bot_status = 'running';
  }
  saveState(state);

  const params = loadParams();
  setMarketWsLogger((msg, level) => {
    addLog(state, msg, level || 'info');
  });
  marketWs.start();

  addLog(
    state,
      `启动 BTC 5m 自主策略 · ${ledgerName().toUpperCase()}` +
      ` · ${params.quote_mode || 'maker'}` +
      ` · pairSum≤${params.pair_sum_max}` +
      ` · band (${params.min_ask},${params.max_ask}]` +
      ` · entry ${params.entry_start_sec}-${params.entry_end_sec}s` +
      ` · pairMinLeft ${params.pair_entry_min_sec || 60}s` +
      ` · pairRounds≤${params.max_pair_rounds_per_window || 1}` +
      ` · extreme [${params.pair_extreme_min || 0.25},${params.pair_extreme_max || 0.75}]` +
      ` · legRatio≤${params.pair_max_leg_ratio || 2}` +
      ` · max/trade $${params.max_trade_usdc} · max/market $${params.max_market_usdc}` +
      ` · scan ${params.scan_interval_ms}ms` +
      ` · settleCheck ${params.settle_check_interval_sec || 0}s` +
      ` · quotes: WS+HTTP`,
    'info'
  );
  saveState(state);

  if (isLive()) {
    try {
      const rec = await reconcileLiveOpenOrders(state);
      addLog(
        state,
        `[实盘对账] 启动完成 adopted=${rec.adopted || 0} closed=${rec.closed || 0} pending=${rec.pending || 0}`,
        'info'
      );
      await checkAllPairExposures(state);
      await syncLiveLedgerFromClob(state, { force: true });
      await retryPendingRedeems(state);
      // Clear empty shells / resolve open markets once at boot
      await checkAndSettleOpenPositions(state);
      saveState(state);
    } catch (err) {
      addLog(state, `[实盘对账] 启动失败: ${err.message}`, 'warning');
      saveState(state);
    }
  }

  const server = createServer();
  server.listen(PORT, BIND_HOST, () => {
    const authNote = API_TOKEN ? ' · API token required for POST' : ' · 警告: 未设置 BOT_API_TOKEN';
    addLog(
      state,
      `面板 http://${BIND_HOST}:${PORT} (${isLive() ? 'LIVE /test' : 'PAPER /testpaper'})${authNote}`,
      'success'
    );
    saveState(state);
  });

  setTimeout(() => {
    runScan().catch(() => {});
  }, 1500);
  scheduleScans();
  scheduleSettleChecks();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
