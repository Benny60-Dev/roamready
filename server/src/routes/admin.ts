import { Router } from 'express'
import { requireAuth, requireOwner } from '../middleware/auth'
import { getMetrics, getSubscribers, getRevenue, getAdminFeedback, analyzeFeedback } from '../controllers/admin'

export const adminRouter = Router()
adminRouter.use(requireAuth, requireOwner as any)

adminRouter.get('/metrics', getMetrics as any)
adminRouter.get('/subscribers', getSubscribers as any)
adminRouter.get('/revenue', getRevenue as any)
adminRouter.get('/feedback', getAdminFeedback as any)
adminRouter.post('/feedback/analyze', analyzeFeedback as any)
