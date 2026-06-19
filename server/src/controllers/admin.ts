import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { stripe } from '../services/stripe'
import { analyzeFeedbackAI } from '../services/ai'
import { sendFeedbackShippedNotification } from '../services/feedbackNotification'

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
      // No tier filter: return ALL users (FREE and PRO). The admin Users
      // table splits/filters by tier client-side. (FR-ADMIN-USERLIST)
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

const FEEDBACK_STATUSES = ['NEW', 'PLANNED', 'IN_PROGRESS', 'SHIPPED', 'DECLINED']

export async function getAdminFeedback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // ?status=<FeedbackStatus> narrows to one status; ?includeArchived=true
    // includes archived rows (default EXCLUDES them so the working view stays
    // clean). Public roadmap visibility is untouched — getPublicRoadmap never
    // consults archivedAt.
    const { status, includeArchived } = req.query
    const where: any = {}
    if (typeof status === 'string' && FEEDBACK_STATUSES.includes(status)) where.status = status
    // archivedAt cast through the untyped where: the locally-generated Prisma
    // client may predate the archive migration; the column is real at runtime
    // (same pattern as auth.ts emailVerified).
    if (includeArchived !== 'true') where.archivedAt = null
    const feedback = await prisma.feedback.findMany({
      where,
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
      orderBy: [{ votes: 'desc' }, { createdAt: 'desc' }],
    })
    res.json(feedback)
  } catch (err) { next(err) }
}

export async function updateFeedback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Body validated by AdminFeedbackUpdateSchema — status, isPublic, and/or
    // archived; at least one present. Spread-conditionals so a single-field
    // patch never touches the others. `archived` is a wire boolean that maps
    // to the archivedAt timestamp (true → now, false → null).
    const { status, isPublic, archived } = req.body

    // Pre-update snapshot for the shipped-notification transition check —
    // we need the PREVIOUS status (and the notify stamp) to fire only on a
    // genuine →SHIPPED edge, never on SHIPPED→SHIPPED no-ops or re-entries
    // after the stamp.
    const before = await prisma.feedback.findUnique({ where: { id: req.params.id } })
    if (!before) return res.status(404).json({ error: 'Feedback not found' })

    const updated = await prisma.feedback.update({
      where: { id: req.params.id },
      data: {
        ...(status !== undefined && { status }),
        ...(isPublic !== undefined && { isPublic }),
        ...(archived !== undefined && { archivedAt: archived ? new Date() : null }),
      } as any, // archivedAt/shippedNotifiedAt may predate the local Prisma client types
    })

    // Shipped notice — automatic, fire-and-forget relative to this response.
    // shippedNotifiedAt is stamped ONLY after the service reports a real send
    // (false = skipped, e.g. no submitter email → stays null), and the stamp
    // is what makes future →SHIPPED transitions no-ops.
    if (
      status === 'SHIPPED' &&
      before.status !== 'SHIPPED' &&
      (before as any).shippedNotifiedAt == null
    ) {
      sendFeedbackShippedNotification(updated as any)
        .then(sent => {
          if (!sent) return
          return prisma.feedback.update({
            where: { id: updated.id },
            data: { shippedNotifiedAt: new Date() } as any,
          }).then(() => undefined)
        })
        .catch(err =>
          console.error('[adminFeedback] shipped notification failed (status change unaffected):', err)
        )
    }

    res.json(updated)
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

// ── Admin Session Inspector (READ-ONLY) ──────────────────────────────────────
// Owner-only diagnostic: look up any customer's planning conversation + the trip
// it built (the Cindy/Austin debugging workflow), without manual prod DB
// spelunking. STRICTLY READ-ONLY — findUnique/findMany only, no writes anywhere.
// Mounted on adminRouter, so requireAuth + requireVerifiedEmail + requireOwner
// already gate it. EXPLICIT selects only — a full User row (passwordHash,
// verification tokens, Stripe ids) is NEVER put on the wire. The session field
// allowlist mirrors controllers/sessions.ts SESSION_SELECT.
const INSPECTOR_SESSION_SELECT = {
  id: true,
  userId: true,
  title: true,
  messages: true,
  partialTripData: true,
  tripId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const

const INSPECTOR_STOP_SELECT = {
  order: true,
  type: true,
  locationName: true,
  locationState: true,
  nights: true,
} as const

// Deliberately minimal — id/email/name only. Never expand this to the whole User.
const INSPECTOR_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
} as const

