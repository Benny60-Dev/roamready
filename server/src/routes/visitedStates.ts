import { Router } from 'express'
import { requireAuth, requireFeature } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { validateBody } from '../middleware/validate'
import { VisitedStateUpsertSchema } from '../schemas'
import {
  listVisitedStates,
  upsertVisitedState,
  deleteVisitedState,
} from '../controllers/visitedStates'

// Dedicated router (NOT under journalRouter — GET /visited-states would collide
// with journalRouter's GET /journal/:id). Mounted at /api/v1/visited-states.
export const visitedStatesRouter = Router()
visitedStatesRouter.use(requireAuth, requireVerifiedEmail)

// Reads OPEN to all authed users (a downgraded user still sees their marks).
// Writes Pro-gated via requireFeature('tripJournal'), matching the journal API.
visitedStatesRouter.get('/', listVisitedStates as any)
visitedStatesRouter.put(
  '/:state',
  requireFeature('tripJournal'),
  validateBody(VisitedStateUpsertSchema),
  upsertVisitedState as any,
)
visitedStatesRouter.delete('/:state', requireFeature('tripJournal'), deleteVisitedState as any)
