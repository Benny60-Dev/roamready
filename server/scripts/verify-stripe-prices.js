// Verify the four Stripe price IDs against the prices the app displays.
//
//   node server/scripts/verify-stripe-prices.js
//
// READ-ONLY: the only Stripe call is prices.retrieve — nothing is created,
// updated, or deleted. Loads env from the ROOT .env exactly like
// set-owner.js. Uses STRIPE_SECRET_KEY; prints whether that key is a TEST
// or LIVE key so it's obvious which mode is being checked.
//
// Each price slot has TWO env vars — the server-side *_PRICE_ID name used
// by createCheckout's guards, and the VITE_* name baked into the client
// bundle. The script reads both, flags a FAIL if they disagree (client
// would charge a different price than the server expects), and verifies
// the resolved ID against the expected amount/interval:
//   regular monthly $8.99/mo   regular annual $89.99/yr
//   founder monthly $7.99/mo   founder annual $69.99/yr
// (Displayed prices are hardcoded in PricingPage.tsx / PaywallModal.tsx —
// this script proves Stripe will actually charge those numbers.)
process.env.TZ = 'UTC';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const Stripe = require('stripe');

// Expected amounts in cents, matching the client display constants.
const SLOTS = [
  { label: 'Regular monthly', serverVar: 'STRIPE_PRO_MONTHLY_PRICE_ID',         viteVar: 'VITE_STRIPE_PRO_MONTHLY',         cents: 899,  interval: 'month' },
  { label: 'Regular annual',  serverVar: 'STRIPE_PRO_ANNUAL_PRICE_ID',          viteVar: 'VITE_STRIPE_PRO_ANNUAL',          cents: 8999, interval: 'year'  },
  { label: 'Founder monthly', serverVar: 'STRIPE_PRO_FOUNDER_MONTHLY_PRICE_ID', viteVar: 'VITE_STRIPE_PRO_FOUNDER_MONTHLY', cents: 799,  interval: 'month' },
  { label: 'Founder annual',  serverVar: 'STRIPE_PRO_FOUNDER_ANNUAL_PRICE_ID',  viteVar: 'VITE_STRIPE_PRO_FOUNDER_ANNUAL',  cents: 6999, interval: 'year'  },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function dollars(cents) {
  return cents == null ? '(n/a)' : `$${(cents / 100).toFixed(2)}`;
}

(async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) fail('Error: STRIPE_SECRET_KEY is not set in the environment / root .env.');

  const mode = key.startsWith('sk_test_') ? 'TEST'
    : key.startsWith('sk_live_') ? 'LIVE'
    : key.startsWith('rk_') ? 'RESTRICTED'
    : 'UNRECOGNIZED PREFIX';
  console.log(`Stripe key mode: ${mode}\n`);

  const stripe = new Stripe(key);

  const rows = [];
  const verdicts = [];

  for (const slot of SLOTS) {
    const serverId = process.env[slot.serverVar];
    const viteId = process.env[slot.viteVar];
    const problems = [];

    if (!serverId && !viteId) {
      verdicts.push({ slot, pass: false, detail: `missing env vars: neither ${slot.serverVar} nor ${slot.viteVar} is set` });
      continue;
    }
    if (!serverId) problems.push(`${slot.serverVar} is not set (server checkout guard can't recognize this price)`);
    if (!viteId) problems.push(`${slot.viteVar} is not set (client can't start this checkout)`);
    if (serverId && viteId && serverId !== viteId) {
      problems.push(`MISMATCH: ${slot.serverVar} and ${slot.viteVar} hold different price IDs — client and server disagree`);
    }

    const id = serverId || viteId;
    let price;
    try {
      price = await stripe.prices.retrieve(id, { expand: ['product'] });
    } catch (err) {
      const detail = err && err.code === 'resource_missing'
        ? `No such price in ${mode} mode — likely a test/live mode mismatch between STRIPE_SECRET_KEY and this price ID`
        : (err && err.message) || String(err);
      verdicts.push({ slot, pass: false, detail: `${id}: ${detail}` });
      continue;
    }

    const amount = price.unit_amount;
    const interval = price.recurring ? price.recurring.interval : '(one-time)';
    const productName = price.product && typeof price.product === 'object'
      ? (price.product.name || price.product.id)
      : String(price.product);

    rows.push({
      label: slot.label,
      'env var': serverId ? slot.serverVar : slot.viteVar,
      'price ID': id,
      amount: dollars(amount),
      currency: price.currency,
      interval,
      active: price.active,
      product: productName,
    });

    if (amount !== slot.cents) problems.push(`amount is ${dollars(amount)}, expected ${dollars(slot.cents)}`);
    if (price.currency !== 'usd') problems.push(`currency is ${price.currency}, expected usd`);
    if (interval !== slot.interval) problems.push(`interval is ${interval}, expected ${slot.interval}`);
    if (!price.active) problems.push('price is INACTIVE in Stripe');

    verdicts.push({ slot, pass: problems.length === 0, detail: problems.join('; ') });
  }

  if (rows.length > 0) console.table(rows);

  console.log('');
  let allPass = true;
  for (const v of verdicts) {
    const expected = `${dollars(v.slot.cents)}/${v.slot.interval === 'month' ? 'mo' : 'yr'}`;
    if (v.pass) {
      console.log(`PASS  ${v.slot.label.padEnd(16)} matches expected ${expected}`);
    } else {
      allPass = false;
      console.log(`FAIL  ${v.slot.label.padEnd(16)} expected ${expected} — ${v.detail}`);
    }
  }

  console.log('');
  if (allPass) {
    console.log(`VERDICT: ALL 4 PRICES MATCH the displayed rates (${mode} mode).`);
  } else {
    console.log(`VERDICT: PRICE VERIFICATION FAILED (${mode} mode) — see FAIL lines above.`);
    process.exit(1);
  }
})().catch(err => {
  console.error('verify-stripe-prices failed:', (err && err.message) || err);
  process.exit(1);
});
