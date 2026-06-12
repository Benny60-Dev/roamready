import { Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../utils/prisma'
import { AuthRequest, hasAccess } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { generatePlanningContextSummary } from '../services/ai'
import type {
  PlanningSessionCreateInput,
  PlanningSessionUpdateInput,
  PlanningSessionPromoteInput,
} from '../schemas'

// Allowlist of fields returned to the client. Adding a new column to
// PlanningSession defaults to NOT being on the wire — keep it that way.
const SESSION_SELECT = {
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

const ALLOWED_STATUS = ['PLANNING', 'COMPLETED', 'ARCHIVED'] as const
type SessionStatus = (typeof ALLOWED_STATUS)[number]

export async function createSession(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data: PlanningSessionCreateInput = req.body
    const session = await prisma.planningSession.create({
      data: { ...data, userId: req.user!.id },
      select: SESSION_SELECT,
    })
    res.status(201).json(session)
  } catch (err) { next(err) }
}

export async function listSessions(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const raw = typeof req.query.status === 'string' ? req.query.status : null
    const where: { userId: string; status?: SessionStatus | { not: SessionStatus } } = {
      userId: req.user!.id,
    }
    if (raw && (ALLOWED_STATUS as readonly string[]).includes(raw)) {
      where.status = raw as SessionStatus
    } else {
      where.status = { not: 'ARCHIVED' }
    }
    const sessions = await prisma.planningSession.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: SESSION_SELECT,
    })
    res.json(sessions)
  } catch (err) { next(err) }
}

export async function getLatestActiveSession(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Resume-candidate selection skips orphan empty sessions so they don't
    // keep triggering the "Resume your last session?" prompt forever. An
    // orphan = PLANNING + no messages + last touched > 10 min ago. These
    // accumulate when a user taps "Start fresh" without first cancelling
    // the previous session, since createSession leaves the prior PLANNING
    // row untouched.
    //
    // Sessions that have ANY messages are always returnable (real work).
    // Sessions with no messages but updated within 10 min are also returnable
    // (just-created, the user might still be deciding what to type).
    //
    // findMany with take:5 instead of findFirst because we need a small
    // lookahead to skip orphans and try the next-most-recent. In practice
    // almost every user has 1-2 candidates; 5 is generous headroom.
    const candidates = await prisma.planningSession.findMany({
      where: { userId: req.user!.id, status: 'PLANNING', tripId: null },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: SESSION_SELECT,
    })

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
    const usable = candidates.find(s => {
      const messages = Array.isArray(s.messages) ? s.messages : []
      if (messages.length > 0) return true
      if (new Date(s.updatedAt) > tenMinutesAgo) return true
      return false
    })

    if (!usable) throw new AppError('No active session', 404)
    res.json(usable)
  } catch (err) { next(err) }
}

export async function getSession(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Combined ownership lookup: we 404 (not 403) when userId mismatches so
    // we don't leak whether the session id exists at all.
    const session = await prisma.planningSession.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: SESSION_SELECT,
    })
    if (!session) throw new AppError('Session not found', 404)
    res.json(session)
  } catch (err) { next(err) }
}

export async function updateSession(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Defense-in-depth ownership check; validateBody has already stripped any
    // client-supplied id/userId/tripId/createdAt/updatedAt from the payload.
    const owned = await prisma.planningSession.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true },
    })
    if (!owned) throw new AppError('Session not found', 404)

    const data: PlanningSessionUpdateInput = req.body
    const updated = await prisma.planningSession.update({
      where: { id: req.params.id },
      data,
      select: SESSION_SELECT,
    })
    res.json(updated)
  } catch (err) { next(err) }
}

export async function promoteSession(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const session = await prisma.planningSession.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      // Pull `messages` here so we can summarize them after promote without a
      // second round-trip. They're already in PG, this is the cheapest
      // moment to grab them.
      select: { id: true, tripId: true, messages: true },
    })
    if (!session) throw new AppError('Session not found', 404)
    if (session.tripId) throw new AppError('Session already promoted', 400)

    const data: PlanningSessionPromoteInput = req.body

    const result = await prisma.$transaction(async (tx) => {
      const trip = await tx.trip.create({
        data: {
          ...data,
          userId: req.user!.id,
          status: 'PLANNING',
          // adHocVehicle is Zod-typed as Record<string, unknown> — known-good
          // JSON because validateBody parsed it through z.record(z.string(),
          // z.unknown()).nullable().optional(). Prisma's Json? column wants
          // Prisma.InputJsonValue, which TypeScript can't infer from the
          // Zod shape alone, so we narrow with a cast. Behavior is unchanged
          // — literal null still flows through to Prisma's runtime as a
          // null write; undefined still means "don't set the column."
          adHocVehicle: data.adHocVehicle as Prisma.InputJsonValue | undefined,
        },
      })
      // Mirror trip.name onto session.title so the SessionsPanel reads
      // consistently after promotion (the user-typed auto-title becomes the
      // real trip name). Done in the same tx so promotion stays atomic.
      const updatedSession = await tx.planningSession.update({
        where: { id: req.params.id },
        data: { tripId: trip.id, status: 'COMPLETED', title: trip.name },
        select: SESSION_SELECT,
      })
      return { session: updatedSession, trip }
    })

    // Best-effort planning-context summary for the modify-with-AI continuity
    // feature. Runs OUTSIDE the transaction on purpose: a Haiku outage must
    // not roll back trip creation. Failures here log and move on — a later
    // open of the modify panel will lazily backfill the field.
    //
    // Block 9 — this is the only AI call on the promote route, and the route
    // itself MUST succeed for every user (free or Pro) so the trip lands in
    // the DB. We gate just the AI call, not the route: non-Pro users skip
    // the summary (planningContextSummary stays null on the trip row) and
    // the rest of promote proceeds. If they later upgrade and open the
    // modify panel, that surface already lazy-backfills the field anyway —
    // see the lazily-backfill note above.
    try {
      const messages = Array.isArray(session.messages) ? (session.messages as any[]) : []
      if (messages.length > 0 && hasAccess(req.user!, 'aiPlannerUnlimited')) {
        const summary = await generatePlanningContextSummary(messages, {
          userId: req.user!.id,
          sessionId: session.id,
          tripId: result.trip.id,
        })
        if (summary) {
          await prisma.trip.update({
            where: { id: result.trip.id },
            data: { planningContextSummary: summary } as any,
          })
        } else {
          console.warn(
            `[promoteSession] planningContextSummary returned null for tripId=${result.trip.id} ` +
            `sessionId=${session.id} — leaving field null, will backfill lazily on first modify open.`
          )
        }
      }
    } catch (summaryErr: any) {
      console.error(
        `[promoteSession] post-promote summary step threw (non-fatal) for tripId=${result.trip.id}:`,
        summaryErr?.message ?? summaryErr,
      )
    }

    res.status(201).json(result)
  } catch (err) { next(err) }
}

export async function deleteSession(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Soft-delete: flip status to ARCHIVED so users can recover. The row stays.
    const owned = await prisma.planningSession.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true },
    })
    if (!owned) throw new AppError('Session not found', 404)

    const archived = await prisma.planningSession.update({
      where: { id: req.params.id },
      data: { status: 'ARCHIVED' },
      select: SESSION_SELECT,
    })
    res.json(archived)
  } catch (err) { next(err) }
}
