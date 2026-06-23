// Single source of truth for reversible account suspension (Tier 1 account
// removal). Both the admin Suspend/Reactivate buttons (controllers/admin.ts)
// and the CLI (scripts/deactivate-account.ts) call THESE functions so the
// deactivatedAt write + AdminActionLog audit row always happen the same way,
// in one transaction. NO personal-data scrub and NO Stripe cancellation live
// here — the script layers Stripe cancel/refund on top for its CANCEL mode;
// the buttons never touch Stripe.
//
// `db` is injectable (defaults to the shared singleton) so the CLI can pass its
// own PrismaClient — it may point at Render's external Postgres with a
// PGSSL-augmented connection string — while the in-process server uses the
// shared client. Same function body either way.
import { prisma as defaultPrisma } from '../utils/prisma'
import type { PrismaClient, User } from '@prisma/client'

async function runLifecycle(
  db: PrismaClient,
  userId: string,
  action: 'SUSPEND' | 'REACTIVATE' | 'GRANT_PRO' | 'REVOKE_PRO',
  data: Record<string, unknown>,
  reason: string | null,
  performedBy: string,
  metadata: Record<string, unknown> = { stripeAction: 'none' },
): Promise<User> {
  // Update the user AND write the audit row atomically — if either fails,
  // neither commits, so we never get a deactivatedAt change without its log
  // (or vice versa). adminActionLog is cast through `any` because a
  // pre-migration Prisma client may not yet type the model; the table exists
  // at runtime (same pattern as the deactivatedAt casts elsewhere).
  const [user] = await db.$transaction([
    db.user.update({ where: { id: userId }, data: data as any }),
    (db as any).adminActionLog.create({
      data: {
        action,
        targetUserId: userId,
        performedBy,
        reason,
        metadata,
      },
    }),
  ])
  return user as User
}

/** Suspend an account: set deactivatedAt + deactivatedReason, write a SUSPEND
 *  audit row. The account can no longer authenticate and drops out of admin
 *  active lists. Reversible via reactivate(). */
export function suspend(
  userId: string,
  reason: string | null,
  performedBy: string,
  db: PrismaClient = defaultPrisma,
): Promise<User> {
  return runLifecycle(
    db,
    userId,
    'SUSPEND',
    { deactivatedAt: new Date(), deactivatedReason: reason },
    reason,
    performedBy,
  )
}

/** Reactivate an account: clear deactivatedAt + deactivatedReason, write a
 *  REACTIVATE audit row. Does NOT revive a cancelled Stripe subscription. */
export function reactivate(
  userId: string,
  performedBy: string,
  db: PrismaClient = defaultPrisma,
): Promise<User> {
  return runLifecycle(
    db,
    userId,
    'REACTIVATE',
    { deactivatedAt: null, deactivatedReason: null },
    null,
    performedBy,
  )
}

export type GrantDurationKind = 'MONTH' | 'YEAR' | 'LIFETIME' | 'CUSTOM'

export interface GrantProOptions {
  durationKind: GrantDurationKind
  customExpiresAt?: Date
  reason: string
  performedBy: string
}

/** Resolve the comp expiry from the duration kind. LIFETIME → null (never
 *  expires); MONTH/YEAR → relative to now; CUSTOM → the provided (future) date.
 *  Throws on a CUSTOM grant missing / in the past so callers fail loudly. */
function resolveCompExpiry(kind: GrantDurationKind, customExpiresAt?: Date): Date | null {
  const now = new Date()
  switch (kind) {
    case 'LIFETIME':
      return null
    case 'MONTH': {
      const d = new Date(now)
      d.setMonth(d.getMonth() + 1)
      return d
    }
    case 'YEAR': {
      const d = new Date(now)
      d.setFullYear(d.getFullYear() + 1)
      return d
    }
    case 'CUSTOM':
      if (!customExpiresAt || isNaN(customExpiresAt.getTime())) {
        throw new Error('CUSTOM grant requires a valid customExpiresAt date')
      }
      if (customExpiresAt.getTime() <= now.getTime()) {
        throw new Error('CUSTOM grant expiry must be in the future')
      }
      return customExpiresAt
  }
}

/** Grant complimentary Pro (no Stripe charge). Writes ONLY the comp* fields —
 *  never subscriptionTier/subscriptionEndsAt — so a real Stripe subscription
 *  and the Stripe webhooks are completely untouched. Granting over an existing
 *  comp overwrites it (a fresh GRANT_PRO row records the new grant in history). */
export function grantPro(
  userId: string,
  opts: GrantProOptions,
  db: PrismaClient = defaultPrisma,
): Promise<User> {
  const expiresAt = resolveCompExpiry(opts.durationKind, opts.customExpiresAt)
  return runLifecycle(
    db,
    userId,
    'GRANT_PRO',
    {
      compTier: 'PRO',
      compExpiresAt: expiresAt,
      compReason: opts.reason,
      compGrantedBy: opts.performedBy,
      compGrantedAt: new Date(),
    },
    opts.reason,
    opts.performedBy,
    { durationKind: opts.durationKind, expiresAt: expiresAt ? expiresAt.toISOString() : null },
  )
}

/** Revoke complimentary Pro: clear ALL comp* fields. Leaves any real Stripe
 *  subscription untouched (it lives in subscriptionTier/subscriptionId). */
export function revokePro(
  userId: string,
  performedBy: string,
  db: PrismaClient = defaultPrisma,
): Promise<User> {
  return runLifecycle(
    db,
    userId,
    'REVOKE_PRO',
    {
      compTier: null,
      compExpiresAt: null,
      compReason: null,
      compGrantedBy: null,
      compGrantedAt: null,
    },
    null,
    performedBy,
    { durationKind: null, expiresAt: null },
  )
}
