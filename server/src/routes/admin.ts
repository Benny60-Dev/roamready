import { Router } from 'express'
import { requireAuth, requireOwner } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { validateBody } from '../middleware/validate'
import { AdminFeedbackUpdateSchema } from '../schemas/feedback'
import { getMetrics, getSubscribers, getRevenue, getAdminFeedback, updateFeedback, analyzeFeedback, getLinkHealth, inspectSession } from '../controllers/admin'

export const adminRouter = Router()
// requireVerifiedEmail before requireOwner — owners always bypass the
// gate via the isOwner check inside requireVerifiedEmail, so the order
// is effectively a no-op for owner-only routes, but kept consistent
// with every other gated router.
adminRouter.use(requireAuth, requireVerifiedEmail, requireOwner as any)

adminRouter.get('/metrics', getMetrics as any)
adminRouter.get('/subscribers', getSubscribers as any)
adminRouter.get('/revenue', getRevenue as any)
adminRouter.get('/feedback', getAdminFeedback as any)
adminRouter.patch('/feedback/:id', validateBody(AdminFeedbackUpdateSchema), updateFeedback as any)
adminRouter.post('/feedback/analyze', analyzeFeedback as any)
adminRouter.get('/link-health', getLinkHealth as any)
// Read-only session inspector — ?tripId= or ?email=. Owner-gated by the
// adminRouter.use mount above (requireAuth + requireVerifiedEmail + requireOwner).
adminRouter.get('/session-inspector', inspectSession as any)
