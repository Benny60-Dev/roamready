// Reversible account deactivation (Tier 1 account removal) with optional Stripe
// cancellation. Three shapes:
//
//   SUSPEND  (deactivate, no billing flag): set deactivatedAt; Stripe untouched;
//            reversible. The account can no longer authenticate (login, Google
//            OAuth, JWT refresh all reject) and drops out of admin active lists.
//   CANCEL   (deactivate --cancel-billing): SUSPEND + cancel the Stripe
//            subscription (default at period end; --immediate for now). Optional
//            --refund of the latest charge. Stripe logic is SCRIPT-ONLY.
//   REACTIVATE (reactivate): clear deactivatedAt. Does NOT un-cancel Stripe — a
//            cancelled subscription cannot be revived; the user must re-subscribe.
//
// The plain SUSPEND and REACTIVATE writes route through services/accountLifecycle
// (suspend/reactivate) — the SAME implementation the admin Suspend/Reactivate
// buttons use. The CANCEL path keeps its own transaction inline because it
// records Stripe-specific metadata (action 'CANCEL'). This NEVER scrubs personal
// data and NEVER writes subscriptionTier/subscriptionId itself — the Stripe
// webhook (controllers/subscriptions.ts) owns the DB downgrade.
//
// USAGE (runs via tsx; no build step):
//   cd server
//   npx tsx scripts/deactivate-account.ts deactivate <email> [reason] [--cancel-billing] [--immediate] [--refund] [--dry-run]
//   npx tsx scripts/deactivate-account.ts reactivate <email> [--dry-run]
//
// Examples:
//   npx tsx scripts/deactivate-account.ts deactivate cindy@roamready.ai "abuse #42"            # SUSPEND only
//   npx tsx scripts/deactivate-account.ts deactivate cindy@roamready.ai "chargeback" --cancel-billing
//   npx tsx scripts/deactivate-account.ts deactivate cindy@roamready.ai "fraud" --cancel-billing --immediate --refund
//   npx tsx scripts/deactivate-account.ts deactivate cindy@roamready.ai "x" --cancel-billing --dry-run  # no writes
//   npx tsx scripts/deactivate-account.ts reactivate cindy@roamready.ai
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
// Connection: own PrismaClient from DATABASE_URL (root .env), passed into the
// shared service so SUSPEND/REACTIVATE run against the same connection as the
// script's reads. For Render external Postgres set PGSSL=true (appends
// sslmode=require). Stripe client is only constructed for --cancel-billing.
//
// NOTE: run AFTER `npx prisma generate` has picked up add_account_deactivation —
// a stale client won't know deactivatedAt or AdminActionLog.
process.env.TZ = 'UTC'

import path from 'path'
import readline from 'readline'
import dotenv from 'dotenv'
import Stripe from 'stripe'
import { PrismaClient } from '@prisma/client'
import { suspend as suspendAccount, reactivate as reactivateAccount } from '../src/services/accountLifecycle'

dotenv.config({ path: path.resolve(__dirname, '../../.env') })

const PERFORMED_BY = 'script:deactivate-account'

const USAGE = `Usage:
  npx tsx scripts/deactivate-account.ts deactivate <email> [reason] [--cancel-billing] [--immediate] [--refund] [--dry-run]
  npx tsx scripts/deactivate-account.ts reactivate <email> [--dry-run]

  deactivate            SUSPEND (set deactivatedAt). Add --cancel-billing to also cancel Stripe.
  reactivate            clear deactivatedAt. Does NOT un-cancel Stripe (must re-subscribe).
  <email>               account email (matched case-insensitively)
  [reason]              optional free-text reason (deactivate only), recorded in the audit log

  --cancel-billing      also cancel the Stripe subscription (default: untouched)
  --immediate           cancel now vs at period end (requires --cancel-billing; default OFF)
  --refund              refund the latest charge (requires --cancel-billing; default OFF)
  --dry-run             show the plan + amounts; make NO writes`

const KNOWN_FLAGS = new Set(['--cancel-billing', '--immediate', '--refund', '--dry-run'])

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans) }))
}

function dollars(cents: number): string {
  return `$${(Number(cents) / 100).toFixed(2)}`
}

