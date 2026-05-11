// Test-user cleanup script. Interactive: prints a before-table,
// computes a keep/delete plan, requires the operator to type DELETE
// (exact, case-sensitive), then deletes in a per-row try/catch loop
// and flips emailVerified=true on the keep accounts.
//
// USAGE:
//   cd server
//   node scripts/cleanup-test-users.js
//
// Pipe an answer to dry-run the abort path:
//   echo "abort" | node scripts/cleanup-test-users.js
//
// Uses Prisma (NOT raw pg) so the onDelete: Cascade rules on the User
// model fire — Rig, TravelProfile, Notification, Membership, Trip,
// TravelParty, PlanningSession, AIUsageLog all cascade per the schema.
// Feedback is nullable userId with SetNull behavior, so feedback rows
// authored by deleted users survive but get their author cleared.
//
// TIMEZONE: process.env.TZ = 'UTC' matches the discipline established
// by expire-grace-period.js — keeps Date.now() / .toISOString() output
// aligned with what Prisma reads from `timestamp without time zone`
// columns.
process.env.TZ = 'UTC'

const path = require('path')
const readline = require('readline')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

// Hardcoded keep list. Case-insensitive match against stored emails
// (existing rows include 'Cindy@roamready.ai' with a capital C — the
// .toLowerCase() comparison below catches that). Update this list
// when the test-account roster changes.
const KEEP_EMAILS = [
  'momann@gmail.com',
  'momannexpired@gmail.com',
  'Cindy@roamready.ai',
  'bmolini@yahoo.com',
]
const KEEP_LOWER = new Set(KEEP_EMAILS.map(e => e.toLowerCase()))

// Small projection — never log password hashes or verification tokens.
const SAFE_SELECT = {
  id: true,
  email: true,
  firstName: true,
  isOwner: true,
  emailVerified: true,
  createdAt: true,
}

/** Format a row for console.table — strip Date objects to ISO strings
 *  for readable printing, drop the id (not useful at a glance). */
function formatForTable(rows) {
  return rows.map(r => ({
    email: r.email,
    firstName: r.firstName,
    isOwner: r.isOwner,
    emailVerified: r.emailVerified,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
  }))
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise(resolve => rl.question(question, resolve))
  } finally {
    rl.close()
  }
}

;(async () => {
  // --- (a) Print current state ----------------------------------------
  let users
  try {
    users = await prisma.user.findMany({
      select: SAFE_SELECT,
      orderBy: { createdAt: 'asc' },
    })
  } catch (err) {
    console.error('Failed to connect to the database or read users:', err.message)
    process.exit(1)
  }

  console.log(`\nCurrent user count: ${users.length}\n`)
  console.table(formatForTable(users))

  // --- (b) Compute + print the plan -----------------------------------
  const toKeep = users.filter(u => KEEP_LOWER.has(u.email.toLowerCase()))
  const toDelete = users.filter(u => !KEEP_LOWER.has(u.email.toLowerCase()))

  console.log(`\nWill KEEP these ${toKeep.length} users:`)
  for (const u of toKeep) console.log(`  - ${u.email}`)

  console.log(`\nWill DELETE these ${toDelete.length} users:`)
  for (const u of toDelete) console.log(`  - ${u.email}`)

  // Warn if any KEEP_EMAILS entry has no matching row — likely a typo
  // in the hardcoded list, but also possible the account was deleted
  // by a previous cleanup run. Don't crash; the flip step skips
  // missing accounts anyway.
  const seenLower = new Set(users.map(u => u.email.toLowerCase()))
  for (const keep of KEEP_EMAILS) {
    if (!seenLower.has(keep.toLowerCase())) {
      console.warn(`  ⚠ KEEP email ${keep} not found in DB — will skip flip later`)
    }
  }

  if (toDelete.length === 0) {
    console.log('\nNothing to delete. Exiting.')
    await prisma.$disconnect()
    return
  }

  // --- (c) Require typed DELETE ---------------------------------------
  console.log('\nType DELETE (uppercase, exact) to proceed, anything else to abort.')
  const answer = (await prompt('> ')).trim()
  if (answer !== 'DELETE') {
    console.log('Aborted, no changes made.')
    await prisma.$disconnect()
    return
  }

  // --- (d) Delete per-row with try/catch ------------------------------
  console.log(`\nDeleting ${toDelete.length} users (cascade fires via Prisma onDelete rules)...\n`)
  const failures = []
  for (const u of toDelete) {
    try {
      await prisma.user.delete({ where: { id: u.id } })
      console.log(`  ✓ deleted ${u.email}`)
    } catch (err) {
      failures.push({ email: u.email, message: err.message })
      console.error(`  ✗ FAILED to delete ${u.email}: ${err.message}`)
    }
  }

  // --- (e) Flip emailVerified=true on the keep accounts ---------------
  console.log(`\nFlipping emailVerified=true on ${KEEP_EMAILS.length} keep accounts...\n`)
  for (const keepEmail of KEEP_EMAILS) {
    // Match case-insensitively against the stored email — re-query by
    // lowercase comparison to find the actual row. We use updateMany
    // (rather than findFirst + update) for the same case-insensitive
    // tolerance via the `mode: 'insensitive'` filter on Postgres.
    try {
      const result = await prisma.user.updateMany({
        where: { email: { equals: keepEmail, mode: 'insensitive' } },
        data: { emailVerified: true },
      })
      if (result.count > 0) {
        console.log(`  ✓ Flipped emailVerified=true on: ${keepEmail} (${result.count} row${result.count !== 1 ? 's' : ''})`)
      } else {
        console.warn(`  ⚠ KEEP email ${keepEmail} not found in DB — skipping flip`)
      }
    } catch (err) {
      console.error(`  ✗ FAILED to flip ${keepEmail}: ${err.message}`)
    }
  }

  // --- (f) Print final state ------------------------------------------
  console.log('\nFinal user table:\n')
  const after = await prisma.user.findMany({
    select: SAFE_SELECT,
    orderBy: { createdAt: 'asc' },
  })
  console.table(formatForTable(after))

  // Summary
  console.log(`\nSummary: ${toDelete.length - failures.length} deleted, ${failures.length} failed.`)
  if (failures.length > 0) {
    console.log(`Failed emails:`)
    for (const f of failures) console.log(`  - ${f.email}: ${f.message}`)
  }

  await prisma.$disconnect()
})().catch(async err => {
  console.error('Unhandled error:', err.message)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
