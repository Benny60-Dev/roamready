import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { stripe } from '../services/stripe'
import { analyzeFeedbackAI } from '../services/ai'
import { sendFeedbackShippedNotification } from '../services/feedbackNotification'
import * as accountLifecycle from '../services/accountLifecycle'

// Narrow projection returned by the user-list + suspend/reactivate endpoints —
// never leak passwordHash / verification tokens. Mirrors the AdminSubscribersPage
// `User` type; deactivatedAt/deactivatedReason drive the Suspended badge + why.
function publicUserRow(u: any) {
  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    subscriptionTier: u.subscriptionTier,
    subscriptionEndsAt: u.subscriptionEndsAt,
    createdAt: u.createdAt,
    deactivatedAt: u.deactivatedAt ?? null,
    deactivatedReason: u.deactivatedReason ?? null,
    // Complimentary Pro — badged distinctly from real Stripe Pro on the client.
    compTier: u.compTier ?? null,
    compExpiresAt: u.compExpiresAt ?? null,
  }
}

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
      // Active-account counts exclude deactivated users (Tier 1). NOTE: revenue
      // figures in getRevenue intentionally do NOT apply this filter — a
      // deactivated PRO user is still being billed until Stripe is cancelled
      // separately, so MRR/ARR must keep counting them.
      prisma.user.count({ where: { deactivatedAt: null } as any }),
      prisma.user.count({ where: { subscriptionTier: 'PRO', deactivatedAt: null } as any }),
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
    const newUsers = await prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo }, deactivatedAt: null } as any })

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

export async function getSubscribers(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // ?status=active (default, back-compat) | suspended | all. Active hides
    // deactivated accounts; suspended shows only them (so they're reachable to
    // reactivate); all shows everyone. deactivatedAt/deactivatedReason are
    // selected so the client can badge + show the why inline.
    const status = req.query.status === 'suspended' || req.query.status === 'all'
      ? req.query.status
      : 'active'
    const where =
      status === 'active' ? { deactivatedAt: null }
      : status === 'suspended' ? { deactivatedAt: { not: null } }
      : {}

    // Built as `any` so the stale Prisma client doesn't reject the
    // deactivatedAt where/select keys (same pattern as getAdminFeedback).
    const args: any = {
      // No tier filter: return ALL matching users (FREE and PRO). The admin
      // Users table splits/filters by tier client-side. (FR-ADMIN-USERLIST)
      where,
      select: {
        id: true, email: true, firstName: true, lastName: true,
        subscriptionTier: true, subscriptionEndsAt: true, createdAt: true,
        deactivatedAt: true, deactivatedReason: true,
        compTier: true, compExpiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }
    const subscribers = await prisma.user.findMany(args)
    res.json(subscribers)
  } catch (err) { next(err) }
}

// GET /admin/marketing-subscribers (FR-MARKETING-OPTIN). The CAN-SPAM "who we may
// email" list: every user who explicitly opted in (marketingConsent = true).
// Read-only; deactivated accounts are excluded (can't market to a disabled
// account). marketingConsentAt is the consent audit timestamp. `any` args for the
// same stale-Prisma-client reason as getSubscribers above.
export async function getMarketingSubscribers(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const args: any = {
      where: { marketingConsent: true, deactivatedAt: null },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        marketingConsentAt: true, createdAt: true,
      },
      orderBy: { marketingConsentAt: 'desc' },
    }
    const subscribers = await prisma.user.findMany(args)
    res.json(subscribers)
  } catch (err) { next(err) }
}

// ── Account suspend / reactivate (admin UI) ──────────────────────────────────
// Owner-gated by the adminRouter.use(requireAuth + requireVerifiedEmail +
// requireOwner) mount. Both delegate the deactivatedAt + AdminActionLog write to
// services/accountLifecycle — the SAME implementation the CLI uses — so there is
// one code path. performedBy is the acting owner's id (NOT a 'script:...' label).

export async function suspendUser(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const targetId = req.params.id
    // Self-lockout guard: an owner suspending themselves would 401 their own
    // session and hide their own row — refuse.
    if (targetId === req.user!.id) {
      throw new AppError('You cannot suspend your own account.', 400)
    }
    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, isOwner: true },
    })
    if (!target) throw new AppError('User not found', 404)
    // Owner-target guard: owners must not be able to lock each other out.
    if (target.isOwner) throw new AppError('You cannot suspend an owner account.', 403)

    // reason is validated non-empty by AdminSuspendSchema on the route.
    const updated = await accountLifecycle.suspend(targetId, req.body.reason, req.user!.id)
    res.json(publicUserRow(updated))
  } catch (err) { next(err) }
}

