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
  action: 'SUSPEND' | 'REACTIVATE',
  data: Record<string, unknown>,
  reason: string | null,
  performedBy: string,
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
        metadata: { stripeAction: 'none' },
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
