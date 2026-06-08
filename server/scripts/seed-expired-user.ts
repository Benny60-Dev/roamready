/**
 * Dev-only seed: create ONE throwaway user whose Pro trial has already
 * EXPIRED, so paywall-blocked behavior can be tested locally.
 *
 * The "expired Pro trial" state is defined by hasAccess() in
 * server/src/middleware/auth.ts:
 *
 *     if (user.isOwner) return true
 *     if (user.trialEndsAt && now < trialEndsAt) return true   // active-trial bypass
 *     if (user.subscriptionEndsAt && now < subscriptionEndsAt) return true
 *     return FEATURE_GATES[feature].includes(user.subscriptionTier)  // FREE -> blocked
 *
 * So a lapsed-trial user is: isOwner=false, subscriptionTier=FREE,
 * trialEndsAt set but in the PAST, no subscriptionEndsAt/subscriptionId/
 * customerId. trialEndsAt being SET (vs null) is what marks them as a
 * user who *had* a trial that lapsed rather than a never-trialed free user
 * (see PaywallModal.trialEligible / PricingPage.trialActive).
 *
 * emailVerified is set true so the separate requireVerifiedEmail gate
 * doesn't 403 the account before the paywall is ever reached.
 *
 * Run from the repo root with the root .env loaded:
 *   npx tsx --env-file=.env server/scripts/seed-expired-user.ts
 *
 * Idempotent: re-running upserts the same user (keyed on email).
 * NEVER runs against a non-localhost DATABASE_URL (guard below).
 */
import bcrypt from 'bcryptjs'
import { prisma } from '../src/utils/prisma'

// ── Localhost-only guard ────────────────────────────────────────────────────
// Refuse to touch anything unless DATABASE_URL clearly points at a local DB.
// This is the only thing standing between this script and prod, so it runs
// before any Prisma query (PrismaClient construction is lazy — it does not
// connect until the first query below).
const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  console.error(
    '✖ DATABASE_URL is not set. Run with the root .env loaded, e.g.:\n' +
    '    npx tsx --env-file=.env server/scripts/seed-expired-user.ts',
  )
  process.exit(1)
}
if (!dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1')) {
  console.error(
    '✖ Refusing to run: DATABASE_URL does not point at localhost / 127.0.0.1.\n' +
    '  This script is DEV-ONLY and must never touch a remote/prod database.\n' +
    `  DATABASE_URL host was not local.`,
  )
  process.exit(1)
}

// ── Fixed test identity ──────────────────────────────────────────────────────
const EMAIL = 'momannexpired@roamready.test'
const PASSWORD = 'Expired123!'
const FIRST_NAME = 'Mo'
const LAST_NAME = 'Mann'

// trialEndsAt: 8 days in the past — unambiguously expired with margin,
// mimics a real "trial just lapsed" user (NOT a near-boundary value).
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000
const trialEndsAt = new Date(Date.now() - EIGHT_DAYS_MS)

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 12) // cost 12 — matches auth.ts

  // The exact field values that yield an EXPIRED PRO TRIAL. Applied on both
  // create AND update so re-running normalizes an existing row back to the
  // lapsed-trial state regardless of how it drifted.
  const expiredTrialState = {
    subscriptionTier: 'FREE' as const,
    trialEndsAt,
    subscriptionEndsAt: null,
    subscriptionId: null,
    customerId: null,
    isOwner: false,
    emailVerified: true,
    passwordHash,
  }

  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: expiredTrialState,
    create: {
      email: EMAIL,
      firstName: FIRST_NAME,
      lastName: LAST_NAME,
      ...expiredTrialState,
    },
  })

  // Resulting trial state, computed the same way hasAccess() does.
  const now = new Date()
  const trialActive = !!user.trialEndsAt && now < new Date(user.trialEndsAt)
  const graceActive = !!user.subscriptionEndsAt && now < new Date(user.subscriptionEndsAt)
  const proGatedAccess = user.isOwner || trialActive || graceActive || user.subscriptionTier === 'PRO'

  console.log('\n✓ Expired Pro trial user ready (dev DB)\n')
  console.log('  email:            ', EMAIL)
  console.log('  password:         ', PASSWORD)
  console.log('  ─────────────────────────────────────────────')
  console.log('  subscriptionTier: ', user.subscriptionTier)
  console.log('  trialEndsAt:      ', user.trialEndsAt?.toISOString(), '(in the past)')
  console.log('  trial active?:    ', trialActive)
  console.log('  isOwner:          ', user.isOwner)
  console.log('  emailVerified:    ', user.emailVerified)
  console.log('  ─────────────────────────────────────────────')
  console.log('  PRO-gated access: ', proGatedAccess, proGatedAccess ? '' : '→ paywall will block ✓')
  console.log('\n  Resulting state: EXPIRED PRO TRIAL (lapsed → treated as FREE).\n')
}

main()
  .catch((err) => {
    console.error('✖ Seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