export async function reactivateUser(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const targetId = req.params.id
    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true },
    })
    if (!target) throw new AppError('User not found', 404)

    const updated = await accountLifecycle.reactivate(targetId, req.user!.id)
    res.json(publicUserRow(updated))
  } catch (err) { next(err) }
}

// ── Complimentary Pro grant / revoke (admin UI) ──────────────────────────────
// Owner-gated by the adminRouter.use mount. Delegates to accountLifecycle so the
// comp* write + GRANT_PRO/REVOKE_PRO audit row happen in one transaction. Comps
// live ONLY in comp* fields — Stripe state is never touched.

export async function grantProUser(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const targetId = req.params.id
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } })
    if (!target) throw new AppError('User not found', 404)

    // Body validated by AdminGrantProSchema (durationKind, optional
    // customExpiresAt for CUSTOM, non-empty reason).
    const { durationKind, customExpiresAt, reason } = req.body
    const updated = await accountLifecycle.grantPro(targetId, {
      durationKind,
      customExpiresAt: customExpiresAt ? new Date(customExpiresAt) : undefined,
      reason,
      performedBy: req.user!.id,
    })
    res.json(publicUserRow(updated))
  } catch (err) { next(err) }
}

export async function revokeProUser(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const targetId = req.params.id
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } })
    if (!target) throw new AppError('User not found', 404)

    const updated = await accountLifecycle.revokePro(targetId, req.user!.id)
    res.json(publicUserRow(updated))
  } catch (err) { next(err) }
}

// Per-account moderation history — every AdminActionLog row for this user,
// newest first. performedBy that is an owner id is resolved to a display
// label; script labels ('script:...') pass through unchanged. Generic over
// action type so SUSPEND/REACTIVATE today and CANCEL/future types render
// without per-type handling.
export async function getUserHistory(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const targetId = req.params.id
    const logs: any[] = await (prisma as any).adminActionLog.findMany({
      where: { targetUserId: targetId },
      orderBy: { createdAt: 'desc' },
    })

    // Resolve owner-id performedBy values to a name/email label in one query.
    const ownerIds = [
      ...new Set(
        logs
          .map(l => l.performedBy)
          .filter((p: string) => p && !p.startsWith('script:')),
      ),
    ] as string[]
    const owners = ownerIds.length
      ? await prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, email: true, firstName: true, lastName: true },
        })
      : []
    const ownerById = new Map(owners.map(o => [o.id, o]))

    res.json(
      logs.map(l => {
        const o = ownerById.get(l.performedBy)
        return {
          id: l.id,
          action: l.action,
          performedBy: l.performedBy,
          performedByLabel: o
            ? `${`${o.firstName} ${o.lastName}`.trim()} (${o.email})`
            : l.performedBy,
          reason: l.reason ?? null,
          metadata: l.metadata ?? null,
          createdAt: l.createdAt,
        }
      }),
    )
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
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : ''
    if (!tripId && !email && !sessionId) {
      throw new AppError('Provide a tripId, sessionId, or email to look up', 400)
    }

    // Audit trail — who inspected which customer. Only the lookup key is logged.
    console.info('[admin-inspect] owner=%s lookup=%s', req.user!.email, tripId || sessionId || email)

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

    // ── Lookup by planning-session id ────────────────────────────────────────
    // Powers the feedback deep-link for reports filed DURING planning (no built
    // trip yet). Returns the same envelope shape as the trip lookup so the
    // inspector UI renders it identically; the built trip is included when the
    // session has since promoted one.
    if (sessionId) {
      const session = await prisma.planningSession.findUnique({
        where: { id: sessionId },
        select: INSPECTOR_SESSION_SELECT,
      })
      if (!session) throw new AppError('No planning session found for that id', 404)

      const user = session.userId
        ? await prisma.user.findUnique({ where: { id: session.userId }, select: INSPECTOR_USER_SELECT })
        : null

      const builtTripId = session.tripId ?? null
      const trip = builtTripId
        ? await prisma.trip.findUnique({
            where: { id: builtTripId },
            select: { id: true, name: true, status: true, startDate: true, stops: { orderBy: { order: 'asc' }, select: INSPECTOR_STOP_SELECT } },
          })
        : null

      const aiUsageLogs = await prisma.aIUsageLog.findMany({
        where: { OR: [{ sessionId }, ...(builtTripId ? [{ tripId: builtTripId }] : [])] },
        orderBy: { createdAt: 'asc' },
        select: INSPECTOR_USAGE_SELECT,
      })

      return res.json({
        user: user ? { email: user.email, firstName: user.firstName, lastName: user.lastName } : null,
        sessions: [session],
        trip,
        trips: trip ? [trip] : [],
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
