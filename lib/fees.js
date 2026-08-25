/**
 * Polymarket CLOB V2 taker fee: shares × r × p × (1 − p)
 * Cash model mirrors baloneigh `withTakerFeeCash`.
 */
const DEFAULT_TAKER_FEE_RATE = (() => {
  const v = parseFloat(process.env.TAKER_FEE_RATE ?? '0.07');
  return Number.isFinite(v) && v >= 0 ? v : 0.07;
})();

const rnd = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

function estimateTakerFeeUsdc(shares, price, feeRate = DEFAULT_TAKER_FEE_RATE) {
  if (!(shares > 0) || !(price > 0) || !(feeRate > 0)) return 0;
  const p = Math.min(0.999, Math.max(0.001, Number(price)));
  return rnd(shares * feeRate * p * (1 - p));
}

/**
 * BUY cash out = notional + fee (fee folded into cost basis like baloneigh).
 */
function withTakerFeeCash(side, shares, price, usdcFromApi = null, feeRate = DEFAULT_TAKER_FEE_RATE) {
  const notional = rnd(shares * price, 6);
  const feeEst = estimateTakerFeeUsdc(shares, price, feeRate);
  const tol = Math.max(0.002, Math.abs(notional) * 0.002);
  let usdc = Number(usdcFromApi);
  let fee = 0;

  if (String(side).toUpperCase() === 'BUY') {
    if (Number.isFinite(usdc) && usdc > 0) {
      if (Math.abs(usdc - notional) <= tol) {
        fee = feeEst;
        usdc = notional + fee;
      } else if (usdc > notional) {
        fee = rnd(usdc - notional);
      } else {
        fee = feeEst;
        usdc = notional + fee;
      }
    } else {
      fee = feeEst;
      usdc = notional + fee;
    }
    return {
      notional: rnd(notional, 4),
      fee: rnd(fee, 6),
      usdc: rnd(usdc, 4),
      cost: rnd(usdc, 4),
    };
  }

  // SELL: proceeds = notional − fee
  if (Number.isFinite(usdc) && usdc > 0) {
    if (Math.abs(usdc - notional) <= tol) {
      fee = feeEst;
      usdc = Math.max(0, notional - fee);
    } else if (usdc < notional) {
      fee = rnd(notional - usdc);
    } else {
      fee = feeEst;
      usdc = Math.max(0, notional - fee);
    }
  } else {
    fee = feeEst;
    usdc = Math.max(0, notional - fee);
  }
  return {
    notional: rnd(notional, 4),
    fee: rnd(fee, 6),
    usdc: rnd(usdc, 4),
    proceeds: rnd(usdc, 4),
  };
}

function buyCostWithFee(shares, price, feeRate = DEFAULT_TAKER_FEE_RATE, usdcFromApi = null) {
  const cash = withTakerFeeCash('BUY', shares, price, usdcFromApi, feeRate);
  return {
    notional: cash.notional,
    fee: cash.fee,
    cost: cash.cost,
  };
}

module.exports = {
  DEFAULT_TAKER_FEE_RATE,
  rnd,
  estimateTakerFeeUsdc,
  withTakerFeeCash,
  buyCostWithFee,
};
