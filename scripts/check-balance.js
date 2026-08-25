require('dotenv').config();
process.env.DRY_RUN = 'false';

const { fetchAccountEquityUsdc } = require('../lib/account');

(async () => {
  try {
    const account = await fetchAccountEquityUsdc({ force: true });
    console.log(JSON.stringify({
      ok: true,
      clob_usdc: account.cash_usdc,
      positions_usdc: account.positions_value_usdc,
      equity_usdc: account.equity_usdc,
      funder: process.env.POLYMARKET_FUNDER_ADDRESS,
      signature_type: process.env.POLYMARKET_SIGNATURE_TYPE,
    }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
})();
