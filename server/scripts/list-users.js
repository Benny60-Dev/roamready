process.env.TZ = 'UTC';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query(`
    SELECT
      email,
      "firstName",
      "lastName",
      "subscriptionTier",
      "emailVerified",
      "isOwner",
      "founderPricing",
      "createdAt",
      "trialEndsAt"
    FROM "User"
    ORDER BY "createdAt" DESC
  `);
  console.log('Total users:', r.rowCount);
  console.table(r.rows);
  await c.end();
})();