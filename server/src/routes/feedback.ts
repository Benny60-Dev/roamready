import { Router } from 'express'
import { requireAuth, requireOwner } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { validateBody } from '../middleware/validate'
import { FeedbackSubmitSchema } from '../schemas/feedback'
import { submitFeedback, getPublicRoadmap, voteFeedback, getAdminFeedback } from '../controllers/feedback'

export const feedbackRouter = Router()

feedbackRouter.get('/public', getPublicRoadmap)
feedbackRouter.post('/', requireAuth, requireVerifiedEmail, validateBody(FeedbackSubmitSchema), submitFeedback as any)
feedbackRouter.post('/:id/vote', requireAuth, requireVerifiedEmail, voteFeedback as any)
feedbackRouter.get('/admin', requireAuth, requireVerifiedEmail, requireOwner as any, getAdminFeedback as any)
// Status/visibility updates moved to PATCH /api/v1/admin/feedback/:id (routes/admin.ts).
