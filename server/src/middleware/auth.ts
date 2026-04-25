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
    isOwner: boolean
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
      select: {
        id: true,
        email: true,
        subscriptionTier: true,
        trialEndsAt: true,
        isOwner: true,
      },
    })

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

export function hasAccess(user: { subscriptionTier: string; trialEndsAt: Date | null; isOwner?: boolean }, feature: string): boolean {
  const FEATURE_GATES: Record<string, string[]> = {
    campgroundBooking: ['PRO', 'PRO_PLUS'],
    rigCompatibilityFilter: ['PRO', 'PRO_PLUS'],
    militaryCampgrounds: ['PRO', 'PRO_PLUS'],
    ohvDestinations: ['PRO', 'PRO_PLUS'],
    vanDestinations: ['PRO', 'PRO_PLUS'],
    pdfExport: ['PRO', 'PRO_PLUS'],
    tripSharing: ['PRO', 'PRO_PLUS'],
    resourcesAlongRoute: ['PRO', 'PRO_PLUS'],
    packingListGenerator: ['PRO', 'PRO_PLUS'],
    tripJournal: ['PRO', 'PRO_PLUS'],
    maintenanceTracker: ['PRO', 'PRO_PLUS'],
    membershipAutoApply: ['PRO', 'PRO_PLUS'],
    weatherAlerts: ['PRO', 'PRO_PLUS'],
    aiPlannerUnlimited: ['PRO', 'PRO_PLUS'],
    offlineAccess: ['PRO_PLUS'],
    multipleRigProfiles: ['PRO_PLUS'],
    familyAccount: ['PRO_PLUS'],
    prioritySupport: ['PRO_PLUS'],
    rvRecallAlerts: ['PRO_PLUS'],
    costAnalytics: ['PRO_PLUS'],
    unlimitedJournal: ['PRO_PLUS'],
  }

  if (user.isOwner) return true
  if (user.trialEndsAt && new Date() < new Date(user.trialEndsAt)) return true
  const gates = FEATURE_GATES[feature]
  if (!gates) return true
  return gates.includes(user.subscriptionTier)
}
