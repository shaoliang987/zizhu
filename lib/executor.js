const { isDryRun, isLive } = require('./mode');
const { applyBuy, addLog, saveState, getOrCreatePosition } = require('./ledger');
const { buyCostWithFee, rnd } = require('./fees');
const { getPairQuotes } = require('./book');
const { loadParams } = require('./strategy');
const { evaluateMarket, quoteMode } = require('./signal');
const {
  evaluateBuySlippage,
  tightBuyLimit,
  paperBuyFillPrice,
} = require('./slippage');
const {
  postPaperBuy,
  takeAskNow,
  ordersForMarket,
  tickRound,
  feeRateFor: paperFeeRate,
  syncPaperQuotes,
} = require('./paper_clob');
const {
  syncLiveQuotes,
  enforcePairHedge,
  executeSafeTakerPair,
} = require('./live_clob');
const { auditPaperPairExposure } = require('./paper_clob');
const { fetchAccountCashUsdc } = require('./account');
const { pairEntryRiskGate, rebalanceRiskGate, setPairInflight, clearPairInflight, unwindBlocked } = require('./pair_risk');

let _clobClient = null;

async function getClobClient() {
  if (_clobClient) return _clobClient;
  const pk = (process.env.POLYMARKET_PRIVATE_KEY || '').trim();
  if (!pk) throw new Error('POLYMARKET_PRIVATE_KEY 未配置');
  const { ClobClient } = require('@polymarket/clob-client-v2');
  const { Wallet } = require('ethers');
  const wallet = new Wallet(pk);
  const host = process.env.CLOB_API_URL || 'https://clob.polymarket.com';
  const chain = parseInt(process.env.CHAIN_ID || '137', 10);
  const signatureType = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '1', 10);
  const funderAddress = (process.env.POLYMARKET_FUNDER_ADDRESS || '').trim() || wallet.address;
  const baseOpts = { host, chain, signer: wallet, signatureType, funderAddress };
  const temp = new ClobClient(baseOpts);
  let creds;
  try { creds = await temp.createOrDeriveApiKey(); }
  catch (_) { creds = await temp.deriveApiKey(); }
  _clobClient = new ClobClient({ ...baseOpts, creds });
  return _clobClient;
}

async function placeLiveBuy(tokenId, shares, limitPrice) {
  const client = await getClobClient();
  const { Side, OrderType } = require('@polymarket/clob-client-v2');
  const limit = Math.max(0.01, Math.min(0.99, Number(limitPrice) || 0));
  const resp = await client.createAndPostOrder(
    {
      tokenID: String(tokenId),
      price: limit,
      size: shares,
      side: Side.BUY,
    },
    { tickSize: '0.01' },
    OrderType.GTC
  );
  if (!resp || resp.success === false) {
    throw new Error(resp?.errorMsg || resp?.error || resp?.message || 'order rejected');
  }
  return resp;
}

/** Taker buy — FOK at ask (or through) to immediately fill missing pair leg. */
async function placeLiveTakerBuy(tokenId, shares, limitPrice) {
  const client = await getClobClient();
  const { Side, OrderType } = require('@polymarket/clob-client-v2');
  const limit = tickRound(Math.max(0.01, Math.min(0.99, Number(limitPrice) || 0)));
  const size = rnd(Number(shares), 4);
  const resp = await client.createAndPostOrder(
    {
      tokenID: String(tokenId),
      price: limit,
      size,
      side: Side.BUY,
    },
    { tickSize: '0.01' },
    OrderType.FOK
  );
  if (!resp || resp.success === false) {
    throw new Error(resp?.errorMsg || resp?.error || resp?.message || 'taker buy rejected');
  }
  return resp;
}

function feeRateFor(params, qMode) {
  return paperFeeRate(params, qMode === 'maker' ? 'maker' : 'taker');
}

function paperRealistic(params) {
  // Default ON — set paper_realistic=0 to restore instant fills
  const v = params.paper_realistic;
  if (v === 0 || v === false || v === '0') return false;
  return true;
}

/**
 * Maker: fill/rest at planned limit (bid join) — no ask-lift slippage check.
 * Taker: classic adverse ask move gate + tight limit.
 */
