// Test helper: shifts a user's `createdAt` backward by 2 hours so the
// 1-hour verification grace window is in the past. Used to manually
// simulate an "over-grace" unverified user during Phase 3 testing
// without waiting an hour.
//
// USAGE:
//   node scripts/expire-grace-period.js <email>
//
// EXAMPLE:
//   node scripts/expire-grace-period.js phase2-test@roamready.ai
//
// Safety:
//   - Bails if no email argument is provided.
//   - Bails if no user matches that email (no rows updated).
//   - Prints before/after createdAt timestamps + the computed grace
//     end so you can verify the shift took effect.
//   - Touches ONLY the named user. No bulk updates.
//
// This script does not require Prisma — uses the same pg-via-node
// pattern that worked in Phase 1 testing (avoids the Prisma client
// regen problem). Run from server/ directory.
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })
const { Client } = require('pg')

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const ONE_HOUR_MS  = 1 * 60 * 60 * 1000

const email = process.argv[2]
if (!email) {
  console.error('Usage: node scripts/expire-grace-period.js <email>')
  process.exit(1)
}

;(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try {
    // Look up the user first — we want to confirm they exist + show the
    // before timestamp before mutating anything.
    const before = await c.query(
      `SELECT id, email, "createdAt", "emailVerified" FROM "User" WHERE email = $1`,
      [email],
    )
    if (before.rows.length === 0) {
      console.error(`No user found with email = ${email}`)
      process.exit(1)
    }
    const u = before.rows[0]
    console.log('User found:')
    console.log(`  id:            ${u.id}`)
    console.log(`  email:         ${u.email}`)
    console.log(`  emailVerified: ${u.emailVerified}`)
    console.log(`  createdAt:     ${u.createdAt.toISOString()} (before)`)
    console.log()

    // Shift createdAt backward by 2 hours from now (NOT from the
    // original createdAt — using `now - 2h` makes the grace expire at
    // `now - 1h`, regardless of how old the account actually was).
    const newCreatedAt = new Date(Date.now() - TWO_HOURS_MS)
    await c.query(
      `UPDATE "User" SET "createdAt" = $1 WHERE id = $2`,
      [newCreatedAt, u.id],
    )

    const graceEndsAt = new Date(newCreatedAt.getTime() + ONE_HOUR_MS)
    console.log('Shift complete:')
    console.log(`  createdAt:     ${newCreatedAt.toISOString()} (after)`)
    console.log(`  graceEndsAt:   ${graceEndsAt.toISOString()} (1h after createdAt)`)
    console.log(`  now:           ${new Date().toISOString()}`)
    console.log(`  → grace ended ${Math.round((Date.now() - graceEndsAt.getTime()) / 60000)} minutes ago`)
    console.log()
    console.log('The next gated-route request from this user should 403 EMAIL_VERIFICATION_REQUIRED.')
  } finally {
    await c.end()
  }
})().catch(e => { console.error(e.message); process.exit(1) })
