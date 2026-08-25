const { loadParams } = require('./strategy');

/**
 * Slippage helpers aligned with baloneigh:
 * buffer = max(% of planned price, absolute ¢ tolerance).
 */
function effectiveSlipBufferUsdc(plannedPrice, params = loadParams()) {
  const planned = Number(plannedPrice);
  if (!(planned > 0)) return { buffer: 0, pctBuf: 0, absBuf: 0, boundByAbs: false };
  const slip = Math.max(0, Number(params.slippage_limit) || 0);
  const tolCents = Math.max(0, Number(params.min_slippage_tolerance_cents) || 0);
  const pctBuf = planned * slip;
  const absBuf = tolCents / 100;
  const buffer = Math.max(pctBuf, absBuf);
  return {
    buffer,
    pctBuf,
    absBuf,
    boundByAbs: absBuf > pctBuf + 1e-12,
  };
}

/** BUY: skip if market ask rises too far vs planned ask. */
function evaluateBuySlippage(plannedPrice, marketAsk, params = loadParams()) {
  const planned = Number(plannedPrice);
  const market = Number(marketAsk);
  if (!(planned > 0)) {
    return { ok: false, reason: 'Invalid planned price for slippage check', marketPrice: marketAsk };
  }
  if (!(market > 0)) {
    return { ok: false, reason: 'Market quote unavailable — skip (slippage cannot be verified)', marketPrice: null };
  }

  const adverseMove = Math.max(0, market - planned);
  const adversePct = adverseMove / planned;
  const absMoveCents = Math.abs(market - planned) * 100;
  const { buffer, pctBuf, absBuf, boundByAbs } = effectiveSlipBufferUsdc(planned, params);
  const slip = Math.max(0, Number(params.slippage_limit) || 0);
  const tolCents = Math.max(0, Number(params.min_slippage_tolerance_cents) || 0);

  if (adverseMove <= buffer + 1e-12) {
    return {
      ok: true,
      adverseSlippage: adversePct,
      marketPrice: market,
      absMoveCents,
      slipBuffer: buffer,
      boundByAbs,
    };
  }

  return {
    ok: false,
    adverseSlippage: adversePct,
    marketPrice: market,
    absMoveCents,
    slipBuffer: buffer,
    boundByAbs,
    reason:
      `Market adverse ${adverseMove.toFixed(4)} > buffer ${buffer.toFixed(4)}` +
      ` (max of ${(slip * 100).toFixed(2)}%=${(pctBuf * 100).toFixed(2)}¢` +
      ` and ±${tolCents}¢=${(absBuf * 100).toFixed(2)}¢` +
      `; |Δ|=${absMoveCents.toFixed(2)}¢; planned $${planned}, market $${market})`,
  };
}

/**
 * Paper/live limit: hang at current ask, capped by planned + buffer.
 */
function tightBuyLimit(plannedPrice, marketAsk, params = loadParams()) {
  const planned = Number(plannedPrice);
  const mkt = Number(marketAsk);
  if (!(mkt > 0)) return null;
  const clampedMkt = Math.max(0.01, Math.min(0.99, mkt));
  if (!(planned > 0)) return Number(clampedMkt.toFixed(4));
  const { buffer } = effectiveSlipBufferUsdc(planned, params);
  const ceiling = Math.min(0.99, planned + buffer);
  return Number(Math.min(clampedMkt, ceiling).toFixed(4));
}

/** Paper fill price: min(limit, ask) — same as baloneigh BUY sim. */
function paperBuyFillPrice(limitPx, marketAsk) {
  const limit = Number(limitPx);
  const mkt = Number(marketAsk);
  let fill = Number.isFinite(limit) ? limit : mkt;
  if (Number.isFinite(mkt) && mkt > 0 && Number.isFinite(limit)) {
    fill = Math.min(limit, mkt);
  }
  return Math.max(0.01, Math.min(0.99, fill));
}

module.exports = {
  effectiveSlipBufferUsdc,
  evaluateBuySlippage,
  tightBuyLimit,
  paperBuyFillPrice,
};
