import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { stripe } from '../services/stripe'
import { analyzeFeedbackAI } from '../services/ai'

// ── Date-derived trip completion ─────────────────────────────────────────────
// The stored Trip.status enum is vestigial — nothing sets COMPLETED anymore
// (status is date-derived everywhere user-facing). So `count({ where: status:
// 'COMPLETED' })` was ~always 0. Mirror the client's deriveTripStatus
// (client/src/utils/tripStatus.ts — keep in sync) here: a trip is COMPLETED when
// today is past its effective end date, with the same stop-date fallback the
// client uses (Trip.start/end can be null on promoted-then-shifted trips).

type TripDates = {
  startDate: Date | null
  endDate: Date | null
  stops: { arrivalDate: Date | null; departureDate: Date | null }[]
}

/** Normalize a DateTime to local noon on its UTC calendar day — matches the
 *  client's parseTripDate so the day-boundary comparison agrees. */
function toLocalNoon(value: Date | null): Date | null {
  if (!value || isNaN(value.getTime())) return null
  return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12, 0, 0, 0)
}

function isDerivedCompleted(trip: TripDates): boolean {
  let start = toLocalNoon(trip.startDate)
  let end = toLocalNoon(trip.endDate)
  if (!start || !end) {
    const stops = trip.stops ?? []
    if (!start) {
      const firstDated = stops.find(s => s.arrivalDate != null)
      start = toLocalNoon(firstDated?.arrivalDate ?? null)
    }
    if (!end) {
      let lastDated: TripDates['stops'][number] | null = null
      for (let i = stops.length - 1; i >= 0; i--) {
        if (stops[i].departureDate != null) { lastDated = stops[i]; break }
      }
      end = toLocalNoon(lastDated?.departureDate ?? null)
    }
  }
  // Genuinely undated → PLANNING (not completed). Both ends required, mirroring
  // deriveTripStatus's guard before the > end check.
  if (!start || !end) return false
  const now = new Date()
  const todayAnchor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0)
  return todayAnchor > end
}

export async function getMetrics(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // tripsForStatus: all trips with the fields deriveTripStatus needs. Admin-
    // only + low-frequency, so a full scan with stops is acceptable here.
    const [totalUsers, proUsers, totalTrips, tripsForStatus] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { subscriptionTier: 'PRO' } }),
      prisma.trip.count(),
      prisma.trip.findMany({
        select: {
          startDate: true,
          endDate: true,
          stops: {
            orderBy: { order: 'asc' },
            select: { arrivalDate: true, departureDate: true },
          },
        },
      }),
    ])
    const completedTrips = tripsForStatus.filter(isDerivedCompleted).length

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const newUsers = await prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } })

    res.json({
      totalUsers,
      proUsers,
      freeUsers: totalUsers - proUsers,
      totalTrips,
      completedTrips,
      newUsersLast30Days: newUsers,
    })
  } catch (err) { next(err) }
}

export async function getSubscribers(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const subscribers = await prisma.user.findMany({
      where: { subscriptionTier: { not: 'FREE' } },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        subscriptionTier: true, subscriptionEndsAt: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })
    res.json(subscribers)
  } catch (err) { next(err) }
}

export async function getRevenue(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.includes('placeholder')) {
      return res.json({ message: 'Stripe not configured', mrr: 0, arr: 0 })
    }

    const charges = await stripe.charges.list({ limit: 100 })
    const totalRevenue = charges.data.reduce((sum, c) => sum + (c.amount_captured || 0), 0) / 100

    const proCount = await prisma.user.count({ where: { subscriptionTier: 'PRO' } })

    res.json({
      totalRevenue,
      mrr: proCount * 8.99,
      arr: (proCount * 8.99) * 12,
      proSubscribers: proCount,
    })
  } catch (err) { next(err) }
}

export async function getAdminFeedback(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const feedback = await prisma.feedback.findMany({
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
      orderBy: [{ votes: 'desc' }, { createdAt: 'desc' }],
    })
    res.json(feedback)
  } catch (err) { next(err) }
}

export async function analyzeFeedback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const feedbackItems = await prisma.feedback.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    const analysis = await analyzeFeedbackAI(feedbackItems, { userId: req.user!.id })
    res.json({ analysis })
  } catch (err) { next(err) }
}

/** Latest OHV link-check result for the owner-only admin view. Returns null
 *  when no run has happened yet. `(prisma as any)` until the OhvLinkCheck model
 *  is migrated + the client regenerated (same pattern as cron.ts). */
export async function getLinkHealth(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const latest = await (prisma as any).ohvLinkCheck.findFirst({
      orderBy: { createdAt: 'desc' },
    })
    res.json(latest ?? null)
  } catch (err) { next(err) }
}
