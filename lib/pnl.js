const { openPositions, settledPositions, positionInvested, readFills } = require('./ledger');
const { rnd } = require('./fees');
const { getPairQuotes, getMarketPrice } = require('./book');
const { loadParams } = require('./strategy');

/** Prefer mid; else ask; else bid. */
function sideMarkPrice(ask, bid) {
  const a = ask != null ? Number(ask) : null;
  const b = bid != null ? Number(bid) : null;
  if (a != null && Number.isFinite(a) && b != null && Number.isFinite(b)) {
    return rnd((a + b) / 2, 4);
  }
  if (a != null && Number.isFinite(a)) return rnd(a, 4);
  if (b != null && Number.isFinite(b)) return rnd(b, 4);
  return null;
}

/**
 * Mark-to-market inventory value:
 * mtm = upShares×upMark + downShares×downMark
 * unrealized = mtm − (upCost + downCost)
 */
function positionMtm(pos, upPx, downPx) {
  const upSh = Number(pos.upShares) || 0;
  const downSh = Number(pos.downShares) || 0;
  let mtm = 0;
  if (upSh > 1e-12) {
    if (upPx == null || !Number.isFinite(Number(upPx))) return null;
    mtm += upSh * Number(upPx);
  }
  if (downSh > 1e-12) {
    if (downPx == null || !Number.isFinite(Number(downPx))) return null;
    mtm += downSh * Number(downPx);
  }
  return rnd(mtm, 4);
}

/**
 * @param {object} state
 * @param {{ allowHttp?: boolean }} [opts]
 *   allowHttp=false → WS top-of-book only (fast panel path; no CLOB HTTP)
 */
