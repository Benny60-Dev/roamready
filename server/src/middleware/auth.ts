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
    // Email verification + grace period — read by requireVerifiedEmail.
    // emailVerified: true means user clicked the magic link. createdAt
    // powers the 1-hour grace window for unverified accounts; after
    // createdAt + 1h, gated routes 403.
    emailVerified: boolean
    createdAt: Date
  }
}

export async function requireAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError('No token provided', 401)
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string }

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
      } as any,
    }) as unknown as AuthRequest['user']

    if (!user) throw new AppError('User not found', 401)

    req.user = user
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
  user: { subscriptionTier: string; trialEndsAt: Date | null; subscriptionEndsAt?: Date | null; isOwner?: boolean },
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
  const gates = FEATURE_GATES[feature]
  if (!gates) return true
  return gates.includes(user.subscriptionTier)
}