const INSPECTOR_USAGE_SELECT = {
  callType: true,
  model: true,
  inputTokens: true,
  outputTokens: true,
  estimatedCostUsd: true,
  createdAt: true,
  sessionId: true,
  tripId: true,
} as const

export async function inspectSession(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tripId = typeof req.query.tripId === 'string' ? req.query.tripId.trim() : ''
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : ''
    if (!tripId && !email) {
      throw new AppError('Provide a tripId or email to look up', 400)
    }

    // Audit trail — who inspected which customer. Only the lookup key is logged.
    console.info('[admin-inspect] owner=%s lookup=%s', req.user!.email, tripId || email)

    // ── Lookup by trip id ────────────────────────────────────────────────────
    if (tripId) {
      const trip = await prisma.trip.findUnique({
        where: { id: tripId },
        select: {
          id: true,
          name: true,
          status: true,
          // startDate = the user-set intended TRAVEL/departure date shown on the
          // trip map (NOT createdAt). Nullable on promoted-then-shifted trips.
          startDate: true,
          stops: { orderBy: { order: 'asc' }, select: INSPECTOR_STOP_SELECT },
          user: { select: INSPECTOR_USER_SELECT },
          planningSession: { select: INSPECTOR_SESSION_SELECT },
        },
      })
      if (!trip) throw new AppError('No trip found for that id', 404)

      const sessions = trip.planningSession ? [trip.planningSession] : []
      const sessionId = trip.planningSession?.id ?? null

      const aiUsageLogs = await prisma.aIUsageLog.findMany({
        where: { OR: [...(sessionId ? [{ sessionId }] : []), { tripId }] },
        orderBy: { createdAt: 'asc' },
        select: INSPECTOR_USAGE_SELECT,
      })

      const tripOut = { id: trip.id, name: trip.name, status: trip.status, startDate: trip.startDate, stops: trip.stops }
      return res.json({
        user: trip.user
          ? { email: trip.user.email, firstName: trip.user.firstName, lastName: trip.user.lastName }
          : null,
        sessions,
        trip: tripOut,
        trips: [tripOut],
        aiUsageLogs,
      })
    }

    // ── Lookup by email (CASE-INSENSITIVE — the Cindy footgun) ────────────────
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: INSPECTOR_USER_SELECT,
    })
    if (!user) throw new AppError('No user found for that email', 404)

    const sessions = await prisma.planningSession.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: INSPECTOR_SESSION_SELECT,
    })

    const builtTripIds = sessions
      .map(s => s.tripId)
      .filter((x): x is string => typeof x === 'string' && x.length > 0)

    const trips = builtTripIds.length
      ? await prisma.trip.findMany({
          where: { id: { in: builtTripIds } },
          select: { id: true, name: true, status: true, startDate: true, stops: { orderBy: { order: 'asc' }, select: INSPECTOR_STOP_SELECT } },
        })
      : []

    const sessionIds = sessions.map(s => s.id)
    const aiUsageLogs = await prisma.aIUsageLog.findMany({
      where: {
        OR: [
          { sessionId: { in: sessionIds } },
          ...(builtTripIds.length ? [{ tripId: { in: builtTripIds } }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: INSPECTOR_USAGE_SELECT,
    })

    return res.json({
      user: { email: user.email, firstName: user.firstName, lastName: user.lastName },
      sessions,
      trip: null,
      trips,
      aiUsageLogs,
    })
  } catch (err) { next(err) }
}