function prepareBuyLegFromQuotes(leg, sideQuote, params, qMode) {
  const planned = Number(leg.price);
  const shares = Number(leg.shares);
  const bid = sideQuote?.bid?.price != null ? Number(sideQuote.bid.price) : null;
  const ask = sideQuote?.ask?.price != null ? Number(sideQuote.ask.price) : null;
  const bidSize = sideQuote?.bid?.size != null ? Number(sideQuote.bid.size) : null;
  const askSize = sideQuote?.ask?.size != null ? Number(sideQuote.ask.size) : null;

  if (qMode === 'maker') {
    if (!(planned > 0)) {
      return { ok: false, reason: 'Invalid maker limit', planned, marketAsk: ask };
    }
    // Must not cross the ask (would become taker)
    if (ask != null && planned >= ask - 1e-12) {
      return {
        ok: false,
        reason: `maker limit $${planned} crosses ask $${ask}`,
        planned,
        marketAsk: ask,
      };
    }
    const limit = tickRound(planned);
    const fillPrice = limit;
    const cash = buyCostWithFee(shares, fillPrice, feeRateFor(params, 'maker'));
    return {
      ok: true,
      side: leg.side,
      shares,
      tokenId: leg.tokenId,
      planned,
      marketAsk: ask,
      marketBid: bid,
      bidSize,
      askSize,
      limit,
      fillPrice,
      fee: cash.fee,
      cost: cash.cost,
      notional: cash.notional,
      quoteMode: 'maker',
    };
  }

  const marketAsk = ask;
  const slip = evaluateBuySlippage(planned, marketAsk, params);
  if (!slip.ok) {
    return { ok: false, reason: slip.reason, planned, marketAsk };
  }
  const limit = tightBuyLimit(planned, marketAsk, params);
  if (limit == null) {
    return { ok: false, reason: 'Market quote unavailable — cannot set tight limit', planned, marketAsk };
  }
  const fillPrice = paperBuyFillPrice(limit, marketAsk);
  const cash = buyCostWithFee(shares, fillPrice, feeRateFor(params, 'taker'));
  return {
    ok: true,
    side: leg.side,
    shares,
    tokenId: leg.tokenId,
    planned,
    marketAsk,
    marketBid: bid,
    bidSize,
    askSize,
    limit: tickRound(limit),
    fillPrice,
    fee: cash.fee,
    cost: cash.cost,
    notional: cash.notional,
    quoteMode: 'taker',
  };
}

