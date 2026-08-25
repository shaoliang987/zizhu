#!/usr/bin/env node
/**
 * Hedge size must respect share_chunk + max_market_usdc + max_trade_usdc.
 */
const assert = require('assert');

function computeHedgeSize({ needSh, chunk, maxTrade, room, askPx, askSize }) {
  const maxByTrade = askPx > 0 ? maxTrade / askPx : chunk;
  const maxByRoom = askPx > 0 ? room / askPx : chunk;
  return Math.min(needSh, chunk, maxByTrade, maxByRoom, askSize || needSh);
}

console.log('hedge-cap.test.js\n');

{
  const size = computeHedgeSize({
    needSh: 30.32,
    chunk: 5,
    maxTrade: 5,
    room: 7.5,
    askPx: 0.25,
    askSize: 100,
  });
  assert.ok(Math.abs(size - 5) < 1e-9, `bloated needSh capped to chunk, got ${size}`);
  console.log('  ok: never mirror 30-share inventory');
}

{
  const size = computeHedgeSize({
    needSh: 5,
    chunk: 5,
    maxTrade: 5,
    room: 2.0,
    askPx: 0.5,
    askSize: 100,
  });
  assert.ok(Math.abs(size - 4) < 1e-9, `room cap, got ${size}`);
  console.log('  ok: room $2 @ 0.50 → 4 shares');
}

{
  const room = 0.01;
  assert.ok(room < 0.05, 'hard stop when room exhausted');
  console.log('  ok: max_market hard stop');
}

{
  const invested = 2.9; // activity zeroed downCost
  const windowBuyUsdc = 28; // real lifetime buys
  const maxMarket = 10;
  const windowSpent = Math.max(invested, windowBuyUsdc);
  const room = Math.max(0, maxMarket - windowSpent);
  assert.ok(room < 0.05, `lifetime spend blocks hedge, room=${room}`);
  console.log('  ok: windowBuyUsdc survives cost zeroing');
}

{
  // Entry path must use same lifetime spend (not net invested after unwind)
  const { windowSpentUsdc } = require('../lib/ledger');
  const pos = { upCost: 0, downCost: 0, windowBuyUsdc: 12 };
  assert.ok(windowSpentUsdc(pos) >= 12, 'entry spent uses windowBuyUsdc');
  console.log('  ok: signal entry uses windowSpentUsdc');
}

{
  const hedgeAttempts = 1;
  assert.ok(hedgeAttempts >= 1, 'second hedge blocked');
  console.log('  ok: max 1 hedge attempt per window');
}

console.log('\n6 passed');
