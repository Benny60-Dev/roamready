import { Router } from 'express'
import { requireAuth, requireOwner } from '../middleware/auth'
import { submitFeedback, getPublicRoadmap, voteFeedback, getAdminFeedback, updateStatus } from '../controllers/feedback'

export const feedbackRouter = Router()

feedbackRouter.get('/public', getPublicRoadmap)
feedbackRouter.post('/', requireAuth, submitFeedback as any)
feedbackRouter.post('/:id/vote', requireAuth, voteFeedback as any)
feedbackRouter.get('/admin', requireAuth, requireOwner as any, getAdminFeedback as any)
feedbackRouter.put('/:id/status', requireAuth, requireOwner as any, updateStatus as any)
