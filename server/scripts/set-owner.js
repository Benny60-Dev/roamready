// Grant or revoke admin (isOwner) on a single User by email.
//
//   node server/scripts/set-owner.js <email> <true|false>
//   e.g. node server/scripts/set-owner.js momann@gmail.com true
//
// Connects exactly like list-users.js: a pg Client using DATABASE_URL loaded
// from the ROOT .env. To target prod, override DATABASE_URL at run time, e.g.
//   DATABASE_URL="postgres://...prod..." node server/scripts/set-owner.js you@x.com true
//
// SSL: for prod / Render's EXTERNAL Postgres, ALSO set PGSSL=true — Render
// resets non-SSL connections (ECONNRESET). PGSSL=true (or "require") connects
// with ssl { rejectUnauthorized: false } (still encrypted; Render's cert chain
// isn't in the default trust store). Unset PGSSL → no ssl option, so local dev
// connections are unchanged. e.g.
//   DATABASE_URL="...render external..." PGSSL=true node server/scripts/set-owner.js you@x.com true
//
// Safety: case-insensitive email match (signup does not normalize case), one
// email per run (no bulk update), aborts if zero or >1 rows match, and prints
// the before/after value + affected row count so the operator sees exactly
// what changed. NOTE: isOwner is privileged — it bypasses every feature gate,
// email verification, and AI usage limits — so double-check the DB and email.
process.env.TZ = 'UTC';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Client } = require('pg');

const USAGE = `Usage: node server/scripts/set-owner.js <email> <true|false>
  <email>        the account's email (matched case-insensitively)
  <true|false>   true to grant admin (isOwner), false to revoke

Example:
  node server/scripts/set-owner.js momann@gmail.com true`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

(async () => {
  // 1. Validate args BEFORE connecting to anything.
  const email = process.argv[2];
  const flagRaw = process.argv[3];

  if (!email || !flagRaw) {
    fail(`Error: missing argument(s).\n\n${USAGE}`);
  }

  const flag = String(flagRaw).toLowerCase();
  if (flag !== 'true' && flag !== 'false') {
    fail(`Error: second argument must be exactly "true" or "false" (got "${flagRaw}").\n\n${USAGE}`);
  }
  const newValue = flag === 'true';

  // Best-effort: show WHICH database we're about to touch (host only, no
  // credentials) so dev vs prod is obvious before any write happens.
  if (!process.env.DATABASE_URL) {
    fail('Error: DATABASE_URL is not set in the environment / root .env.');
  }
  let dbLabel = '(unparseable DATABASE_URL host)';
  try {
    const u = new URL(process.env.DATABASE_URL);
    dbLabel = `${u.host}${u.pathname}`;
  } catch (_) {
    /* leave the fallback label */
  }
  console.log(`Database: ${dbLabel}`);
  console.log(`Request : set isOwner = ${newValue} for "${email}" (case-insensitive match)\n`);

  // Opt-in SSL for Render's external Postgres (PGSSL=true|require). Off by
  // default so local dev connects exactly as before. rejectUnauthorized:false
  // keeps the connection encrypted while accepting Render's non-default cert.
  const pgssl = String(process.env.PGSSL || '').toLowerCase();
  const useSsl = pgssl === 'true' || pgssl === 'require';
  if (useSsl) console.log('SSL     : enabled (rejectUnauthorized: false)');

  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  await c.connect();
  try {
    // 2. Case-insensitive lookup. Select all matches so we can refuse to act
    //    if more than one row somehow matches (different-cased duplicates).
    const found = await c.query(
      'SELECT id, email, "isOwner" FROM "User" WHERE lower(email) = lower($1)',
      [email],
    );

    // 3. No user → report and exit WITHOUT changing anything.
    if (found.rowCount === 0) {
      console.log(`No user found for ${email}`);
      return;
    }

    // Safety: never guess which row to update if the match isn't unique.
    if (found.rowCount > 1) {
      console.error(
        `Refusing to update: ${found.rowCount} users match ${email} (case-insensitive):`,
      );
      console.table(found.rows.map(r => ({ email: r.email, isOwner: r.isOwner })));
      process.exit(1);
    }

    // 4. Show the current state first.
    const before = found.rows[0];
    console.log(`Found   : ${before.email} (current isOwner = ${before.isOwner})`);

    // No-op guard: if it's already at the requested value, say so and skip the
    // write. Keeps the "rows changed" count honest.
    if (before.isOwner === newValue) {
      console.log(`No change: ${before.email} already has isOwner = ${newValue}. Nothing to do.`);
      return;
    }

    // 5. Update exactly this one user (by unique id, so the row count is
    //    unambiguous). RETURNING gives us the new value + row count.
    const updated = await c.query(
      'UPDATE "User" SET "isOwner" = $1 WHERE id = $2 RETURNING email, "isOwner"',
      [newValue, before.id],
    );

    // 6. Confirm exactly what changed.
    const after = updated.rows[0];
    console.log(`Updated : ${after.email}: isOwner ${before.isOwner} -> ${after.isOwner}`);
    console.log(`Rows changed: ${updated.rowCount}`);

    if (updated.rowCount !== 1) {
      // Should be impossible (updating by primary key), but never report
      // success on an unexpected row count.
      fail(`Error: expected exactly 1 row changed, got ${updated.rowCount}.`);
    }
  } finally {
    await c.end();
  }
})().catch(err => {
  console.error('set-owner failed:', err.message || err);
  process.exit(1);
});
