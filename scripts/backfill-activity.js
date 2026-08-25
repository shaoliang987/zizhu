#!/usr/bin/env node
/**
 * Backfill live ledger from Polymarket /activity (buys, sells, redeems).
 *
 * Usage:
 *   STATE_DIR=./data/live DRY_RUN=false node scripts/backfill-activity.js
 *   STATE_DIR=./data/live DRY_RUN=false node scripts/backfill-activity.js --dry-run
 */
require('dotenv').config();

const { backfillFromActivity } = require('../lib/activity_backfill');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const report = await backfillFromActivity({ dryRun, rewriteTrades: true });
  console.log(JSON.stringify(report, null, 2));
  if (Math.abs(Number(report.residual) || 0) > 1) {
    console.error(`warning: residual $${report.residual} still large`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
