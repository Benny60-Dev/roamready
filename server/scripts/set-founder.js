// Grant or revoke founder pricing on a single User by email.
//
//   node server/scripts/set-founder.js <email> --grant
//   node server/scripts/set-founder.js <email> --revoke
//
//   --grant   -> founderPricing = true,  founderRateForfeitedAt = null
//   --revoke  -> founderPricing = false, founderRateForfeitedAt = now
//
// --revoke mirrors what the customer.subscription.deleted webhook does on a
// voluntary cancellation (ToS forfeiture); --grant is the manual undo (e.g.
// goodwill restore, or fixing a wrongly-forfeited account).
//
// Connects exactly like set-owner.js: a pg Client using DATABASE_URL loaded
// from the ROOT .env. To target prod, override DATABASE_URL at run time, e.g.
//   DATABASE_URL="postgres://...prod..." node server/scripts/set-founder.js you@x.com --grant
//
// SSL: for prod / Render's EXTERNAL Postgres, ALSO set PGSSL=true — Render
// resets non-SSL connections (ECONNRESET). PGSSL=true (or "require") connects
// with ssl { rejectUnauthorized: false } (still encrypted; Render's cert chain
// isn't in the default trust store). Unset PGSSL → no ssl option, so local dev
// connections are unchanged. e.g.
//   DATABASE_URL="...render external..." PGSSL=true node server/scripts/set-founder.js you@x.com --revoke
//
// Safety: case-insensitive email match (signup does not normalize case), one
// email per run (no bulk update), aborts if zero or >1 rows match, and prints
// the before/after values + affected row count so the operator sees exactly
// what changed.
process.env.TZ = 'UTC';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Client } = require('pg');

const USAGE = `Usage: node server/scripts/set-founder.js <email> <--grant|--revoke>
  <email>     the account's email (matched case-insensitively)
  --grant     founderPricing = true,  founderRateForfeitedAt = null
  --revoke    founderPricing = false, founderRateForfeitedAt = now

Example:
  node server/scripts/set-founder.js momann@gmail.com --grant`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function fmtForfeited(v) {
  return v == null ? 'null' : new Date(v).toISOString();
}

(async () => {
  // 1. Validate args BEFORE connecting to anything.
  const email = process.argv[2];
  const flag = process.argv[3];

  if (!email || !flag) {
    fail(`Error: missing argument(s).\n\n${USAGE}`);
  }
  if (flag !== '--grant' && flag !== '--revoke') {
    fail(`Error: second argument must be exactly "--grant" or "--revoke" (got "${flag}").\n\n${USAGE}`);
  }
  const grant = flag === '--grant';

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
  console.log(
    `Request : ${grant ? 'GRANT' : 'REVOKE'} founder pricing for "${email}" (case-insensitive match)\n`,
  );

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
      'SELECT id, email, "founderPricing", "founderRateForfeitedAt" FROM "User" WHERE lower(email) = lower($1)',
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
      console.table(found.rows.map(r => ({
        email: r.email,
        founderPricing: r.founderPricing,
        founderRateForfeitedAt: fmtForfeited(r.founderRateForfeitedAt),
      })));
      process.exit(1);
    }

    // 4. Show the current state first.
    const before = found.rows[0];
    console.log(
      `Found   : ${before.email} (founderPricing = ${before.founderPricing}, ` +
      `founderRateForfeitedAt = ${fmtForfeited(before.founderRateForfeitedAt)})`,
    );

    // No-op guard: --grant on an already-granted-and-unforfeited row, or
    // --revoke on an already-revoked row with a forfeit timestamp, changes
    // nothing meaningful — say so and skip the write. (A forfeited-but-
    // still-true or revoked-but-null combination is inconsistent state, so
    // those DO proceed to normalize both columns.)
    const alreadyThere = grant
      ? before.founderPricing === true && before.founderRateForfeitedAt == null
      : before.founderPricing === false && before.founderRateForfeitedAt != null;
    if (alreadyThere) {
      console.log(
        `No change: ${before.email} already has founderPricing = ${before.founderPricing} ` +
        `with founderRateForfeitedAt = ${fmtForfeited(before.founderRateForfeitedAt)}. Nothing to do.`,
      );
      return;
    }

    // 5. Update exactly this one user (by unique id, so the row count is
    //    unambiguous). RETURNING gives us the new values + row count.
    const updated = grant
      ? await c.query(
          'UPDATE "User" SET "founderPricing" = true, "founderRateForfeitedAt" = NULL WHERE id = $1 RETURNING email, "founderPricing", "founderRateForfeitedAt"',
          [before.id],
        )
      : await c.query(
          'UPDATE "User" SET "founderPricing" = false, "founderRateForfeitedAt" = NOW() WHERE id = $1 RETURNING email, "founderPricing", "founderRateForfeitedAt"',
          [before.id],
        );

    // 6. Confirm exactly what changed.
    const after = updated.rows[0];
    console.log(
      `Updated : ${after.email}: founderPricing ${before.founderPricing} -> ${after.founderPricing}, ` +
      `founderRateForfeitedAt ${fmtForfeited(before.founderRateForfeitedAt)} -> ${fmtForfeited(after.founderRateForfeitedAt)}`,
    );
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
  console.error('set-founder failed:', err.message || err);
  process.exit(1);
});
