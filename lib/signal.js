const { loadParams } = require('./strategy');
const { secondsIntoWindow } = require('./markets');
const { getPairQuotes } = require('./book');
const { positionInvested, windowSpentUsdc } = require('./ledger');
const { rnd } = require('./fees');
const {
  pairEntryBlocked,
  pairEntryRiskGate,
  rebalanceRiskGate,
} = require('./pair_risk');

/**
 * Dual-sided BTC 5m plan.
 * Default quote_mode=maker: gate on bid_up+bid_down, post/fill at bid.
 * Taker mode lifts both asks (rarely available under pair_sum_max).
 */
function quoteMode(params) {
  return String(params.quote_mode || 'maker').toLowerCase() === 'taker' ? 'taker' : 'maker';
}

function sideQuotes(pairQuotes, mode) {
  if (mode === 'taker') {
    return {
      up: pairQuotes?.up?.ask || null,
      down: pairQuotes?.down?.ask || null,
      pairSum: pairQuotes?.askSum ?? null,
      label: 'ask',
    };
  }
  return {
    up: pairQuotes?.up?.bid || null,
    down: pairQuotes?.down?.bid || null,
    pairSum: pairQuotes?.bidSum ?? null,
    label: 'bid',
  };
}

/** Optional 1-tick improve toward ask when still under pair_sum_max. */
function makerLimitPrice(bid, ask, pairBidSum, params) {
  const b = Number(bid);
  if (!(b > 0)) return null;
  const improve = Math.max(0, Math.floor(Number(params.maker_improve_ticks) || 0));
  if (!improve) return rnd(b, 4);
  const tick = 0.01 * improve;
  const a = Number(ask);
  let px = rnd(b + tick, 4);
  if (Number.isFinite(a) && a > 0) px = Math.min(px, rnd(a - 0.01, 4));
  // Keep improved pair under threshold (both legs improved)
  const maxSum = Number(params.pair_sum_max) || 0.99;
  if (pairBidSum + 2 * tick > maxSum + 1e-12) return rnd(b, 4);
  return Math.max(0.01, Math.min(0.99, px));
}