async function executePlan(state, market, plan) {
  if (!plan || plan.action !== 'BUY' || !Array.isArray(plan.legs) || !plan.legs.length) {
    return { executed: false, reason: plan?.reason || 'no plan' };
  }

  const position = state.positions[market.conditionId] || null;
  const unw = unwindBlocked(position);
  if (unw.blocked) {
    return { executed: false, reason: unw.reason };
  }

  const params = loadParams();
  const qMode = quoteMode(params);
  const realistic = isDryRun() && paperRealistic(params);

  let pairQuotes;
  try {
    pairQuotes = await getPairQuotes(market);
  } catch (err) {
    addLog(state, `[跳过] 重报价失败: ${err.message}`, 'warning');
    state.stats.skipped += 1;
    saveState(state);
    return { executed: false, reason: err.message };
  }

  const pendingUsdc = ordersForMarket(state, market.conditionId)
    .reduce((a, o) => a + (Number(o.reservedUsdc) || 0), 0);
  const marketOrders = ordersForMarket(state, market.conditionId);
  const fresh = evaluateMarket(
    market,
    pairQuotes,
    position,
    params,
    Math.floor(Date.now() / 1000),
    { pendingUsdc, openOrders: marketOrders, state }
  );
  if (fresh.action !== 'BUY') {
    const sumBits = fresh.pairSum != null
      ? ` (${fresh.quoteMode || qMode}Sum=${Number(fresh.pairSum).toFixed(3)}` +
        `; askSum=${fresh.askSum != null ? Number(fresh.askSum).toFixed(3) : '—'}` +
        `; bidSum=${fresh.bidSum != null ? Number(fresh.bidSum).toFixed(3) : '—'})`
      : '';
    addLog(state, `[跳过] 重报价后无买点: ${fresh.reason}${sumBits}`, 'warning');
    state.stats.skipped += 1;
    saveState(state);
    return { executed: false, reason: fresh.reason, plan: fresh };
  }

  const snapPlan = { ...fresh };
  const prepared = [];
  for (const leg of snapPlan.legs) {
    const sideQuote = leg.side === 'Up' ? pairQuotes.up : pairQuotes.down;
    const prep = prepareBuyLegFromQuotes(leg, sideQuote, params, qMode);
    if (!prep.ok) {
      addLog(state, `[跳过] ${leg.side}: ${prep.reason}`, 'warning');
      state.stats.skipped += 1;
      if (snapPlan.mode === 'pair') {
        saveState(state);
        return { executed: false, reason: prep.reason };
      }
      continue;
    }
    // Taker needs ask liquidity for immediate lift; residual can rest
    if (qMode === 'taker' && !realistic && prep.askSize != null && prep.shares > prep.askSize + 1e-9) {
      addLog(state, `[跳过] ${leg.side}: ask size ${prep.askSize} < ${prep.shares}`, 'warning');
      state.stats.skipped += 1;
      if (snapPlan.mode === 'pair') {
        saveState(state);
        return { executed: false, reason: 'insufficient ask size' };
      }
      continue;
    }
    prepared.push(prep);
  }

  if (!prepared.length) {
    saveState(state);
    return { executed: false, reason: 'no legs prepared' };
  }

  if (snapPlan.mode === 'pair' && qMode === 'taker' && !realistic) {
    if (prepared.length < 2) {
      saveState(state);
      return { executed: false, reason: 'pair incomplete' };
    }
    const fillSum = prepared[0].fillPrice + prepared[1].fillPrice;
    const maxSum = Number(params.pair_sum_max) || 0.99;
    if (fillSum > maxSum + 1e-9) {
      addLog(
        state,
        `[跳过] 成交价 pairSum ${fillSum.toFixed(3)} > max ${maxSum}`,
        'warning'
      );
      state.stats.skipped += 1;
      saveState(state);
      return { executed: false, reason: `fill pairSum ${fillSum} > ${maxSum}` };
    }
  }

  // Maker/pair gate on limit sum (what we post), not assumed fill
  if (snapPlan.mode === 'pair' && qMode === 'maker') {
    if (prepared.length < 2) {
      saveState(state);
      return { executed: false, reason: 'pair incomplete' };
    }
    const limitSum = prepared[0].limit + prepared[1].limit;
    const maxSum = Number(params.pair_sum_max) || 0.99;
    if (limitSum > maxSum + 1e-9) {
      addLog(state, `[跳过] 挂单价 pairSum ${limitSum.toFixed(3)} > max ${maxSum}`, 'warning');
      state.stats.skipped += 1;
      saveState(state);
      return { executed: false, reason: `limit pairSum ${limitSum} > ${maxSum}` };
    }
  }

  // Execution-layer re-gate: fresh position + open orders (signal-time gates can be stale)
  const freshPos = state.positions[market.conditionId] || null;
  const freshOrders = ordersForMarket(state, market.conditionId);
  if (snapPlan.mode === 'pair') {
    const upLeg = prepared.find((p) => p.side === 'Up');
    const downLeg = prepared.find((p) => p.side === 'Down');
    const execGate = pairEntryRiskGate({
      position: freshPos,
      openOrders: freshOrders,
      market,
      state,
      params,
      mode: 'pair',
      addShares: Math.min(Number(upLeg?.shares) || 0, Number(downLeg?.shares) || 0),
      upPrice: Number(upLeg?.limit) || 0,
      downPrice: Number(downLeg?.limit) || 0,
    });
    if (execGate.blocked) {
      addLog(state, `[跳过] 下单前风控: ${execGate.reason}`, 'warning');
      state.stats.skipped += 1;
      saveState(state);
      return { executed: false, reason: execGate.reason, riskGate: execGate };
    }
  } else if (snapPlan.mode === 'rebalance' && prepared.length === 1) {
    const leg = prepared[0];
    const execGate = rebalanceRiskGate({
      position: freshPos,
      openOrders: freshOrders,
      market,
      state,
      params,
      side: leg.side,
      shares: leg.shares,
      price: leg.limit,
    });
    if (execGate.blocked) {
      addLog(state, `[跳过] rebalance 风控: ${execGate.reason}`, 'warning');
      state.stats.skipped += 1;
      saveState(state);
      return { executed: false, reason: execGate.reason, riskGate: execGate };
    }
  }

  // H1: count this market's resting reserve as reusable on re-quote
  const reservedHere = ordersForMarket(state, market.conditionId)
    .reduce((a, o) => a + (Number(o.reservedUsdc) || 0), 0);
  const totalNeed = prepared.reduce((a, p) => a + p.cost, 0);
  const ledgerAvailable = rnd((Number(state.cash_usdc) || 0) + reservedHere, 4);

  if (isLive()) {
    // C2: gate on real CLOB collateral (exchange already nets open-order locks)
    let accountCash = null;
    try {
      accountCash = await fetchAccountCashUsdc({ force: true });
    } catch (err) {
      addLog(state, `[跳过] 无法读取 CLOB 余额: ${err.message}`, 'warning');
      state.stats.skipped += 1;
      saveState(state);
      return { executed: false, reason: 'account cash unavailable' };
    }
    if (!(accountCash >= 0) || accountCash + 1e-9 < totalNeed) {
      addLog(
        state,
        `[跳过] CLOB 余额不足 need $${totalNeed.toFixed(4)} account $${Number(accountCash).toFixed(4)}`,
        'warning'
      );
      state.stats.skipped += 1;
      saveState(state);
      return { executed: false, reason: 'insufficient account cash' };
    }
  } else if (ledgerAvailable + 1e-9 < totalNeed) {
    addLog(
      state,
      `[跳过] 余额不足 need $${totalNeed.toFixed(4)} available $${ledgerAvailable.toFixed(4)}` +
        ` (cash $${Number(state.cash_usdc).toFixed(4)} + reservedHere $${reservedHere.toFixed(4)})`,
      'warning'
    );
    state.stats.skipped += 1;
    saveState(state);
    return { executed: false, reason: 'insufficient cash' };
  }

  const results = [];

  // --- LIVE ---
  if (isLive()) {
    if (snapPlan.mode === 'pair') {
      const posLock = getOrCreatePosition(state, market);
      setPairInflight(posLock, 'safe taker pair');
      const taken = await executeSafeTakerPair(state, market, prepared);
      if (taken.ok) {
        clearPairInflight(posLock);
        saveState(state);
        return {
          executed: true,
          results: [taken],
          mode: 'live',
          posted: false,
          plan: snapPlan,
          safeTakerPair: taken,
        };
      }
      // Soft reject → clear inflight. Maker fallback only when quote_mode=maker
      // (taker mode must not rest bid pairs — that recreates one-sided fills).
      // Hard fail (breaker / uncertain fill) → keep lock and stop.
      if (taken.breaker) {
        saveState(state);
        return {
          executed: false,
          results: [taken],
          mode: 'live',
          posted: false,
          plan: snapPlan,
          safeTakerPair: taken,
          reason: taken.reason,
        };
      }
      clearPairInflight(posLock);
      if (qMode === 'taker') {
        addLog(
          state,
          `[实盘] 双TAKER 跳过 (${taken.reason || 'no edge'}) · 不回退 maker · ${market.slug}` +
            (taken.pairCost != null
              ? ` · pairCost=${Number(taken.pairCost).toFixed(4)}` +
                (taken.normalMax != null ? ` > ${taken.normalMax}` : '')
              : ''),
          'info'
        );
        saveState(state);
        return {
          executed: false,
          results: [taken],
          mode: 'live',
          posted: false,
          plan: snapPlan,
          safeTakerPair: taken,
          reason: taken.reason || 'safe taker skipped',
        };
      }
      addLog(
        state,
        `[实盘] 双TAKER 跳过 (${taken.reason || 'no edge'}) · 改挂 maker bid pair · ${market.slug}`,
        'info'
      );
      setPairInflight(posLock, 'pair posting');
    }
    const sync = await syncLiveQuotes(state, market, prepared, {
      paired: snapPlan.mode === 'pair',
    });
    results.push(...(sync.posted || []));

    // C3: pair legs — match first (sync already polls), then hedge missing side
    if (snapPlan.mode === 'pair') {
      const hedge = await enforcePairHedge(
        state,
        market,
        prepared.map((p) => p.side)
      );
      const posAfter = state.positions[market.conditionId];
      if (hedge.unwindFailed) {
        if (posAfter) setPairInflight(posAfter, 'unwind pending');
        saveState(state);
        return {
          executed: false,
          reason: `pair hedge failed: ${hedge.reason}`,
          mode: 'live',
          plan: snapPlan,
          hedge,
        };
      }
      if (hedge.hedged) {
        if (posAfter) clearPairInflight(posAfter);
        saveState(state);
        return {
          executed: false,
          reason: `pair hedge: ${hedge.reason}`,
          mode: 'live',
          plan: snapPlan,
          hedge,
        };
      }
      // Maker rests posted — keep inflight until both legs fill or audit clears
      if (posAfter && results.some((r) => r && r.ok)) {
        setPairInflight(posAfter, 'await hedge rest');
      } else if (posAfter) {
        clearPairInflight(posAfter);
      }
    }

    saveState(state);
    return {
      executed: results.some((r) => r && r.ok),
      results,
      mode: 'live',
      posted: true,
      plan: snapPlan,
    };
  }

  // --- PAPER realistic CLOB ---
  if (realistic) {
    for (const prep of prepared) prep.paired = snapPlan.mode === 'pair';

    if (qMode === 'taker') {
      for (const prep of prepared) {
        const taken = takeAskNow(state, prep, market, params);
        if (taken.filled > 0 && taken.result) results.push(taken.result);
        if (taken.remaining > 1e-9) {
          const posted = postPaperBuy(state, {
            market,
            side: prep.side,
            tokenId: prep.tokenId,
            shares: taken.remaining,
            limitPrice: prep.limit,
            quoteMode: 'maker',
            paired: prep.paired,
            plannedPrice: prep.planned,
            marketAsk: prep.marketAsk,
            marketBid: prep.marketBid,
            bidSizeAtJoin: prep.bidSize,
          });
          if (posted.ok) {
            state.stats.orders_posted = (Number(state.stats.orders_posted) || 0) + 1;
            addLog(
              state,
              `[纸上挂单] BUY ${prep.side} ${taken.remaining} @ $${prep.limit}` +
                ` (GTC maker rest; queueAhead=${posted.order.queueAhead}; id=${posted.order.id.slice(-6)})`,
              'info'
            );
            results.push({ ok: true, posted: posted.order });
          } else {
            addLog(state, `[纸上挂单失败] ${prep.side}: ${posted.reason}`, 'warning');
            state.stats.skipped += 1;
          }
        }
      }
    } else {
      // H2: maker sync keeps same side+limit rests
      const sync = syncPaperQuotes(state, market, prepared, {
        paired: snapPlan.mode === 'pair',
        bidSum: snapPlan.bidSum,
      });
      results.push(...sync.results);
      if (!sync.results.length && !sync.cancelled) {
        saveState(state);
        return {
          executed: false,
          reason: 'already resting',
          resting: ordersForMarket(state, market.conditionId),
          plan: snapPlan,
        };
      }
    }

    if (snapPlan.mode === 'pair') {
      await auditPaperPairExposure(state, market);
    }

    saveState(state);
    return {
      executed: results.length > 0,
      results,
      mode: 'paper',
      plan: snapPlan,
    };
  }

  // --- PAPER legacy instant fill ---
  for (const prep of prepared) {
    const r = applyBuy(state, market, prep.side, prep.shares, prep.fillPrice, {
      live: false,
      paired: snapPlan.mode === 'pair',
      plannedPrice: prep.planned,
      limitPrice: prep.limit,
      marketAsk: prep.marketAsk,
      quoteMode: qMode,
      feeRate: feeRateFor(params, qMode),
      liquidity: qMode,
    });
    if (!r.ok) {
      addLog(state, `[纸上跳过] ${r.reason}`, 'warning');
      state.stats.skipped += 1;
    } else {
      addLog(
        state,
        `[纸上成交] BUY ${prep.side} ${prep.shares} @ $${prep.fillPrice}` +
          ` (fee $${r.fee}; ${qMode}; instant; pairSum=${Number(snapPlan.pairSum).toFixed(3)})`,
        'success'
      );
      results.push(r);
    }
  }

  if (snapPlan.mode === 'pair') {
    await auditPaperPairExposure(state, market);
  }

  saveState(state);
  return {
    executed: results.length > 0,
    results,
    mode: 'paper',
    plan: snapPlan,
  };
}

module.exports = {
  executePlan,
  getClobClient,
  placeLiveBuy,
  placeLiveTakerBuy,
  prepareBuyLegFromQuotes,
};
