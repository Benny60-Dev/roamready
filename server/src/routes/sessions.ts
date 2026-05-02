import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { validateBody } from '../middleware/validate'
import {
  PlanningSessionCreateSchema,
  PlanningSessionUpdateSchema,
  PlanningSessionPromoteSchema,
} from '../schemas'
import {
  createSession,
  listSessions,
  getLatestActiveSession,
  getSession,
  updateSession,
  promoteSession,
  deleteSession,
} from '../controllers/sessions'

export const sessionsRouter = Router()

sessionsRouter.use(requireAuth)

sessionsRouter.post('/', validateBody(PlanningSessionCreateSchema), createSession as any)
sessionsRouter.get('/', listSessions as any)

// Must be declared before the `/:id` route so Express doesn't treat
// "latest-active" as an :id param.
sessionsRouter.get('/latest-active', getLatestActiveSession as any)

sessionsRouter.get('/:id', getSession as any)
sessionsRouter.put('/:id', validateBody(PlanningSessionUpdateSchema), updateSession as any)
sessionsRouter.post('/:id/promote', validateBody(PlanningSessionPromoteSchema), promoteSession as any)
sessionsRouter.delete('/:id', deleteSession as any)