async function markOpenPositions(state, opts = {}) {
  const allowHttp = opts.allowHttp !== false;
  const marks = [];
  for (const pos of openPositions(state)) {
    const invested = positionInvested(pos);
    try {
      let pair;
      let upMkt;
      let downMkt;
      if (allowHttp) {
        [pair, upMkt, downMkt] = await Promise.all([
          getPairQuotes({
            upTokenId: pos.upTokenId,
            downTokenId: pos.downTokenId,
          }),
          getMarketPrice(pos.upTokenId),
          getMarketPrice(pos.downTokenId),
        ]);
      } else {
        const { marketWs } = require('./market_ws');
        const upTop = marketWs.getFreshTop(pos.upTokenId);
        const downTop = marketWs.getFreshTop(pos.downTokenId);
        pair = {
          up: { ask: upTop?.ask || null, bid: upTop?.bid || null },
          down: { ask: downTop?.ask || null, bid: downTop?.bid || null },
          askSum: upTop?.ask && downTop?.ask ? upTop.ask.price + downTop.ask.price : null,
          bidSum: upTop?.bid && downTop?.bid ? upTop.bid.price + downTop.bid.price : null,
        };
        upMkt = upTop?.bid && upTop?.ask
          ? { price: (upTop.bid.price + upTop.ask.price) / 2, source: upTop.source || 'ws' }
          : { price: null, source: 'ws-miss' };
        downMkt = downTop?.bid && downTop?.ask
          ? { price: (downTop.bid.price + downTop.ask.price) / 2, source: downTop.source || 'ws' }
          : { price: null, source: 'ws-miss' };
      }
      const upAsk = pair.up?.ask?.price ?? null;
      const downAsk = pair.down?.ask?.price ?? null;
      const upBid = pair.up?.bid?.price ?? null;
      const downBid = pair.down?.bid?.price ?? null;
      // 市价：优先 CLOB midpoint（官方当前价），再退回盘口中间价
      let upPx = upMkt.price != null ? rnd(upMkt.price, 4) : sideMarkPrice(upAsk, upBid);
      let downPx = downMkt.price != null ? rnd(downMkt.price, 4) : sideMarkPrice(downAsk, downBid);
      // WS 缺行情时补 HTTP；已到期窗口再尝试官方结算价，避免浮盈被隐藏
      if (upPx == null || downPx == null) {
        const [upHttp, downHttp] = await Promise.all([
          upPx == null ? getMarketPrice(pos.upTokenId) : null,
          downPx == null ? getMarketPrice(pos.downTokenId) : null,
        ]);
        if (upPx == null && upHttp?.price != null) {
          upPx = rnd(upHttp.price, 4);
          upMkt = { price: upPx, source: upHttp.source || 'http' };
        }
        if (downPx == null && downHttp?.price != null) {
          downPx = rnd(downHttp.price, 4);
          downMkt = { price: downPx, source: downHttp.source || 'http' };
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const ended = Number(pos.windowEnd) > 0 && nowSec >= Number(pos.windowEnd);
        if (ended && (upPx == null || downPx == null)) {
          try {
            const { resolveMarksForPosition } = require('./settle');
            const settled = await resolveMarksForPosition(pos, nowSec, loadParams());
            if (settled?.upMark != null && upPx == null) {
              upPx = rnd(settled.upMark, 4);
              upMkt = { price: upPx, source: settled.source || 'settle' };
            }
            if (settled?.downMark != null && downPx == null) {
              downPx = rnd(settled.downMark, 4);
              downMkt = { price: downPx, source: settled.source || 'settle' };
            }
          } catch (_) { /* ignore */ }
        }
      }
      const mtm = positionMtm(pos, upPx, downPx);
      const unrealized = mtm != null ? rnd(mtm - invested, 4) : null;
      marks.push({
        conditionId: pos.conditionId,
        title: pos.title,
        slug: pos.slug,
        upShares: pos.upShares,
        downShares: pos.downShares,
        upCost: pos.upCost,
        downCost: pos.downCost,
        invested,
        mtm,
        unrealized,
        upMark: upPx,
        downMark: downPx,
        upMarkSource: upMkt.source || null,
        downMarkSource: downMkt.source || null,
        upAsk,
        downAsk,
        upBid,
        downBid,
        askSum: pair.askSum,
        bidSum: pair.bidSum,
        pairSum: pair.bidSum ?? pair.askSum,
        markedAt: new Date().toISOString(),
      });
    } catch (_) {
      const mtm = positionMtm(pos, null, null);
      marks.push({
        conditionId: pos.conditionId,
        title: pos.title,
        invested,
        mtm,
        unrealized: mtm != null ? rnd(mtm - invested, 4) : null,
        upMark: null,
        downMark: null,
      });
    }
  }
  return marks;
}

function backfillBuyVolume(state) {
  const cur = Number(state.stats.total_buy_usdc) || 0;
  if (cur > 0 || !(Number(state.stats.fills) > 0)) return cur;
  try {
    const sum = readFills().reduce((a, f) => a + (Number(f.cost) || 0), 0);
    state.stats.total_buy_usdc = rnd(sum, 4);
    return state.stats.total_buy_usdc;
  } catch (_) {
    return cur;
  }
}

function buildPnlSnapshot(state, marks = []) {
  const openCost = openPositions(state).reduce((a, p) => a + positionInvested(p), 0);
  const openMtm = marks.reduce((a, m) => {
    if (m.mtm != null && Number.isFinite(Number(m.mtm))) return a + Number(m.mtm);
    // If mark failed, keep cost so unrealized stays 0 for that row
    return a + (Number(m.invested) || 0);
  }, 0);
  const unrealized = rnd(openMtm - openCost, 4);
  const realized = Number(state.stats.realized_pnl_usdc) || 0;
  // Identity: total = realized + unrealized (always)
  const totalPnl = rnd(realized + unrealized, 4);
  const cash = Number(state.cash_usdc) || 0;
  const capital = Number(state.initial_capital_usdc) || 1000;
  const equity = rnd(capital + totalPnl, 4);
  // Paper account cash: 初始资金 + 已实现 − 持仓成本（含挂单占款，不含浮盈）
  const paperAccountCash = rnd(capital + realized - openCost, 4);

  const totalBuy = backfillBuyVolume(state);
  let totalProceeds = Number(state.stats.total_proceeds_usdc) || 0;
  if (!(totalProceeds > 0) && totalBuy > 0) {
    totalProceeds = rnd(Math.max(0, totalBuy - capital + cash), 4);
  }
  const roc = capital > 0 ? rnd((totalPnl / capital) * 100, 2) : null;
  const turnover = capital > 0 ? rnd((totalBuy / capital) * 100, 2) : null;

  return {
    initial_capital_usdc: capital,
    cash_usdc: cash,
    paper_account_cash_usdc: paperAccountCash,
    open_cost_usdc: rnd(openCost, 4),
    open_mtm_usdc: rnd(openMtm, 4),
    total_buy_usdc: rnd(totalBuy, 4),
    total_proceeds_usdc: rnd(totalProceeds, 4),
    unrealized_pnl_usdc: unrealized,
    realized_pnl_usdc: rnd(realized, 4),
    strategy_realized_pnl_usdc: Number(state.stats.strategy_realized_pnl_usdc) || null,
    realized_pnl_clob_drift_usdc: Number(state.stats.realized_pnl_clob_drift_usdc) || null,
    equity_usdc: equity,
    total_pnl_usdc: totalPnl,
    roc_pct: roc,
    turnover_pct: turnover,
    fees_usdc: Number(state.stats.fees_usdc) || 0,
    reserved_usdc: Number(state.reserved_usdc) || 0,
    free_cash_usdc: cash,
    open_orders: Array.isArray(state.open_orders)
      ? state.open_orders.filter((o) => o.status === 'open').length
      : 0,
    open_markets: openPositions(state).length,
    settled_markets: settledPositions(state).length,
    fills: Number(state.stats.fills) || 0,
  };
}

module.exports = {
  markOpenPositions,
  buildPnlSnapshot,
  sideMarkPrice,
  positionMtm,
};
