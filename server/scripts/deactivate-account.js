// Reversible account deactivation (Tier 1 account removal). Sets/clears
// User.deactivatedAt so the account can no longer authenticate (login, Google
// OAuth, and JWT refresh all reject a deactivated user) and drops out of the
// admin active lists/counts. Fully reversible. This does NOT scrub any personal
// data and does NOT cancel Stripe billing — a deactivated PRO user keeps being
// charged until their subscription is cancelled separately (that is Tier 2).
//
// USAGE:
//   cd server
//   node scripts/deactivate-account.js deactivate <email> [reason] [--dry-run]
//   node scripts/deactivate-account.js reactivate <email>          [--dry-run]
//
// Examples:
//   node scripts/deactivate-account.js deactivate cindy@roamready.ai "abuse report #42"
//   node scripts/deactivate-account.js reactivate cindy@roamready.ai
//   node scripts/deactivate-account.js deactivate cindy@roamready.ai --dry-run
//
// Connection: Prisma client, DATABASE_URL loaded from the ROOT .env (matches
// cleanup-test-users.js). To target prod, override DATABASE_URL at run time and
// ALSO set PGSSL=true for Render's external Postgres (appends sslmode=require so
// the connection is encrypted; Render resets non-SSL connections):
//   DATABASE_URL="postgres://...render external..." PGSSL=true \
//     node scripts/deactivate-account.js deactivate you@x.com "reason"
//
// Safety (mirrors set-owner.js + cleanup-test-users.js):
//   - case-insensitive email match, ONE account per run, aborts on 0 or >1 match
//   - prints the DB host label + a before-row before acting
//   - LOUD warning if the target has an active subscription (billing NOT stopped)
//   - requires typed confirmation (DEACTIVATE / REACTIVATE, exact)
//   - --dry-run does the lookup + prints the plan/warning but writes nothing
//   - on success writes an AdminActionLog row and re-reads to verify the change
//
// NOTE: run this AFTER `npx prisma generate` has picked up the
// add_account_deactivation migration — a stale client won't know deactivatedAt
// or the AdminActionLog model and the writes below will fail.
process.env.TZ = 'UTC'

const path = require('path')
const readline = require('readline')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { PrismaClient } = require('@prisma/client')

const USAGE = `Usage:
  node scripts/deactivate-account.js deactivate <email> [reason] [--dry-run]
  node scripts/deactivate-account.js reactivate <email>          [--dry-run]

  <email>     the account's email (matched case-insensitively)
  [reason]    optional free-text reason (deactivate only) recorded in the audit log
  --dry-run   look up + print the plan + warnings, but make NO writes`

function fail(message) {
  console.error(message)
  process.exit(1)
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans) }))
}

