import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
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
      select: { id: true, tripId: true },
    })
    if (!session) throw new AppError('Session not found', 404)
    if (session.tripId) throw new AppError('Session already promoted', 400)

    const data: PlanningSessionPromoteInput = req.body

    const result = await prisma.$transaction(async (tx) => {
      const trip = await tx.trip.create({
        data: { ...data, userId: req.user!.id, status: 'PLANNING' },
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
