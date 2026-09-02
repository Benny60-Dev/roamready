import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { prisma } from '../utils/prisma'

// FEAT-NAV-HANDOFF — POST /api/v1/events. Fire-and-forget product-usage
// events from the client (which maps app a leg was handed to, origin choice,
// whether the corridor was included). Auth required so events carry a real
// userId; tiny payload cap; never fails the caller (204 even if the write
// throws — usage logging must not surface as a user-visible error).
const EventSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9_.-]+$/i),
  tripId: z.string().max(64).optional(),
  props: z.record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).optional(),
})

export const eventsRouter = Router()

eventsRouter.post('/', requireAuth, async (req: AuthRequest, res) => {
  const parsed = EventSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid event' })
  const { name, tripId, props } = parsed.data
  prisma.clientEvent
    .create({ data: { name, tripId: tripId ?? null, userId: req.user!.id, props: props ?? undefined } })
    .catch(err => console.warn('[events] write failed for %s: %s', name, err?.message))
  res.status(204).end()
})