function evaluateMarket(
  market,
  pairQuotes,
  position,
  params = loadParams(),
  nowSec = Math.floor(Date.now() / 1000),
  opts = {}
) {
  const t = secondsIntoWindow(market, nowSec);
  if (t < params.entry_start_sec) {
    return { action: 'WAIT', reason: `t=${t}s < entry ${params.entry_start_sec}s` };
  }
  if (t > params.entry_end_sec) {
    return { action: 'HOLD', reason: `t=${t}s > entry end ${params.entry_end_sec}s` };
  }

  const mode = quoteMode(params);
  const q = sideQuotes(pairQuotes, mode);
  const up = q.up;
  const down = q.down;
  if (!up || !down) {
    return {
      action: 'SKIP',
      reason: `missing ${q.label} on one side`,
      askSum: pairQuotes?.askSum ?? null,
      bidSum: pairQuotes?.bidSum ?? null,
    };
  }

  const pu0 = Number(up.price);
  const pd0 = Number(down.price);
  const rawSum = pu0 + pd0;

  let pu = pu0;
  let pd = pd0;
  if (mode === 'maker') {
    pu = makerLimitPrice(pu0, pairQuotes?.up?.ask?.price, rawSum, params);
    pd = makerLimitPrice(pd0, pairQuotes?.down?.ask?.price, rawSum, params);
  }
  const pairSum = pu + pd;

  if (pu < params.min_ask || pu > params.max_ask || pd < params.min_ask || pd > params.max_ask) {
    return {
      action: 'SKIP',
      reason: `${q.label} out of band Up=${pu} Down=${pd} want [${params.min_ask},${params.max_ask}]`,
      pairSum,
      askSum: pairQuotes?.askSum ?? null,
      bidSum: pairQuotes?.bidSum ?? null,
      mode,
    };
  }
  if (Math.max(pu, pd) > params.max_ask_skew) {
    return {
      action: 'SKIP',
      reason: `${q.label} skew max=${Math.max(pu, pd)} > ${params.max_ask_skew}`,
      pairSum,
      mode,
    };
  }
  // M3: maker must pass raw bid-sum before any tick improve
  const maxSum = Number(params.pair_sum_max) || 0.99;
  if (mode === 'maker' && !(rawSum <= maxSum + 1e-12)) {
    return {
      action: 'SKIP',
      reason: `raw bidSum ${rawSum.toFixed(3)} > max ${maxSum}`,
      pairSum: rawSum,
      askSum: pairQuotes?.askSum ?? null,
      bidSum: pairQuotes?.bidSum ?? null,
      upAsk: pairQuotes?.up?.ask?.price ?? null,
      downAsk: pairQuotes?.down?.ask?.price ?? null,
      upBid: pairQuotes?.up?.bid?.price ?? null,
      downBid: pairQuotes?.down?.bid?.price ?? null,
      mode,
    };
  }
  if (!(pairSum <= maxSum + 1e-12)) {
    return {
      action: 'SKIP',
      reason: `${q.label}Sum ${pairSum.toFixed(3)} > max ${maxSum}`,
      pairSum,
      askSum: pairQuotes?.askSum ?? null,
      bidSum: pairQuotes?.bidSum ?? null,
      upAsk: pairQuotes?.up?.ask?.price ?? null,
      downAsk: pairQuotes?.down?.ask?.price ?? null,
      upBid: pairQuotes?.up?.bid?.price ?? null,
      downBid: pairQuotes?.down?.bid?.price ?? null,
      mode,
    };
  }

  const invested = position ? windowSpentUsdc(position) : 0;
  const pending = Number(opts.pendingUsdc) || 0;
  const room = Math.max(0, params.max_market_usdc - invested - pending);
  if (room < params.min_order_shares * Math.min(pu, pd)) {
    return { action: 'HOLD', reason: `market cap full spent=$${invested}`, pairSum, mode };
  }

  const upSh = position ? Number(position.upShares) || 0 : 0;
  const downSh = position ? Number(position.downShares) || 0 : 0;
  const imbalance = upSh - downSh;

  // Maker: our size is not capped by resting bid size (we join). Taker: cap by ask size.
  const depthUp = mode === 'taker' ? Number(up.size) || 0 : Infinity;
  const depthDown = mode === 'taker' ? Number(down.size) || 0 : Infinity;

  if (Math.abs(imbalance) > 1e-8) {
    if (Math.abs(imbalance) < params.min_order_shares) {
      return {
        action: 'HOLD',
        reason: `unbalanced Up=${rnd(upSh, 2)} Down=${rnd(downSh, 2)} — await fill/rebalance`,
        pairSum,
        mode,
      };
    }

    const side = imbalance > 0 ? 'Down' : 'Up';
    const px = side === 'Up' ? pu : pd;
    const depth = side === 'Up' ? depthUp : depthDown;

    let shares = Math.min(
      Math.abs(imbalance),
      params.share_chunk,
      depth,
      Math.floor((params.max_trade_usdc / px) * 1e6) / 1e6,
      Math.floor((room / px) * 1e6) / 1e6
    );
    shares = rnd(shares, 4);
    if (shares + 1e-12 < params.min_order_shares) {
      return { action: 'SKIP', reason: `rebalance shares ${shares} < min`, pairSum, mode };
    }

    const rebalanceRisk = rebalanceRiskGate({
      position,
      openOrders: opts.openOrders,
      market,
      state: opts.state,
      params,
      side,
      shares,
      price: px,
    });
    if (rebalanceRisk.blocked) {
      return {
        action: 'HOLD',
        reason: rebalanceRisk.reason,
        pairSum,
        mode,
        riskGate: rebalanceRisk,
      };
    }

    const longShares = imbalance > 0 ? upSh : downSh;
    const longCost = imbalance > 0
      ? (Number(position.upCost) || 0)
      : (Number(position.downCost) || 0);
    const avgLong = longShares > 1e-12 ? longCost / longShares : null;
    const requireEdge = params.rebalance_require_edge;
    const edgeOn = !(requireEdge === 0 || requireEdge === false || requireEdge === '0');

    if (edgeOn && avgLong != null && avgLong + px > maxSum + 1e-12) {
      const completeSum = avgLong + px;
      return {
        action: 'HOLD',
        reason: `rebalance edge gone avg+${mode === 'maker' ? 'bid' : 'ask'}=${completeSum.toFixed(3)} > max ${maxSum}`,
        pairSum,
        completeSum: rnd(completeSum, 4),
        mode,
        askSum: pairQuotes?.askSum ?? null,
        bidSum: pairQuotes?.bidSum ?? null,
      };
    }

    const completeSum = avgLong != null ? avgLong + px : pairSum;
    return {
      action: 'BUY',
      mode: 'rebalance',
      quoteMode: mode,
      legs: [{ side, shares, price: px, tokenId: side === 'Up' ? market.upTokenId : market.downTokenId }],
      pairSum,
      completeSum: avgLong != null ? rnd(completeSum, 4) : pairSum,
      askSum: pairQuotes?.askSum ?? null,
      bidSum: pairQuotes?.bidSum ?? null,
      t,
    };
  }

  const depth = Math.min(depthUp, depthDown);
  let shares = Math.min(
    params.share_chunk,
    depth,
    Math.floor((params.max_trade_usdc / pu) * 1e6) / 1e6,
    Math.floor((params.max_trade_usdc / pd) * 1e6) / 1e6,
    Math.floor((room / pairSum) * 1e6) / 1e6
  );
  shares = rnd(shares, 4);
  if (shares + 1e-12 < params.min_order_shares) {
    return { action: 'SKIP', reason: `pair shares ${shares} < min`, pairSum, mode };
  }

  const pairGate = pairEntryBlocked(t, params, 'pair', {
    windowStart: market.windowStart,
    windowEnd: market.windowEnd,
    nowSec: Math.floor(Date.now() / 1000),
  });
  if (pairGate.blocked) {
    return { action: 'HOLD', reason: pairGate.reason, pairSum, mode, t };
  }

  const riskGate = pairEntryRiskGate({
    position,
    openOrders: opts.openOrders,
    market,
    state: opts.state,
    params,
    mode: 'pair',
    addShares: shares,
    upPrice: pu,
    downPrice: pd,
  });
  if (riskGate.blocked) {
    return { action: 'HOLD', reason: riskGate.reason, pairSum, mode, t, riskGate };
  }

  return {
    action: 'BUY',
    mode: 'pair',
    quoteMode: mode,
    legs: [
      { side: 'Up', shares, price: pu, tokenId: market.upTokenId },
      { side: 'Down', shares, price: pd, tokenId: market.downTokenId },
    ],
    pairSum,
    askSum: pairQuotes?.askSum ?? null,
    bidSum: pairQuotes?.bidSum ?? null,
    t,
  };
}

async function scanMarketSignal(market, position, params = loadParams(), opts = {}) {
  const pairQuotes = await getPairQuotes(market);
  const nowSec = Math.floor(Date.now() / 1000);
  const plan = evaluateMarket(market, pairQuotes, position, params, nowSec, opts);
  const mode = quoteMode(params);
  const pairAsks = {
    up: mode === 'taker' ? pairQuotes.up?.ask : pairQuotes.up?.bid,
    down: mode === 'taker' ? pairQuotes.down?.ask : pairQuotes.down?.bid,
    pairSum: mode === 'taker' ? pairQuotes.askSum : pairQuotes.bidSum,
    askSum: pairQuotes.askSum,
    bidSum: pairQuotes.bidSum,
  };
  return { market, pairAsks, pairQuotes, plan };
}

module.exports = {
  evaluateMarket,
  scanMarketSignal,
  quoteMode,
  sideQuotes,
};
