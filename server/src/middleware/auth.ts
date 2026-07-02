import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../utils/prisma'
import { AppError } from './errorHandler'

export interface AuthRequest extends Request {
  user?: {
    id: string
    email: string
    subscriptionTier: string
    trialEndsAt: Date | null
    subscriptionEndsAt: Date | null
    isOwner: boolean
    // Set when the request is authenticated with an admin "act as user"
    // impersonation token — the owner id that minted it. req.user itself is
    // still the TARGET user (loaded by userId), which is the point; this is for
    // audit/awareness. Absent on ordinary sessions.
    impersonatedBy?: string
    // Email verification + grace period — read by requireVerifiedEmail.
    // emailVerified: true means user clicked the magic link. createdAt
    // powers the 1-hour grace window for unverified accounts; after
    // createdAt + 1h, gated routes 403.
    emailVerified: boolean
    createdAt: Date
    // Complimentary (owner-granted) Pro — independent of Stripe. Read by
    // hasAccess as an additional grant path.
    compTier: string | null
    compExpiresAt: Date | null
  }
}

export async function requireAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError('No token provided', 401)
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string; impersonatedBy?: string }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      // Cast through `any` because the locally-shipped Prisma client
      // predates the email-verification migration; emailVerified +
      // createdAt are real DB columns and Prisma reads them at runtime,
      // the cast only sidesteps the stale TS types. Removable on next
      // dev-server restart + client regen.
      select: {
        id: true,
        email: true,
        subscriptionTier: true,
        trialEndsAt: true,
        subscriptionEndsAt: true,
        isOwner: true,
        emailVerified: true,
        createdAt: true,
        // Account-deactivation gate (Tier 1). Real DB column; the `as any` on
        // this select covers the stale Prisma client the same way emailVerified
        // does. A valid-but-deactivated session must not pass.
        deactivatedAt: true,
        // Complimentary Pro fields — read by hasAccess (additional grant path).
        compTier: true,
        compExpiresAt: true,
      } as any,
    }) as unknown as AuthRequest['user']

    if (!user) throw new AppError('User not found', 401)

    // Reject deactivated accounts even with an otherwise-valid JWT — this is
    // what stops a still-live 15-min access token from working after deactivate.
    if ((user as any).deactivatedAt) {
      throw new AppError('Account deactivated', 401, { code: 'ACCOUNT_DEACTIVATED' })
    }

    req.user = user
    // Carry the impersonation claim through for audit/awareness. Loading
    // req.user by userId above already resolved the TARGET user (intended);
    // this just records WHO is acting as them.
    if (req.user && decoded.impersonatedBy) req.user.impersonatedBy = decoded.impersonatedBy
    next()
  } catch (err) {
    if (err instanceof AppError) return next(err)
    next(new AppError('Invalid token', 401))
  }
}

export function requireOwner(req: AuthRequest, _res: Response, next: NextFunction) {
  if (!req.user?.isOwner) {
    return next(new AppError('Forbidden', 403))
  }
  next()
}

// Middleware factory: gates a route on a Pro feature. Use after requireAuth.
//   router.post('/foo', requireFeature('tripJournal'), createFoo)
// Errors as 403 with { error, code: 'FEATURE_GATED', feature } so the client
// can route to the paywall modal without parsing the message string.
export function requireFeature(feature: string) {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError('Unauthenticated', 401))
    if (!hasAccess(req.user, feature)) {
      return next(new AppError(`This feature requires Pro: ${feature}`, 403, {
        code: 'FEATURE_GATED',
        feature,
      }))
    }
    next()
  }
}

export function hasAccess(
  user: {
    subscriptionTier: string
    trialEndsAt: Date | null
    subscriptionEndsAt?: Date | null
    isOwner?: boolean
    compTier?: string | null
    compExpiresAt?: Date | null
  },
  feature: string,
): boolean {
  const FEATURE_GATES: Record<string, string[]> = {
    campgroundBooking: ['PRO'],
    rigCompatibilityFilter: ['PRO'],
    militaryCampgrounds: ['PRO'],
    ohvDestinations: ['PRO'],
    vanDestinations: ['PRO'],
    pdfExport: ['PRO'],
    tripSharing: ['PRO'],
    resourcesAlongRoute: ['PRO'],
    packingListGenerator: ['PRO'],
    tripJournal: ['PRO'],
    maintenanceTracker: ['PRO'],
    weatherAlerts: ['PRO'],
    aiPlannerUnlimited: ['PRO'],
  }

  if (user.isOwner) return true
  if (user.trialEndsAt && new Date() < new Date(user.trialEndsAt)) return true
  // Cancellation grace period: user paid through subscriptionEndsAt, even if
  // their tier was flipped to FREE by the cancellation webhook.
  if (user.subscriptionEndsAt && new Date() < new Date(user.subscriptionEndsAt)) return true
  // Complimentary (owner-granted) Pro — fully independent of Stripe. Valid when
  // compTier is PRO and either lifetime (no expiry) or not yet expired. This is
  // an ADDITIONAL grant path; it never reads or writes subscriptionTier/
  // subscriptionEndsAt, so comps and real Stripe subs never collide.
  if (user.compTier === 'PRO' && (!user.compExpiresAt || new Date() < new Date(user.compExpiresAt))) return true
  const gates = FEATURE_GATES[feature]
  if (!gates) return true
  return gates.includes(user.subscriptionTier)
}
