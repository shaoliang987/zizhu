require('dotenv').config();
process.env.DRY_RUN = 'false';
const { fetchAccountCashUsdc } = require('./lib/account');
(async () => {
 try {
 const bal = await fetchAccountCashUsdc({ force: true });
 console.log(JSON.stringify({ ok: true, clob_usdc: bal, funder: process.env.POLYMARKET_FUNDER_ADDRESS }));
 } catch (e) {
 console.log(JSON.stringify({ ok: false, error: e.message }));
 }
})();
