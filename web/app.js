(() => {
  const API_BASE = (() => {
    const p = location.pathname;
    if (p === '/testpaper' || p.startsWith('/testpaper/')) return '/testpaper';
    if (p === '/test' || p.startsWith('/test/')) return '/test';
    return '';
  })();
  const api = (path) => (path.startsWith('/') && API_BASE ? API_BASE + path : path);

  function readTokenFromUrl() {
    try {
      const u = new URL(location.href);
      const q = (u.searchParams.get('token') || u.searchParams.get('bot_api_token') || '').trim();
      if (!q) return '';
      sessionStorage.setItem('bot_api_token', q);
      u.searchParams.delete('token');
      u.searchParams.delete('bot_api_token');
      history.replaceState({}, '', u.pathname + u.search + u.hash);
      return q;
    } catch (_) {
      return '';
    }
  }

  function getApiToken() {
    return (sessionStorage.getItem('bot_api_token') || readTokenFromUrl() || '').trim();
  }

  function promptApiToken(reason) {
    const msg = reason
      || '面板写操作需要 BOT_API_TOKEN。\n请输入服务器 .env 里的 BOT_API_TOKEN：';
    const entered = window.prompt(msg, getApiToken() || '');
    const token = (entered || '').trim();
    if (token) sessionStorage.setItem('bot_api_token', token);
    return token;
  }

  function apiHeaders(extra = {}) {
    const h = { ...extra };
    const token = getApiToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async function apiPost(path, body) {
    const buildOpts = () => {
      const opts = { method: 'POST', headers: apiHeaders() };
      if (body != null) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      return opts;
    };

    if (!getApiToken()) {
      const token = promptApiToken();
      if (!token) {
        showToast('未设置 BOT_API_TOKEN，无法执行该操作', false);
        throw new Error('unauthorized');
      }
    }

    let res = await fetch(api(path), buildOpts());
    if (res.status === 401) {
      const token = promptApiToken('BOT_API_TOKEN 无效或未设置，请重新输入：');
      if (!token) {
        showToast('未设置 BOT_API_TOKEN，无法执行该操作', false);
        throw new Error('unauthorized');
      }
      res = await fetch(api(path), buildOpts());
      if (res.status === 401) {
        showToast('BOT_API_TOKEN 无效', false);
        throw new Error('unauthorized');
      }
    }
    return res;
  }

  const $ = (id) => document.getElementById(id);
  const money = (n, signed = false) => {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    const abs = `$${Math.abs(v).toFixed(2)}`;
    if (!signed) return v < 0 ? `-${abs}` : abs;
    if (v > 0) return `+${abs}`;
    if (v < 0) return `-${abs}`;
    return abs;
  };
  const clsPnL = (n) => (Number(n) >= 0 ? 'pos' : 'neg');
  const cents = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${Number(n).toFixed(1)}¢`);
  const sharesFmt = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(2));
  function setPnlCardClass(id, value) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('profit', 'loss');
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return;
    el.classList.add(n > 0 ? 'profit' : 'loss');
  }

  let toastTimer = null;
  function showToast(message, ok = true) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = `toast show ${ok ? 'ok' : 'err'}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, 2200);
  }

  function sideCell(shares, cost, markPx) {
    const sh = Number(shares) || 0;
    const c = Number(cost) || 0;
    const avgCents = sh > 0 ? (c / sh) * 100 : null;
    const markCents = markPx != null && Number.isFinite(Number(markPx))
      ? Number(markPx) * 100
      : null;
    return `<div class="pos-side">
      <div class="row"><span>均价</span><b>${cents(avgCents)}</b><span>成本</span><b>${money(c)}</b></div>
      <div class="row"><span>市价</span><b>${cents(markCents)}</b><span>份额</span><b>${sharesFmt(sh)}</b></div>
    </div>`;
  }
  const TZ = 'Asia/Hong_Kong';

  function formatHkt(input, withSeconds = true) {
    if (!input) return '—';
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return String(input);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: withSeconds ? '2-digit' : undefined,
      hour12: false,
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    const base = withSeconds
      ? `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
      : `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
    return `${base} HKT`;
  }

  async function fetchStatus() {
    const res = await fetch(api('/api/status'));
    if (!res.ok) throw new Error(`status ${res.status}`);
    return res.json();
  }

  let lastStatus = null;
  let reconcileInFlight = false;
  let lastReconcileFetchAt = 0;
  async function fetchReconcile(force = false) {
    const now = Date.now();
    if (!force && now - lastReconcileFetchAt < 30000) return lastReconcile;
    if (reconcileInFlight) return lastReconcile;
    reconcileInFlight = true;
    try {
      const res = await fetch(api('/api/reconcile'));
      if (!res.ok) throw new Error(`reconcile ${res.status}`);
      const report = await res.json();
      lastReconcileFetchAt = Date.now();
      renderReconcile(report);
      return report;
    } finally {
      reconcileInFlight = false;
    }
  }

  let dailyInFlight = false;
  let lastDailyFetchAt = 0;
  async function fetchDailyPnl(force = false) {
    const now = Date.now();
    if (!force && now - lastDailyFetchAt < 30000) return lastDailyPnl;
    if (dailyInFlight) return lastDailyPnl;
    dailyInFlight = true;
    try {
      const res = await fetch(api('/api/daily-pnl'));
      if (!res.ok) throw new Error(`daily-pnl ${res.status}`);
      const report = await res.json();
      lastDailyFetchAt = Date.now();
      renderDailyPnl(report);
      return report;
    } finally {
      dailyInFlight = false;
    }
  }

  function renderPnl(data) {
    const pnl = data.pnl || {};
    const capital = pnl.initial_capital_usdc;
    const equity = pnl.equity_usdc;
    const totalBuy = pnl.total_buy_usdc;
    const recovered = pnl.total_proceeds_usdc;
    const fees = pnl.fees_usdc;
    const openCost = pnl.open_cost_usdc;
    const realized = pnl.realized_pnl_usdc;
    const unrealized = pnl.unrealized_pnl_usdc;
    const totalPnl = (Number(realized) || 0) + (Number(unrealized) || 0);

    $('statInitialCapital').textContent = money(capital);
    const equityErr = pnl.account_equity_error || data.account_equity_error;
    $('statInitialCapitalSub').textContent = data.dry_run
      ? `当前权益 ${money(equity)}`
      : equityErr
        ? `当前权益 ${money(equity)} · 同步失败`
        : `当前权益 ${money(equity)} · CLOB+持仓（官方）`;
    // 账户现金：纸上 = 初始 + 已实现 − 持仓成本；实盘 = CLOB 官方余额
    const accountCash = data.dry_run
      ? (pnl.paper_account_cash_usdc != null ? pnl.paper_account_cash_usdc : pnl.account_cash_usdc)
      : (pnl.account_cash_usdc != null ? pnl.account_cash_usdc : data.account_cash_usdc);
    $('statCashUsdc').textContent = money(accountCash);
    const reserved = Number(data.reserved_usdc) || Number(pnl.reserved_usdc) || 0;
    const freeCash = Number(data.cash_usdc);
    $('statCashSub').textContent = data.dry_run
      ? `初始+已实现−持仓成本 · 可用 ${money(freeCash)} · 占款 ${money(reserved)}`
      : (data.account_cash_error ? `同步失败: ${data.account_cash_error}` : 'CLOB 抵押余额（官方）');
    $('statInvestedUsdc').textContent = money(totalBuy);
    $('statInvestedSub').textContent = `结算回收 ${money(recovered)}`;
    const feesSub = $('statFeesSub');
    if (feesSub) feesSub.textContent = `累计手续费 ${money(fees)}`;
    $('statOpenCost').textContent = money(openCost);
    $('statOpenCostSub').textContent = `开放持仓 ${Number(pnl.open_markets) || 0} 个`;
    const strategyRealized = pnl.strategy_realized_pnl_usdc;
    $('statRealizedPnl').textContent = money(realized, true);
    $('statUnrealizedPnl').textContent = money(unrealized, true);
    $('statPnl').textContent = money(totalPnl, true);

    setPnlCardClass('realizedCard', realized);
    setPnlCardClass('unrealizedCard', unrealized);
    setPnlCardClass('pnlCard', totalPnl);

    const hint = $('pnlHint');
    if (hint) {
      hint.textContent = data.dry_run
        ? '纸上：总盈亏 = 已实现 + 未实现 · 与实盘同口径（现金校准 + 配对成本风控）'
        : '实盘：总盈亏 = 已实现 + 未实现 · 权益 = 初始 + 总盈亏';
    }
    const realizedSub = $('statRealizedSub');
    if (realizedSub) {
      if (!data.dry_run && strategyRealized != null && Math.abs(strategyRealized - realized) > 0.02) {
        realizedSub.textContent = `CLOB 校准 · 逐腿曾记 ${money(strategyRealized, true)}`;
      } else {
        realizedSub.textContent = data.dry_run ? '结算锁定收益' : 'CLOB 已实现（平仓位后校准）';
      }
    }
    const unrealizedSub = $('statUnrealizedSub');
    if (unrealizedSub) {
      unrealizedSub.textContent = '开放持仓浮盈浮亏';
    }

    const roc = Number(pnl.roc_pct);
    const turnover = Number(pnl.turnover_pct);
    if (Number.isFinite(roc) && Number.isFinite(turnover)) {
      $('statPnlSub').textContent = `已实现 ${money(realized, true)} + 未实现 ${money(unrealized, true)} · 收益率 ${roc.toFixed(1)}%`;
    } else {
      $('statPnlSub').textContent = '已实现 + 未实现';
    }
  }

  function renderRisk(data) {
    const risk = data.risk || {};
    const badge = $('riskBadge');
    const summary = $('riskSummaryText');
    const metrics = $('riskMetrics');
    const wrap = $('riskTableWrap');
    const body = $('riskBody');
    if (!badge || !summary || !metrics) return;

    const ok = Boolean(risk.ok);
    badge.textContent = ok ? 'OK' : `ALERT (${risk.issue_count || '!'})`;
    badge.className = `badge ${ok ? 'live' : 'paper'} ${ok ? '' : 'risk-alert'}`;

    const parts = [];
    if (risk.one_sided?.length) parts.push(`单边 ${risk.one_sided.length}`);
    if (risk.pair_cost_alerts?.length) parts.push(`成本 ${risk.pair_cost_alerts.length}`);
    if (risk.pending_reconcile_orders) parts.push(`对账待查 ${risk.pending_reconcile_orders}`);
    if (risk.cancel_failed_orders) parts.push(`撤单失败 ${risk.cancel_failed_orders}`);
    if (risk.pending_redeem_positions) parts.push(`赎回待重试 ${risk.pending_redeem_positions}`);
    summary.textContent = ok
      ? '配对、对账、赎回状态正常'
      : (parts.join(' · ') || '存在待处理风险项');

    const ledger = money(risk.ledger_cash_usdc);
    const reserved = money(risk.reserved_usdc);
    const clob = risk.clob_cash_usdc != null ? money(risk.clob_cash_usdc) : '—';
    const synced = risk.clob_cash_synced_at ? formatHkt(risk.clob_cash_synced_at) : '—';
    const authNote = risk.api_auth_required ? 'POST 需 token' : 'POST 无 token';

    metrics.innerHTML = `
      <div class="risk-metric"><span>账本现金</span><strong>${ledger}</strong></div>
      <div class="risk-metric"><span>挂单占款</span><strong>${reserved}</strong></div>
      <div class="risk-metric"><span>CLOB 镜像</span><strong>${clob}</strong></div>
      <div class="risk-metric"><span>CLOB 同步</span><strong>${synced}</strong></div>
      <div class="risk-metric"><span>Live/Paper 挂单</span><strong>${risk.open_orders_live || 0} / ${risk.open_orders_paper || 0}</strong></div>
      <div class="risk-metric"><span>安全</span><strong>${authNote}</strong></div>
    `;

    const rows = [];
    for (const e of risk.one_sided || []) {
      rows.push(`<tr>
        <td class="market-name">${e.title || e.slug || '—'}</td>
        <td>单边敞口</td>
        <td>缺 ${e.missingSide} · Up ${sharesFmt(e.upShares)} / Down ${sharesFmt(e.downShares)}</td>
      </tr>`);
    }
    for (const e of risk.pair_cost_alerts || []) {
      rows.push(`<tr>
        <td class="market-name">${e.title || e.slug || '—'}</td>
        <td>配对成本</td>
        <td>pairCost ${Number(e.pairCost).toFixed(4)} &gt; max ${Number(e.maxSum).toFixed(2)}</td>
      </tr>`);
    }

    if (body) {
      if (!rows.length) {
        wrap.hidden = true;
        body.innerHTML = '';
      } else {
        wrap.hidden = false;
        body.innerHTML = rows.join('');
      }
    }
  }

  let lastDailyPnl = null;
  let lastReconcile = null;
  let reconView = 'windows';
  const RECON_PAGE_SIZE = 20;
  let reconWindowPage = 1;
  let reconFillPage = 1;
  let reconWindowsAll = [];
  let reconFillsAll = [];

  function setReconView(view) {
    reconView = view === 'fills' ? 'fills' : 'windows';
    document.querySelectorAll('.recon-view-tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.reconView === reconView);
    });
    const win = $('reconViewWindows');
    const fills = $('reconViewFills');
    if (win) win.hidden = reconView !== 'windows';
    if (fills) fills.hidden = reconView !== 'fills';
  }

  function pageCount(total) {
    return Math.max(1, Math.ceil(total / RECON_PAGE_SIZE));
  }

  function clampPage(page, total) {
    const pages = pageCount(total);
    return Math.min(Math.max(1, page || 1), pages);
  }

  function updateReconPager(prefix, page, total) {
    const pager = $(`${prefix}Pager`);
    const info = $(`${prefix}PagerInfo`);
    if (!pager || !info) return;
    const prev = pager.querySelector('[data-recon-page="prev"]');
    const next = pager.querySelector('[data-recon-page="next"]');
    if (!total) {
      pager.hidden = true;
      return;
    }
    const pages = pageCount(total);
    const start = (page - 1) * RECON_PAGE_SIZE + 1;
    const end = Math.min(page * RECON_PAGE_SIZE, total);
    pager.hidden = false;
    info.textContent = `${start}–${end} / ${total} · 第 ${page}/${pages} 页`;
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= pages;
  }

  function renderReconcileWindowsPage() {
    const wb = $('reconWindowBody');
    if (!wb) return;
    const windows = reconWindowsAll;
    reconWindowPage = clampPage(reconWindowPage, windows.length);
    updateReconPager('reconWindow', reconWindowPage, windows.length);
    if (!windows.length) {
      wb.innerHTML = '<tr><td colspan="10" class="empty">暂无对账数据</td></tr>';
      return;
    }
    const start = (reconWindowPage - 1) * RECON_PAGE_SIZE;
    const pageRows = windows.slice(start, start + RECON_PAGE_SIZE);
    wb.innerHTML = pageRows.map((w) => {
      const outcome = w.outcome
        ? `<span class="pill ${w.outcome === 'Up' ? 'pill-up' : 'pill-down'}">${w.outcome}</span>`
        : '<span class="muted">—</span>';
      const status = w.status === 'settled'
        ? '<span class="pill pill-settled">已结算</span>'
        : '<span class="pill pill-open">持仓中</span>';
      let resultIcon = '<span class="result-icon flat">·</span>';
      if (w.status === 'settled') {
        if (w.win === true) resultIcon = '<span class="result-icon win" title="盈利">✓</span>';
        else if (w.win === false) resultIcon = '<span class="result-icon loss" title="亏损">✕</span>';
      }
      const avg = w.avg_price_cents != null
        ? `${Number(w.avg_price_cents).toFixed(1)}¢`
        : '—';
      const realized = w.status === 'settled'
        ? money(w.realized_pnl_usdc, true)
        : money(w.unrealized_pnl_usdc, true);
      const realizedCls = w.status === 'settled'
        ? clsPnL(w.realized_pnl_usdc)
        : clsPnL(w.unrealized_pnl_usdc);
      const driftHint = w.status === 'settled'
        && w.strategy_realized_pnl_usdc != null
        && Math.abs(Number(w.realized_pnl_clob_drift_usdc) || 0) > 0.005
        ? ` title="策略 ${money(w.strategy_realized_pnl_usdc, true)} · 校准 ${money(w.realized_pnl_clob_drift_usdc, true)}"`
        : '';
      return `<tr>
        <td class="market-name" title="${String(w.title || '').replace(/"/g, '&quot;')}">${w.window_label || '—'}</td>
        <td>${outcome}</td>
        <td>${w.fill_count || 0}</td>
        <td>${sharesFmt(w.total_shares)}</td>
        <td>${avg}</td>
        <td>${money(w.total_cost)}</td>
        <td>${status}</td>
        <td>${w.settle_price_label || '—'}</td>
        <td>${resultIcon}</td>
        <td class="${realizedCls}"${driftHint}>${realized}</td>
      </tr>`;
    }).join('');
  }

  function renderReconcileFillsPage() {
    const fb = $('reconFillBody');
    if (!fb) return;
    const fills = reconFillsAll;
    reconFillPage = clampPage(reconFillPage, fills.length);
    updateReconPager('reconFill', reconFillPage, fills.length);
    if (!fills.length) {
      fb.innerHTML = '<tr><td colspan="8" class="empty">暂无成交</td></tr>';
      return;
    }
    const start = (reconFillPage - 1) * RECON_PAGE_SIZE;
    const pageRows = fills.slice(start, start + RECON_PAGE_SIZE);
    fb.innerHTML = pageRows.map((t) => `<tr>
      <td>${formatHkt(t.ts)}</td>
      <td class="market-name">${t.window_label || '—'}</td>
      <td><span class="pill ${t.side === 'Up' ? 'pill-up' : 'pill-down'}">${t.side || '—'}</span></td>
      <td>${sharesFmt(t.shares)}</td>
      <td>${cents((Number(t.price) || 0) * 100)}</td>
      <td>${money(t.cost)}</td>
      <td>${money(t.fee)}</td>
      <td>${t.liquidity || '—'}</td>
    </tr>`).join('');
  }

  function renderReconcile(report) {
    if (report) lastReconcile = report;
    const data = report || lastReconcile;
    if (!data) return;
    const s = data.summary || {};

    const setMetric = (id, text, cls) => {
      const el = $(id);
      if (!el) return;
      el.textContent = text;
      el.classList.remove('pos', 'neg');
      if (cls) el.classList.add(cls);
    };

    setMetric('reconFillCount', String(s.fill_count || 0));
    setMetric('reconWindowCount', `${s.window_count || 0} 个`);
    setMetric('reconCost', money(s.total_cost_usdc));
    setMetric('reconRealized', money(s.realized_pnl_usdc, true), clsPnL(s.realized_pnl_usdc));
    setMetric('reconUnrealized', money(s.unrealized_pnl_usdc, true), clsPnL(s.unrealized_pnl_usdc));
    setMetric('reconTotal', money(s.total_pnl_usdc, true), clsPnL(s.total_pnl_usdc));
    if ($('reconNote') && data.note) $('reconNote').textContent = data.note;

    reconWindowsAll = data.windows || [];
    reconFillsAll = data.fills || [];
    renderReconcileWindowsPage();
    renderReconcileFillsPage();
    setReconView(reconView);
  }

  function renderDailyPnl(daily) {
    if (daily) lastDailyPnl = daily;
    const data = daily || lastDailyPnl;
    const totalsEl = $('dailyPnlTotals');
    const emptyEl = $('dailyPnlEmpty');
    const canvas = $('dailyPnlChart');
    const tbody = $('dailyPnlBody');
    if (!canvas || !tbody) return;

    // /api/status 不含 daily_pnl；独立接口尚未返回时 data 可能为 null
    if (!data) {
      if (totalsEl) totalsEl.innerHTML = '合计: —';
      if (emptyEl) emptyEl.style.display = 'flex';
      canvas.style.display = 'none';
      tbody.innerHTML = '<tr><td colspan="6" class="empty">加载每日盈亏…</td></tr>';
      return;
    }

    const days = data.days || [];
    const summary = data.summary || {};
    const total = Number(summary.total_pnl_usdc) || 0;
    const realized = Number(summary.realized_pnl_usdc) || 0;
    const unrealized = Number(summary.unrealized_pnl_usdc) || 0;

    if (totalsEl) {
      const strategy = summary.strategy_realized_pnl_usdc;
      const residual = summary.realized_residual_usdc;
      const capital = summary.initial_capital_usdc;
      let sub = `已实现 ${money(realized, true)} · 未实现 ${money(unrealized, true)}`;
      if (data.cash_truth && capital != null) {
        sub += ` · 口径: 权益−初始$${Number(capital).toFixed(2)}`;
      } else {
        sub += ` · ${data.source === 'polymarket_closed' ? 'Polymarket/策略' : '策略账本'}`;
      }
      if (strategy != null && residual != null && Math.abs(Number(residual)) > 0.05) {
        sub += ` · 逐日 ${money(strategy, true)} + 偏差 ${money(residual, true)}`;
      }
      totalsEl.innerHTML =
        `合计: <span class="${clsPnL(total)}">${money(total, true)}</span>` +
        `<span class="daily-pnl-sub">(${sub})</span>`;
    }

    // Skip chart paint while sheet is hidden (zero width) — redraw on tab switch
    const dailyPage = $('sheet-daily');
    const sheetVisible = dailyPage && dailyPage.classList.contains('active');

    if (!days.length) {
      if (emptyEl) emptyEl.style.display = 'flex';
      canvas.style.display = 'none';
      tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无每日盈亏数据</td></tr>';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    canvas.style.display = 'block';

    tbody.innerHTML = [...days].reverse().map((d) => {
      const tot = Number(d.total_pnl_usdc) || 0;
      const real = Number(d.realized_pnl_usdc) || 0;
      const unreal = Number(d.unrealized_pnl_usdc) || 0;
      const dayLabel = d.is_residual
        ? `<strong title="成交/结算记账与 CLOB 现金差额">记账偏差</strong>`
        : d.is_rebate
          ? `<strong title="Polymarket Maker 返佣">Maker 返佣</strong>`
          : `<strong>${d.day}</strong>`;
      return `<tr${d.is_residual || d.is_rebate ? ' class="residual-row"' : ''}>
        <td>${dayLabel}</td>
        <td class="${clsPnL(real)}">${money(real, true)}</td>
        <td class="${clsPnL(unreal)}">${money(unreal, true)}</td>
        <td class="${clsPnL(tot)}">${money(tot, true)}</td>
        <td>${d.trade_count || 0}</td>
        <td>${d.open_positions || 0} / ${d.closed_positions || 0}</td>
      </tr>`;
    }).join('');

    if (!sheetVisible) return;

    const wrap = canvas.parentElement;
    const cssW = Math.max(640, (wrap && wrap.clientWidth) || 1100);
    const cssH = 280;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const pad = { top: 24, right: 16, bottom: 44, left: 52 };
    const plotW = cssW - pad.left - pad.right;
    const plotH = cssH - pad.top - pad.bottom;
    const values = days.map((d) => Number(d.total_pnl_usdc) || 0);
    const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));
    const midY = pad.top + plotH / 2;
    const scale = (plotH / 2) / maxAbs;

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, midY);
    ctx.lineTo(pad.left + plotW, midY);
    ctx.stroke();

    ctx.fillStyle = '#6b7280';
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`+$${maxAbs.toFixed(0)}`, pad.left - 8, pad.top + 10);
    ctx.fillText('0', pad.left - 8, midY + 4);
    ctx.fillText(`-$${maxAbs.toFixed(0)}`, pad.left - 8, pad.top + plotH);

    const n = days.length;
    const gap = Math.min(12, plotW / (n * 4));
    const barW = Math.max(8, (plotW - gap * (n + 1)) / n);

    days.forEach((d, i) => {
      const v = values[i];
      const x = pad.left + gap + i * (barW + gap);
      const h = Math.abs(v) * scale;
      const y = v >= 0 ? midY - h : midY;
      ctx.fillStyle = v >= 0 ? 'rgba(16, 185, 129, 0.85)' : 'rgba(239, 68, 68, 0.85)';
      ctx.fillRect(x, y, barW, Math.max(h, v === 0 ? 0 : 2));

      ctx.save();
      ctx.fillStyle = '#9ca3af';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      const label = String(d.day || '').slice(5);
      ctx.translate(x + barW / 2, pad.top + plotH + 14);
      if (n > 14) {
        ctx.rotate(-Math.PI / 4);
        ctx.textAlign = 'right';
        ctx.fillText(label, 0, 0);
      } else {
        ctx.fillText(label, 0, 0);
      }
      ctx.restore();

      if (n <= 20 && Math.abs(v) > 0.01) {
        ctx.fillStyle = v >= 0 ? '#10b981' : '#ef4444';
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        const ty = v >= 0 ? y - 4 : y + h + 12;
        ctx.fillText(money(v, true), x + barW / 2, ty);
      }
    });
  }

  function switchSheet(name) {
    document.querySelectorAll('.sheet-page').forEach((el) => {
      el.classList.toggle('active', el.dataset.sheet === name);
    });
    document.querySelectorAll('.sheet-tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.sheet === name);
    });
    if (name === 'daily') {
      fetchDailyPnl(true).catch(() => {});
      requestAnimationFrame(() => renderDailyPnl(lastDailyPnl));
    }
    if (name === 'reconcile') {
      fetchReconcile(true).catch(() => {});
      requestAnimationFrame(() => renderReconcile(lastReconcile));
    }
  }

  function render(data) {
    renderPnl(data);

    const mode = data.dry_run ? 'PAPER' : 'LIVE';
    $('modeBadge').textContent = mode;
    $('modeBadge').className = `badge ${data.dry_run ? 'paper' : 'live'}`;
    $('statusBadge').textContent = data.paused ? 'PAUSED' : (data.status || 'running').toUpperCase();
    renderRisk(data);
    $('pauseBtn').textContent = data.paused ? '恢复' : '暂停';
    const clearBtn = $('clearBtn');
    if (clearBtn) {
      clearBtn.style.display = data.dry_run ? '' : 'none';
      clearBtn.disabled = !data.dry_run;
      clearBtn.title = data.dry_run ? '' : '实盘禁止清除账本';
    }

    const s = data.last_signal;
    if (s) {
      const p = s.plan || {};
      const line1 = [
        s.title || s.slug,
        `t=${s.t}s`,
        `Up ask=${s.upAsk}`,
        `Down ask=${s.downAsk}`,
        `pairSum=${s.pairSum != null ? Number(s.pairSum).toFixed(3) : '—'}`,
      ].join(' · ');
      const line2 = [
        `plan: ${p.action}${p.mode ? `/${p.mode}` : ''}${p.reason ? ` (${p.reason})` : ''}`,
        `scan: ${formatHkt(data.last_scan)}`,
      ].join(' · ');
      $('signalBody').textContent = `${line1}\n${line2}`;
    }

    const positions = data.open_positions || [];
    const marks = Object.fromEntries((data.marks || []).map((m) => [m.conditionId, m]));
    const body = $('posBody');
    if (!positions.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">暂无持仓</td></tr>';
    } else {
      body.innerHTML = positions.map((p) => {
        const m = marks[p.conditionId] || {};
        const invested = Number(p.investedUsdc != null ? p.investedUsdc : ((Number(p.upCost) || 0) + (Number(p.downCost) || 0)));
        const unreal = m.unrealized != null
          ? Number(m.unrealized)
          : (m.mtm != null ? Number(m.mtm) - invested : null);
        return `<tr>
          <td class="market-name" title="${String(p.title || p.slug || '').replace(/"/g, '&quot;')}">${p.title || p.slug || '—'}</td>
          <td>${sideCell(p.upShares, p.upCost, m.upMark)}</td>
          <td>${sideCell(p.downShares, p.downCost, m.downMark)}</td>
          <td>${money(invested)}</td>
          <td class="${clsPnL(unreal)}">${money(unreal, true)}</td>
        </tr>`;
      }).join('');
    }

    renderDailyPnl(data.daily_pnl);
    if (data.reconcile) renderReconcile(data.reconcile);

    const orders = data.open_orders || [];
    $('ordersCount').textContent = orders.length ? `(${orders.length})` : '';
    const ob = $('ordersBody');
    if (!ob) { /* panel missing */ }
    else if (!orders.length) {
      ob.innerHTML = '<tr><td colspan="6" class="empty">暂无挂单</td></tr>';
    } else {
      ob.innerHTML = orders.map((o) => `<tr>
        <td class="market-name" title="${String(o.title || o.slug || '').replace(/"/g, '&quot;')}">${o.title || o.slug || '—'}</td>
        <td>${o.outcome || o.side || '—'}</td>
        <td>${Number(o.limit).toFixed(2)}</td>
        <td>${Number(o.remaining).toFixed(2)} / ${Number(o.originalSize).toFixed(2)}</td>
        <td>${o.queueAhead != null ? Number(o.queueAhead).toFixed(1) : '—'}</td>
        <td>${money(o.reservedUsdc)}</td>
      </tr>`).join('');
    }

    const form = $('paramsForm');
    const params = data.params || {};
    for (const el of form.elements) {
      if (el.name && params[el.name] != null && document.activeElement !== el) {
        el.value = params[el.name];
      }
    }

    $('logList').innerHTML = (data.logs || []).slice(0, 60).map((l) =>
      `<li class="${l.type || ''}">[${formatHkt(l.ts)}] ${l.message}</li>`
    ).join('');
  }

  async function refresh() {
    try {
      lastStatus = await fetchStatus();
      render(lastStatus);
      fetchReconcile(false).catch(() => {});
      fetchDailyPnl(false).catch(() => {});
    } catch (err) {
      $('signalBody').textContent = `面板连接失败: ${err.message}`;
    }
  }

  $('pauseBtn').onclick = async () => {
    const btn = $('pauseBtn');
    const paused = Boolean(lastStatus?.paused);
    btn.disabled = true;
    try {
      await apiPost('/api/pause', { paused: !paused });
      if (lastStatus) {
        lastStatus.paused = !paused;
        lastStatus.status = !paused ? 'paused' : 'running';
        render(lastStatus);
      }
      refresh();
    } catch (err) {
      showToast(`操作失败: ${err.message}`, false);
    } finally {
      btn.disabled = false;
    }
  };

  $('scanBtn').onclick = async () => {
    const btn = $('scanBtn');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '扫描中...';
    try {
      await apiPost('/api/scan');
      await refresh();
    } catch (err) {
      showToast(`扫描失败: ${err.message}`, false);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  $('syncAccountBtn').onclick = async () => {
    const btn = $('syncAccountBtn');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '同步中...';
    try {
      const res = await apiPost('/api/sync-account');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `服务器返回 ${res.status}`);
      }
      showToast(
        data.message
          || (data.dry_run
            ? (data.account_cash_usdc === 0 ? '纸上账户现金为 $0' : `已同步纸上现金 ${money(data.account_cash_usdc)}`)
            : (data.account_cash_usdc === 0
              ? '实盘账户 CLOB 抵押余额为 $0'
              : `已同步实盘余额 ${money(data.account_cash_usdc)}`)),
        true
      );
      await refresh();
    } catch (err) {
      showToast(`账户同步失败: ${err.message}`, false);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  $('refreshMarksBtn').onclick = async () => {
    const btn = $('refreshMarksBtn');
    const hint = $('positionsRefreshHint');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '刷新中...';
    if (hint) hint.textContent = '正在从 CLOB 获取最新市价...';
    try {
      const res = await apiPost('/api/refresh-marks');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `服务器返回 ${res.status}`);
      }
      // Re-render from full status so signals/logs stay in sync
      await refresh();
      const now = new Date().toLocaleTimeString();
      if (hint) {
        hint.textContent = data.failed > 0
          ? `已更新 ${data.updated} 个持仓，${data.failed} 个无报价 · ${now}`
          : `已更新 ${data.updated} 个持仓市价 · ${now}`;
      }
      showToast('市价已刷新', true);
    } catch (err) {
      if (hint) hint.textContent = `刷新失败: ${err.message}`;
      showToast(`刷新市价失败: ${err.message}`, false);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  $('settleCheckBtn').onclick = async () => {
    const btn = $('settleCheckBtn');
    const hint = $('positionsRefreshHint');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检查中...';
    if (hint) hint.textContent = '正在向 Polymarket 查询持仓是否已结算...';
    try {
      const res = await apiPost('/api/settle-check');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `服务器返回 ${res.status}`);
      }
      await refresh();
      const now = new Date().toLocaleTimeString();
      const checked = Number(data.checked) || 0;
      const settled = Number(data.settled) || 0;
      const unresolved = Number(data.unresolved) || 0;
      if (hint) {
        hint.textContent = checked === 0
          ? `无开放持仓可检查 · ${now}`
          : `检查 ${checked} 个 · 已结算 ${settled} · 未结算 ${unresolved} · ${now}`;
      }
      showToast(
        checked === 0
          ? '无开放持仓'
          : (settled > 0 ? `已结算 ${settled} 个持仓` : '暂无已结算持仓'),
        true
      );
    } catch (err) {
      if (hint) hint.textContent = `结算检查失败: ${err.message}`;
      showToast(`结算检查失败: ${err.message}`, false);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  document.querySelectorAll('.sheet-tab').forEach((btn) => {
    btn.onclick = () => switchSheet(btn.dataset.sheet);
  });

  document.querySelectorAll('.recon-view-tab').forEach((btn) => {
    btn.onclick = () => setReconView(btn.dataset.reconView);
  });

  function bindReconPager(pagerId, getPage, setPage, render) {
    const pager = $(pagerId);
    if (!pager) return;
    pager.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-recon-page]');
      if (!btn || btn.disabled) return;
      const dir = btn.dataset.reconPage;
      if (dir === 'prev') setPage(Math.max(1, getPage() - 1));
      else if (dir === 'next') setPage(getPage() + 1);
      else return;
      render();
    });
  }
  bindReconPager(
    'reconWindowPager',
    () => reconWindowPage,
    (p) => { reconWindowPage = p; },
    renderReconcileWindowsPage,
  );
  bindReconPager(
    'reconFillPager',
    () => reconFillPage,
    (p) => { reconFillPage = p; },
    renderReconcileFillsPage,
  );

  $('clearBtn').onclick = async () => {
    if (!confirm('确认清除当前实例账本？')) return;
    const res = await apiPost('/api/clear');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || `清除失败 (${res.status})`, false);
      return;
    }
    refresh();
  };

  $('paramsForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const patch = {};
    for (const [k, v] of fd.entries()) patch[k] = Number(v);
    try {
      const res = await apiPost('/api/params', patch);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || `保存失败 (${res.status})`, false);
        return;
      }
      const data = await res.json().catch(() => ({}));
      const extra = Array.isArray(data.notes) && data.notes.length
        ? ` · ${data.notes.join('；')}`
        : '';
      showToast(`参数保存成功${extra}`, true);
      refresh();
    } catch (err) {
      showToast(`保存失败: ${err.message}`, false);
    }
  };

  readTokenFromUrl();
  refresh();
  setInterval(refresh, 10000);
})();