;(async () => {
  // --- Parse args BEFORE connecting to anything --------------------------
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const positional = argv.filter(a => a !== '--dry-run')
  const mode = String(positional[0] || '').toLowerCase()
  const email = positional[1]
  const reason = positional[2] || null

  if (mode !== 'deactivate' && mode !== 'reactivate') {
    fail(`Error: first argument must be "deactivate" or "reactivate" (got "${positional[0] || ''}").\n\n${USAGE}`)
  }
  if (!email) {
    fail(`Error: missing <email>.\n\n${USAGE}`)
  }
  if (mode === 'reactivate' && reason) {
    fail('Error: reactivate does not take a reason argument.\n\n' + USAGE)
  }

  if (!process.env.DATABASE_URL) {
    fail('Error: DATABASE_URL is not set in the environment / root .env.')
  }

  // Opt-in SSL for Render's external Postgres (PGSSL=true|require). Prisma
  // honors SSL via the connection string, so we append sslmode=require rather
  // than passing a pg ssl object. Off by default → local dev unchanged.
  let dbUrl = process.env.DATABASE_URL
  const pgssl = String(process.env.PGSSL || '').toLowerCase()
  const useSsl = pgssl === 'true' || pgssl === 'require'
  if (useSsl && !/sslmode=/.test(dbUrl)) {
    dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'sslmode=require'
  }

  // Best-effort: show WHICH database we're about to touch (host only, no creds).
  let dbLabel = '(unparseable DATABASE_URL host)'
  try {
    const u = new URL(process.env.DATABASE_URL)
    dbLabel = `${u.host}${u.pathname}`
  } catch (_) { /* keep fallback */ }

  console.log(`\nDatabase: ${dbLabel}`)
  if (useSsl) console.log('SSL     : enabled (sslmode=require)')
  console.log(`Request : ${mode.toUpperCase()} "${email}" (case-insensitive match)${dryRun ? '  [DRY RUN]' : ''}\n`)

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  try {
    // --- Case-insensitive lookup; refuse if not unique -------------------
    const matches = await prisma.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: {
        id: true,
        email: true,
        subscriptionTier: true,
        subscriptionId: true,
        deactivatedAt: true,
        deactivatedReason: true,
      },
    })

    if (matches.length === 0) {
      console.log(`No user found for ${email}`)
      return
    }
    if (matches.length > 1) {
      console.error(`Refusing to act: ${matches.length} users match ${email} (case-insensitive):`)
      console.table(matches.map(m => ({ id: m.id, email: m.email, deactivatedAt: m.deactivatedAt })))
      process.exit(1)
    }

    const user = matches[0]
    const isDeactivated = !!user.deactivatedAt
    const hasActiveSub = !!user.subscriptionId && user.subscriptionTier !== 'FREE'

    // --- Before-row -------------------------------------------------------
    console.log('Target account:')
    console.table([{
      id: user.id,
      email: user.email,
      tier: user.subscriptionTier,
      subscriptionId: user.subscriptionId,
      deactivatedAt: user.deactivatedAt ? user.deactivatedAt.toISOString() : null,
    }])

    // --- No-op guards -----------------------------------------------------
    if (mode === 'deactivate' && isDeactivated) {
      console.log(`\nAlready deactivated (since ${user.deactivatedAt.toISOString()}). Nothing to do.`)
      return
    }
    if (mode === 'reactivate' && !isDeactivated) {
      console.log('\nAccount is already active. Nothing to do.')
      return
    }

    // --- Active-subscription warning (deactivate only) --------------------
    if (mode === 'deactivate' && hasActiveSub) {
      console.log('\n' + '!'.repeat(72))
      console.log('!! WARNING: this account has an ACTIVE SUBSCRIPTION')
      console.log(`!!   tier=${user.subscriptionTier}  subscriptionId=${user.subscriptionId}`)
      console.log('!! Deactivating does NOT stop Stripe billing. The customer will keep')
      console.log('!! being charged until the subscription is cancelled SEPARATELY in')
      console.log('!! Stripe / the billing flow. Deactivate is auth-only (Tier 1).')
      console.log('!'.repeat(72))
    }

    // --- Plan -------------------------------------------------------------
    if (mode === 'deactivate') {
      console.log(`\nPlan: set deactivatedAt = now, deactivatedReason = ${reason ? JSON.stringify(reason) : '(none)'}`)
    } else {
      console.log('\nPlan: clear deactivatedAt + deactivatedReason (reactivate)')
    }

    if (dryRun) {
      console.log('\n[dry-run] No writes made.')
      return
    }

    // --- Typed confirmation ----------------------------------------------
    const expected = mode.toUpperCase() // DEACTIVATE | REACTIVATE
    console.log(`\nType ${expected} (uppercase, exact) to proceed, anything else to abort.`)
    const answer = (await prompt('> ')).trim()
    if (answer !== expected) {
      console.log('Aborted, no changes made.')
      return
    }

    // --- Apply: user update + audit log in one transaction ---------------
    const data = mode === 'deactivate'
      ? { deactivatedAt: new Date(), deactivatedReason: reason }
      : { deactivatedAt: null, deactivatedReason: null }

    const [updated, log] = await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data }),
      prisma.adminActionLog.create({
        data: {
          action: expected, // DEACTIVATE | REACTIVATE
          targetUserId: user.id,
          performedBy: 'script:deactivate-account',
          reason,
          metadata: {
            hadActiveSubscription: hasActiveSub,
            subscriptionTier: user.subscriptionTier,
            subscriptionId: user.subscriptionId,
            previousDeactivatedAt: user.deactivatedAt ? user.deactivatedAt.toISOString() : null,
          },
        },
      }),
    ])

    // --- Verify the write actually took -----------------------------------
    const expectDeactivated = mode === 'deactivate'
    const nowDeactivated = !!updated.deactivatedAt
    if (nowDeactivated !== expectDeactivated) {
      fail(`Error: post-update state mismatch — expected deactivated=${expectDeactivated}, got ${nowDeactivated}.`)
    }

    console.log(`\n✓ ${expected} applied to ${updated.email}`)
    console.log(`  deactivatedAt: ${updated.deactivatedAt ? updated.deactivatedAt.toISOString() : null}`)
    console.log(`  audit log id : ${log.id} (performedBy=${log.performedBy})`)
    if (mode === 'deactivate' && hasActiveSub) {
      console.log('  REMINDER: Stripe billing is still active — cancel it separately.')
    }
  } finally {
    await prisma.$disconnect()
  }
})().catch(async err => {
  console.error('deactivate-account failed:', err.message || err)
  process.exit(1)
})
