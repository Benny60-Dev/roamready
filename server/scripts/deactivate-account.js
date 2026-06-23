// Reversible account deactivation (Tier 1 account removal) with optional Stripe
// cancellation. Three shapes:
//
//   SUSPEND  (deactivate, no billing flag): set deactivatedAt; Stripe untouched;
//            reversible. The account can no longer authenticate (login, Google
//            OAuth, JWT refresh all reject) and drops out of admin active lists.
//   CANCEL   (deactivate --cancel-billing): SUSPEND + cancel the Stripe
//            subscription (default at period end; --immediate for now). Optional
//            --refund of the latest charge.
//   REACTIVATE (reactivate): clear deactivatedAt. Does NOT un-cancel Stripe — a
//            cancelled subscription cannot be revived; the user must re-subscribe.
//
// This NEVER scrubs personal data and NEVER writes subscriptionTier/subscriptionId
// itself — the Stripe webhook (controllers/subscriptions.ts) owns the DB
// downgrade. The script only sets deactivatedAt and writes an AdminActionLog row.
//
// USAGE:
//   cd server
//   node scripts/deactivate-account.js deactivate <email> [reason] [--cancel-billing] [--immediate] [--refund] [--dry-run]
//   node scripts/deactivate-account.js reactivate <email> [--dry-run]
//
// Examples:
//   node scripts/deactivate-account.js deactivate cindy@roamready.ai "abuse #42"            # SUSPEND only
//   node scripts/deactivate-account.js deactivate cindy@roamready.ai "chargeback" --cancel-billing
//   node scripts/deactivate-account.js deactivate cindy@roamready.ai "fraud" --cancel-billing --immediate --refund
//   node scripts/deactivate-account.js deactivate cindy@roamready.ai "x" --cancel-billing --dry-run   # shows what would happen, no writes
//   node scripts/deactivate-account.js reactivate cindy@roamready.ai
//
// FLAGS (all default to the safest setting):
//   --cancel-billing  also cancel the Stripe subscription (default: leave billing alone)
//   --immediate       cancel now instead of at period end (only with --cancel-billing; default OFF)
//   --refund          refund the latest charge (only with --cancel-billing; default OFF; extra typed confirm)
//   --dry-run         look up + print the plan/amounts; make NO Stripe and NO DB writes
//
// FOUNDER RATE: admin cancels stamp metadata.admin_cancel='true' on the
// subscription so the webhook's founder-forfeit branch is NOT tripped — an
// admin cancel preserves founderPricing. A real user self-cancel still forfeits.
//
// Connection: Prisma client, DATABASE_URL from the ROOT .env. Stripe client is
// only constructed when --cancel-billing is used (key from STRIPE_SECRET_KEY,
// apiVersion 2024-06-20 — same as services/stripe.ts). For Render external
// Postgres set PGSSL=true (appends sslmode=require).
//
// NOTE: run AFTER `npx prisma generate` has picked up add_account_deactivation —
// a stale client won't know deactivatedAt or AdminActionLog.
process.env.TZ = 'UTC'

const path = require('path')
const readline = require('readline')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { PrismaClient } = require('@prisma/client')
const Stripe = require('stripe')

const USAGE = `Usage:
  node scripts/deactivate-account.js deactivate <email> [reason] [--cancel-billing] [--immediate] [--refund] [--dry-run]
  node scripts/deactivate-account.js reactivate <email> [--dry-run]

  deactivate            SUSPEND (set deactivatedAt). Add --cancel-billing to also cancel Stripe.
  reactivate            clear deactivatedAt. Does NOT un-cancel Stripe (must re-subscribe).
  <email>               account email (matched case-insensitively)
  [reason]              optional free-text reason (deactivate only), recorded in the audit log

  --cancel-billing      also cancel the Stripe subscription (default: untouched)
  --immediate           cancel now vs at period end (requires --cancel-billing; default OFF)
  --refund              refund the latest charge (requires --cancel-billing; default OFF)
  --dry-run             show the plan + amounts; make NO writes`

const KNOWN_FLAGS = new Set(['--cancel-billing', '--immediate', '--refund', '--dry-run'])

function fail(message) {
  console.error(message)
  process.exit(1)
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans) }))
}

