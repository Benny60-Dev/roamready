// Visited-states manual marks (Journal map, step 6b phase 2).
//   - GET    /api/v1/visited-states        list the user's manual rows (open)
//   - PUT    /api/v1/visited-states/:state  upsert one mark (Pro-gated)
//   - DELETE /api/v1/visited-states/:state  clear one mark (Pro-gated)
//
// Tier-1 hardened: AuthRequest, manual try/catch + next(err), req.user!.id,
// ownership by userId, AppError. The server is a DUMB upsert — it does NOT
// enforce the derived-overnight lock (that's client-side; the derived-wins
// merge makes a stray manual row harmless).
import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { normalizeStateCode, type VisitedStateUpsertInput } from '../schemas'

export async function listVisitedStates(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rows = await prisma.visitedState.findMany({
      where: { userId: req.user!.id },
      orderBy: { state: 'asc' },
    })
    res.json(rows)
  } catch (err) { next(err) }
}

export async function upsertVisitedState(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id
    const code = normalizeStateCode(req.params.state)
    if (!code) throw new AppError('Unknown state code', 400)

    const { visitType }: VisitedStateUpsertInput = req.body

    const row = await prisma.visitedState.upsert({
      where: { userId_state: { userId, state: code } },
      // lastSeen is @updatedAt — Prisma bumps it automatically on update.
      update: { visitType },
      create: { userId, state: code, visitType },
    })
    res.json(row)
  } catch (err) { next(err) }
}

export async function deleteVisitedState(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id
    const code = normalizeStateCode(req.params.state)
    if (!code) throw new AppError('Unknown state code', 400)

    const existing = await prisma.visitedState.findUnique({
      where: { userId_state: { userId, state: code } },
    })
    if (!existing) throw new AppError('No manual mark for that state', 404)

    await prisma.visitedState.delete({
      where: { userId_state: { userId, state: code } },
    })
    res.json({ message: 'Manual state mark cleared' })
  } catch (err) { next(err) }
}
