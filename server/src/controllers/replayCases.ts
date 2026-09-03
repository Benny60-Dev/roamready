import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import type { AdminReplayCaseCreateInput, AdminReplayCaseUpdateInput } from '../schemas/admin'

// ── FEAT-REPLAY-CASES (owner-only; mounted on adminRouter) ───────────────────
// A ReplayCase is a real planning conversation reduced to the user's turns,
// saved from the Session Inspector with a "what went wrong" note, and re-run by
// scripts/replay-session.mjs (`npm run replay -- --case <name>`). The script
// fetches the case by NAME, runs it, then PATCHes lastRun so the admin page
// shows the latest result. Status: OPEN (bug reproduced) → PASSING (checks pass
// now) → FIXED (Benny confirms). Only lastRun auto-flips OPEN → PASSING, and only
// when there was at least one check and all of them passed.

const rc = () => (prisma as any).replayCase

// Case names are slugs; a collision gets a numeric suffix rather than a 409 —
// the admin is saving from a session and should not have to invent a name.
async function uniqueName(base: string): Promise<string> {
  let name = base
  for (let i = 2; i < 100; i++) {
    const hit = await rc().findUnique({ where: { name }, select: { id: true } })
    if (!hit) return name
    name = `${base}-${i}`
  }
  throw new AppError('Could not find a free case name', 409)
}

export async function createReplayCase(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = req.body as AdminReplayCaseCreateInput
    const name = await uniqueName(body.name)
    const row = await rc().create({
      data: {
        name,
        note: body.note,
        sourceSessionId: body.sourceSessionId ?? null,
        sourceUserEmail: body.sourceUserEmail ?? null,
        setup: body.setup ?? {},
        turns: body.turns,
        final: body.final ?? {},
        createdByEmail: req.user!.email,
      },
    })
    console.info('[replay-case] created %s by %s (session %s)', name, req.user!.email, body.sourceSessionId ?? '-')
    res.status(201).json(row)
  } catch (err) { next(err) }
}

// List — newest first; ?status=OPEN|PASSING|FIXED filters. Turns are included
// (they are small) so the admin page can expand a case without a second call.
export async function listReplayCases(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : ''
    const where = ['OPEN', 'PASSING', 'FIXED'].includes(status) ? { status } : {}
    const rows = await rc().findMany({ where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] })
    res.json(rows)
  } catch (err) { next(err) }
}

// Fetch one by NAME (what the replay script uses) — falls back to id.
export async function getReplayCase(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const key = String(req.params.key ?? '').trim()
    if (!key) throw new AppError('Case name required', 400)
    const row = (await rc().findUnique({ where: { name: key } })) ?? (await rc().findUnique({ where: { id: key } }))
    if (!row) throw new AppError(`No replay case "${key}"`, 404)
    res.json(row)
  } catch (err) { next(err) }
}

export async function updateReplayCase(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id)
    const body = req.body as AdminReplayCaseUpdateInput
    const existing = await rc().findUnique({ where: { id } })
    if (!existing) throw new AppError('Replay case not found', 404)
    const data: Record<string, unknown> = {}
    if (body.status) data.status = body.status
    if (body.note) data.note = body.note
    if (body.turns) data.turns = body.turns
    if (body.final) data.final = body.final
    if (body.lastRun) {
      data.lastRunAt = new Date()
      data.lastRunResult = body.lastRun
      const allPassed = body.lastRun.total > 0 && body.lastRun.passed === body.lastRun.total
      if (allPassed && existing.status === 'OPEN' && !body.status) data.status = 'PASSING'
      // A PASSING case that fails again is a regression — reopen it.
      if (!allPassed && existing.status === 'PASSING' && !body.status) data.status = 'OPEN'
    }
    const row = await rc().update({ where: { id }, data })
    res.json(row)
  } catch (err) { next(err) }
}

export async function deleteReplayCase(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id)
    const existing = await rc().findUnique({ where: { id }, select: { id: true, name: true } })
    if (!existing) throw new AppError('Replay case not found', 404)
    await rc().delete({ where: { id } })
    console.info('[replay-case] deleted %s by %s', existing.name, req.user!.email)
    res.status(204).end()
  } catch (err) { next(err) }
}