function dollars(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`
}

;(async () => {
  // --- Parse args BEFORE connecting to anything --------------------------
  const argv = process.argv.slice(2)
  const flagArgs = argv.filter(a => a.startsWith('--'))
  const positional = argv.filter(a => !a.startsWith('--'))
  for (const f of flagArgs) {
    if (!KNOWN_FLAGS.has(f)) fail(`Error: unknown flag "${f}".\n\n${USAGE}`)
  }
  const flags = new Set(flagArgs)
  const dryRun = flags.has('--dry-run')
  const cancelBilling = flags.has('--cancel-billing')
  const immediate = flags.has('--immediate')
  const refund = flags.has('--refund')

  const mode = String(positional[0] || '').toLowerCase()
  const email = positional[1]
  const reason = positional[2] || null

  if (mode !== 'deactivate' && mode !== 'reactivate') {
    fail(`Error: first argument must be "deactivate" or "reactivate" (got "${positional[0] || ''}").\n\n${USAGE}`)
  }
  if (!email) fail(`Error: missing <email>.\n\n${USAGE}`)

  if (mode === 'reactivate') {
    if (reason) fail('Error: reactivate does not take a reason argument.\n\n' + USAGE)
    if (cancelBilling || immediate || refund) {
      fail('Error: billing flags (--cancel-billing/--immediate/--refund) are only valid with deactivate.\n\n' + USAGE)
    }
  }
  if (mode === 'deactivate' && (immediate || refund) && !cancelBilling) {
    fail('Error: --immediate and --refund require --cancel-billing.\n\n' + USAGE)
  }

  if (!process.env.DATABASE_URL) fail('Error: DATABASE_URL is not set in the environment / root .env.')

  // Opt-in SSL for Render external Postgres (PGSSL=true|require) via sslmode.
  let dbUrl = process.env.DATABASE_URL
  const pgssl = String(process.env.PGSSL || '').toLowerCase()
  const useSsl = pgssl === 'true' || pgssl === 'require'
  if (useSsl && !/sslmode=/.test(dbUrl)) {
    dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'sslmode=require'
  }

  let dbLabel = '(unparseable DATABASE_URL host)'
  try {
    const u = new URL(process.env.DATABASE_URL)
    dbLabel = `${u.host}${u.pathname}`
  } catch (_) { /* keep fallback */ }

  // Stripe client only when we actually intend to touch billing.
  let stripe = null
  if (cancelBilling) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key || /placeholder/i.test(key)) {
      fail('Error: --cancel-billing requires a real STRIPE_SECRET_KEY in the environment (none / placeholder found).')
    }
    stripe = new Stripe(key, { apiVersion: '2024-06-20' })
  }

  const intent = mode === 'reactivate'
    ? 'REACTIVATE'
    : (cancelBilling ? `CANCEL (billing, timing: ${immediate ? 'IMMEDIATE' : 'AT PERIOD END'})` : 'SUSPEND')

  console.log(`\nDatabase: ${dbLabel}`)
  if (useSsl) console.log('SSL     : enabled (sslmode=require)')
  console.log(`Request : ${intent} for "${email}" (case-insensitive match)${dryRun ? '  [DRY RUN]' : ''}\n`)

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  // Tracked across phases so we can exit non-zero on a partial (cancel ok /
  // refund failed) without leaving the DB writes unwritten.
  let refundFailed = false

  try {
    // --- Case-insensitive lookup; refuse if not unique -------------------
    const matches = await prisma.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: {
        id: true,
        email: true,
        subscriptionTier: true,
        subscriptionId: true,
        founderPricing: true,
        deactivatedAt: true,
        deactivatedReason: true,
      },
    })

    if (matches.length === 0) { console.log(`No user found for ${email}`); return }
    if (matches.length > 1) {
      console.error(`Refusing to act: ${matches.length} users match ${email} (case-insensitive):`)
      console.table(matches.map(m => ({ id: m.id, email: m.email, deactivatedAt: m.deactivatedAt })))
      process.exit(1)
    }

    const user = matches[0]
    const isDeactivated = !!user.deactivatedAt
    const hasActiveSub = !!user.subscriptionId && user.subscriptionTier !== 'FREE'

    console.log('Target account:')
    console.table([{
      id: user.id,
      email: user.email,
      tier: user.subscriptionTier,
      subscriptionId: user.subscriptionId,
      founderPricing: user.founderPricing,
      deactivatedAt: user.deactivatedAt ? user.deactivatedAt.toISOString() : null,
    }])

    // ====================================================================
    // REACTIVATE
    // ====================================================================
    if (mode === 'reactivate') {
      if (!isDeactivated) { console.log('\nAccount is already active. Nothing to do.'); return }

      console.log('\nPlan: clear deactivatedAt + deactivatedReason (reactivate)')
      if (!hasActiveSub) {
        console.log('Note: this account has no active subscription (tier FREE / no subscriptionId).')
        console.log('      Reactivate restores LOGIN only — it does NOT revive a cancelled Stripe')
        console.log('      subscription. If billing was cancelled, the user must re-subscribe.')
      }
      if (dryRun) { console.log('\n[dry-run] No writes made.'); return }

      console.log('\nType REACTIVATE (uppercase, exact) to proceed, anything else to abort.')
      if ((await prompt('> ')).trim() !== 'REACTIVATE') { console.log('Aborted, no changes made.'); return }

      const [updated, log] = await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { deactivatedAt: null, deactivatedReason: null } }),
        prisma.adminActionLog.create({
          data: {
            action: 'REACTIVATE',
            targetUserId: user.id,
            performedBy: 'script:deactivate-account',
            reason: null,
            metadata: { stripeAction: 'none', subscriptionId: user.subscriptionId, hadActiveSubscription: hasActiveSub },
          },
        }),
      ])
      if (updated.deactivatedAt) fail('Error: post-update state mismatch — deactivatedAt is still set after reactivate.')
      console.log(`\n✓ REACTIVATE applied to ${updated.email}`)
      console.log(`  audit log id : ${log.id} (performedBy=${log.performedBy})`)
      if (!hasActiveSub) console.log('  REMINDER: Stripe subscription was NOT revived — user must re-subscribe for Pro.')
      return
    }

    // ====================================================================
    // DEACTIVATE (SUSPEND or CANCEL)
    // ====================================================================
    // Already-suspended + no billing change → genuine no-op. (If --cancel-billing
    // is set we still proceed: the account may have been suspended earlier and
    // the admin now wants to stop billing too.)
    if (isDeactivated && !cancelBilling) {
      console.log(`\nAlready deactivated (since ${user.deactivatedAt.toISOString()}). Nothing to do.`)
      return
    }

    // ---- Stripe phase (only when --cancel-billing) ----------------------
    let stripeAction = 'none'
    let founderPreserved = false
    let refundResult = { issued: false }

    if (cancelBilling) {
      // Guard BEFORE any Stripe call: nothing to cancel.
      if (!hasActiveSub) {
        fail('Refusing: no active subscription to cancel (subscriptionId is null or tier is FREE).')
      }
      founderPreserved = user.founderPricing === true // we always tag admin_cancel below

      // Idempotency + refund preview: one retrieve (expand the payment when refunding).
      const sub = await stripe.subscriptions.retrieve(
        user.subscriptionId,
        refund ? { expand: ['latest_invoice.payment_intent'] } : {},
      )
      const alreadyCanceled = sub.status === 'canceled'

      // Resolve refund target up front so the preview + later refund agree.
      let refundPi = null
      let refundAmount = null
      let refundChargeId = null
      if (refund) {
        const invoice = sub.latest_invoice
        refundPi = invoice && typeof invoice === 'object' ? invoice.payment_intent : null
        if (!refundPi || typeof refundPi !== 'object') {
          fail('Refusing: could not resolve a payment_intent on the latest invoice to refund. Issue any refund manually in Stripe.')
        }
        refundAmount = refundPi.amount
        refundChargeId = refundPi.latest_charge || null
      }

      const timing = immediate ? 'IMMEDIATE' : 'AT PERIOD END'
      console.log('\n' + '!'.repeat(72))
      console.log('!! WARNING: this WILL cancel Stripe billing')
      console.log(`!!   timing      : ${timing}`)
      console.log(`!!   founder rate: ${founderPreserved ? 'PRESERVED (admin-tagged; webhook will NOT forfeit)' : 'n/a (not a founder)'}`)
      if (alreadyCanceled) console.log('!!   note        : subscription is ALREADY canceled at Stripe — cancel will be skipped')
      console.log('!!   the webhook (not this script) downgrades tier->FREE / subscriptionId->null')
      console.log('!'.repeat(72))

      if (refund) {
        console.log(`\nRefund preview: ${dollars(refundAmount)} to charge ${refundChargeId || '(unknown charge)'} (payment_intent ${refundPi.id})`)
      }

      // ---- dry-run: stop here, no writes --------------------------------
      if (dryRun) {
        console.log('\n[dry-run] No Stripe writes, no DB writes.')
        console.log(`[dry-run] Would ${alreadyCanceled ? 'SKIP cancel (already canceled)' : (immediate ? 'cancel IMMEDIATELY' : 'cancel AT PERIOD END')}` +
          `${refund ? ` and refund ${dollars(refundAmount)}` : ''}, then set deactivatedAt + log CANCEL.`)
        return
      }

      // ---- primary confirm ---------------------------------------------
      console.log('\nType CANCEL (uppercase, exact) to proceed, anything else to abort.')
      if ((await prompt('> ')).trim() !== 'CANCEL') { console.log('Aborted, no Stripe or DB changes made.'); return }

      // ---- refund confirm (separate, explicit) --------------------------
      let doRefund = false
      if (refund) {
        console.log(`\nRefund ${dollars(refundAmount)} to charge ${refundChargeId || '(unknown)'}? Type REFUND to proceed, anything else to SKIP the refund (the cancel still happens).`)
        doRefund = (await prompt('> ')).trim() === 'REFUND'
        if (!doRefund) console.log('Refund skipped (not confirmed). Proceeding with cancel only.')
      }

      // ---- STRIPE WRITES: cancel first ----------------------------------
      // If cancel throws, ABORT before any DB write — never a login-blocked-but-
      // still-billing half-state.
      const comment = `admin action: ${reason || '(none)'}`
      try {
        if (alreadyCanceled) {
          stripeAction = 'skipped_already_canceled'
        } else if (immediate) {
          // subscriptions.cancel() does not accept metadata — tag first, then cancel.
          await stripe.subscriptions.update(user.subscriptionId, { metadata: { admin_cancel: 'true' } })
          await stripe.subscriptions.cancel(user.subscriptionId, { cancellation_details: { comment } })
          stripeAction = 'cancel_immediate'
        } else {
          await stripe.subscriptions.update(user.subscriptionId, {
            cancel_at_period_end: true,
            cancellation_details: { comment },
            metadata: { admin_cancel: 'true' },
          })
          stripeAction = 'cancel_at_period_end'
        }
      } catch (err) {
        fail(`Stripe cancel FAILED — NO DB changes made (account left active + billing untouched). ${err.message || err}`)
      }

      // ---- refund (after cancel). On failure DO NOT unwind the cancel. ---
      if (doRefund) {
        try {
          const r = await stripe.refunds.create({ payment_intent: refundPi.id })
          refundResult = { issued: true, amount: refundAmount, chargeId: refundChargeId, refundId: r.id }
          console.log(`✓ Refund issued: ${r.id} (${dollars(refundAmount)})`)
        } catch (err) {
          refundFailed = true
          refundResult = { issued: false, amount: refundAmount, chargeId: refundChargeId, error: String(err.message || err) }
          console.error(`✗ Cancelled OK, but REFUND FAILED — refund ${dollars(refundAmount)} (charge ${refundChargeId}) MANUALLY in Stripe. ${err.message || err}`)
        }
      }
    } else {
      // SUSPEND path with no Stripe — honor dry-run here too.
      console.log(`\nPlan: SUSPEND (set deactivatedAt${reason ? `, reason ${JSON.stringify(reason)}` : ''}); Stripe untouched.`)
      if (dryRun) { console.log('\n[dry-run] No writes made.'); return }
      console.log('\nType DEACTIVATE (uppercase, exact) to proceed, anything else to abort.')
      if ((await prompt('> ')).trim() !== 'DEACTIVATE') { console.log('Aborted, no changes made.'); return }
    }

    // ---- DB phase: deactivatedAt + AdminActionLog in ONE transaction ----
    // The script NEVER writes subscriptionTier/subscriptionId — the webhook owns
    // that downgrade so we don't double-write / race it.
    const action = cancelBilling ? 'CANCEL' : 'SUSPEND'
    const data = {}
    if (!isDeactivated) {
      data.deactivatedAt = new Date()
      data.deactivatedReason = reason
    } else if (reason) {
      data.deactivatedReason = reason // already suspended (cancel-billing follow-up) — refresh reason if given
    }

    const [updated, log] = await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data }),
      prisma.adminActionLog.create({
        data: {
          action,
          targetUserId: user.id,
          performedBy: 'script:deactivate-account',
          reason,
          metadata: {
            stripeAction,
            subscriptionId: user.subscriptionId,
            hadActiveSubscription: hasActiveSub,
            founderPreserved,
            refund: refundResult,
          },
        },
      }),
    ])

    if (!updated.deactivatedAt) fail('Error: post-update state mismatch — deactivatedAt is not set after deactivate.')

    console.log(`\n✓ ${action} applied to ${updated.email}`)
    console.log(`  deactivatedAt : ${updated.deactivatedAt.toISOString()}`)
    console.log(`  stripeAction  : ${stripeAction}`)
    if (cancelBilling) console.log(`  founderRate   : ${founderPreserved ? 'preserved' : 'n/a'}`)
    if (refundResult.issued) console.log(`  refund        : ${dollars(refundResult.amount)} (refundId ${refundResult.refundId})`)
    console.log(`  audit log id  : ${log.id} (performedBy=${log.performedBy})`)
    if (cancelBilling && stripeAction !== 'skipped_already_canceled') {
      console.log('  NOTE: tier/subscriptionId downgrade lands when the Stripe webhook fires.')
    }
  } finally {
    await prisma.$disconnect()
  }

  // Cancel succeeded but the opt-in refund failed → signal partial via exit code
  // (the cancel + deactivation DID persist; the refund must be done manually).
  if (refundFailed) process.exit(1)
})().catch(async err => {
  console.error('deactivate-account failed:', err.message || err)
  process.exit(1)
})
