import { Router } from 'express'
import { requireAuth, requireOwner } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { submitFeedback, getPublicRoadmap, voteFeedback, getAdminFeedback, updateStatus } from '../controllers/feedback'

export const feedbackRouter = Router()

feedbackRouter.get('/public', getPublicRoadmap)
feedbackRouter.post('/', requireAuth, requireVerifiedEmail, submitFeedback as any)
feedbackRouter.post('/:id/vote', requireAuth, requireVerifiedEmail, voteFeedback as any)
feedbackRouter.get('/admin', requireAuth, requireVerifiedEmail, requireOwner as any, getAdminFeedback as any)
feedbackRouter.put('/:id/status', requireAuth, requireVerifiedEmail, requireOwner as any, updateStatus as any)