async function main() {
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
  let dbUrl = process.env.DATABASE_URL as string
  const pgssl = String(process.env.PGSSL || '').toLowerCase()
  const useSsl = pgssl === 'true' || pgssl === 'require'
  if (useSsl && !/sslmode=/.test(dbUrl)) {
    dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'sslmode=require'
  }

  let dbLabel = '(unparseable DATABASE_URL host)'
  try {
    const u = new URL(process.env.DATABASE_URL as string)
    dbLabel = `${u.host}${u.pathname}`
  } catch (_) { /* keep fallback */ }

  // Stripe client only when we actually intend to touch billing.
  let stripe: Stripe | null = null
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

  // The script's own client (carries the PGSSL connection) is passed into the
  // shared service so the SUSPEND/REACTIVATE writes use this same connection.
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  // Tracked so we can exit non-zero on a partial (cancel ok / refund failed)
  // without leaving the DB writes unwritten.
  let refundFailed = false

  try {
    // --- Case-insensitive lookup; refuse if not unique -------------------
    const matches: any[] = await (prisma as any).user.findMany({
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
    // REACTIVATE — via shared service
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

      const updated: any = await reactivateAccount(user.id, PERFORMED_BY, prisma)
      if (updated.deactivatedAt) fail('Error: post-update state mismatch — deactivatedAt is still set after reactivate.')
      console.log(`\n✓ REACTIVATE applied to ${updated.email}`)
      console.log(`  audit: REACTIVATE recorded (performedBy=${PERFORMED_BY})`)
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

    // -------- Plain SUSPEND (no billing) — via shared service -----------
    if (!cancelBilling) {
      console.log(`\nPlan: SUSPEND (set deactivatedAt${reason ? `, reason ${JSON.stringify(reason)}` : ''}); Stripe untouched.`)
      if (dryRun) { console.log('\n[dry-run] No writes made.'); return }
      console.log('\nType DEACTIVATE (uppercase, exact) to proceed, anything else to abort.')
      if ((await prompt('> ')).trim() !== 'DEACTIVATE') { console.log('Aborted, no changes made.'); return }

      const updated: any = await suspendAccount(user.id, reason, PERFORMED_BY, prisma)
      if (!updated.deactivatedAt) fail('Error: post-update state mismatch — deactivatedAt is not set after suspend.')
      console.log(`\n✓ SUSPEND applied to ${updated.email}`)
      console.log(`  deactivatedAt : ${updated.deactivatedAt.toISOString()}`)
      console.log(`  audit: SUSPEND recorded (performedBy=${PERFORMED_BY})`)
      return
    }

    // -------- CANCEL (--cancel-billing) — Stripe phase stays in-script ---
    // Guard BEFORE any Stripe call: nothing to cancel.
    if (!hasActiveSub) {
      fail('Refusing: no active subscription to cancel (subscriptionId is null or tier is FREE).')
    }
    const founderPreserved = user.founderPricing === true // we always tag admin_cancel below
    const sc = stripe as Stripe

    // Idempotency + refund preview: one retrieve (expand the payment when refunding).
    const sub: any = await sc.subscriptions.retrieve(
      user.subscriptionId,
      refund ? { expand: ['latest_invoice.payment_intent'] } : {},
    )
    const alreadyCanceled = sub.status === 'canceled'

    let refundPi: any = null
    let refundAmount: number | null = null
    let refundChargeId: string | null = null
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
      console.log(`\nRefund preview: ${dollars(refundAmount as number)} to charge ${refundChargeId || '(unknown charge)'} (payment_intent ${refundPi.id})`)
    }

    if (dryRun) {
      console.log('\n[dry-run] No Stripe writes, no DB writes.')
      console.log(`[dry-run] Would ${alreadyCanceled ? 'SKIP cancel (already canceled)' : (immediate ? 'cancel IMMEDIATELY' : 'cancel AT PERIOD END')}` +
        `${refund ? ` and refund ${dollars(refundAmount as number)}` : ''}, then set deactivatedAt + log CANCEL.`)
      return
    }

    console.log('\nType CANCEL (uppercase, exact) to proceed, anything else to abort.')
    if ((await prompt('> ')).trim() !== 'CANCEL') { console.log('Aborted, no Stripe or DB changes made.'); return }

    let doRefund = false
    if (refund) {
      console.log(`\nRefund ${dollars(refundAmount as number)} to charge ${refundChargeId || '(unknown)'}? Type REFUND to proceed, anything else to SKIP the refund (the cancel still happens).`)
      doRefund = (await prompt('> ')).trim() === 'REFUND'
      if (!doRefund) console.log('Refund skipped (not confirmed). Proceeding with cancel only.')
    }

    // STRIPE WRITES: cancel first. If cancel throws, ABORT before any DB write.
    let stripeAction = 'none'
    const comment = `admin action: ${reason || '(none)'}`
    try {
      if (alreadyCanceled) {
        stripeAction = 'skipped_already_canceled'
      } else if (immediate) {
        // subscriptions.cancel() does not accept metadata — tag first, then cancel.
        await sc.subscriptions.update(user.subscriptionId, { metadata: { admin_cancel: 'true' } })
        await sc.subscriptions.cancel(user.subscriptionId, { cancellation_details: { comment } })
        stripeAction = 'cancel_immediate'
      } else {
        await sc.subscriptions.update(user.subscriptionId, {
          cancel_at_period_end: true,
          cancellation_details: { comment },
          metadata: { admin_cancel: 'true' },
        })
        stripeAction = 'cancel_at_period_end'
      }
    } catch (err: any) {
      fail(`Stripe cancel FAILED — NO DB changes made (account left active + billing untouched). ${err.message || err}`)
    }

    // refund (after cancel). On failure DO NOT unwind the cancel.
    let refundResult: any = { issued: false }
    if (doRefund) {
      try {
        const r = await sc.refunds.create({ payment_intent: refundPi.id })
        refundResult = { issued: true, amount: refundAmount, chargeId: refundChargeId, refundId: r.id }
        console.log(`✓ Refund issued: ${r.id} (${dollars(refundAmount as number)})`)
      } catch (err: any) {
        refundFailed = true
        refundResult = { issued: false, amount: refundAmount, chargeId: refundChargeId, error: String(err.message || err) }
        console.error(`✗ Cancelled OK, but REFUND FAILED — refund ${dollars(refundAmount as number)} (charge ${refundChargeId}) MANUALLY in Stripe. ${err.message || err}`)
      }
    }

    // DB phase: deactivatedAt + AdminActionLog('CANCEL') in ONE transaction.
    // Stays inline (not the shared service) because it records Stripe-specific
    // metadata. Never writes subscriptionTier/subscriptionId — the webhook owns
    // that downgrade.
    const data: Record<string, unknown> = {}
    if (!isDeactivated) {
      data.deactivatedAt = new Date()
      data.deactivatedReason = reason
    } else if (reason) {
      data.deactivatedReason = reason
    }

    const [updated, log]: any = await prisma.$transaction([
      (prisma as any).user.update({ where: { id: user.id }, data }),
      (prisma as any).adminActionLog.create({
        data: {
          action: 'CANCEL',
          targetUserId: user.id,
          performedBy: PERFORMED_BY,
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

    if (!updated.deactivatedAt) fail('Error: post-update state mismatch — deactivatedAt is not set after cancel.')

    console.log(`\n✓ CANCEL applied to ${updated.email}`)
    console.log(`  deactivatedAt : ${updated.deactivatedAt.toISOString()}`)
    console.log(`  stripeAction  : ${stripeAction}`)
    console.log(`  founderRate   : ${founderPreserved ? 'preserved' : 'n/a'}`)
    if (refundResult.issued) console.log(`  refund        : ${dollars(refundResult.amount)} (refundId ${refundResult.refundId})`)
    console.log(`  audit log id  : ${log.id} (performedBy=${log.performedBy})`)
    if (stripeAction !== 'skipped_already_canceled') {
      console.log('  NOTE: tier/subscriptionId downgrade lands when the Stripe webhook fires.')
    }
  } finally {
    await prisma.$disconnect()
  }

  // Cancel succeeded but the opt-in refund failed → signal partial via exit code.
  if (refundFailed) process.exit(1)
}

main().catch((err: any) => {
  console.error('deactivate-account failed:', err.message || err)
  process.exit(1)
})
