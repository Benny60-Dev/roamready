import { Router } from 'express'
import { requireAuth, requireOwner } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { validateBody } from '../middleware/validate'
import { AdminFeedbackUpdateSchema } from '../schemas/feedback'
import { AdminSuspendSchema, AdminGrantProSchema } from '../schemas/admin'
import { getMetrics, getSubscribers, getMarketingSubscribers, getRevenue, getAdminFeedback, updateFeedback, analyzeFeedback, getLinkHealth, inspectSession, suspendUser, reactivateUser, getUserHistory, grantProUser, revokeProUser } from '../controllers/admin'

export const adminRouter = Router()
// requireVerifiedEmail before requireOwner — owners always bypass the
// gate via the isOwner check inside requireVerifiedEmail, so the order
// is effectively a no-op for owner-only routes, but kept consistent
// with every other gated router.
adminRouter.use(requireAuth, requireVerifiedEmail, requireOwner as any)

adminRouter.get('/metrics', getMetrics as any)
adminRouter.get('/subscribers', getSubscribers as any)
adminRouter.get('/marketing-subscribers', getMarketingSubscribers as any)
adminRouter.get('/revenue', getRevenue as any)

// Account suspend / reactivate + per-account moderation history. All inherit
// the owner gate from the adminRouter.use mount above. Suspend requires a
// non-empty reason (AdminSuspendSchema); self/owner-target guards live in the
// controller.
adminRouter.post('/users/:id/suspend', validateBody(AdminSuspendSchema), suspendUser as any)
adminRouter.post('/users/:id/reactivate', reactivateUser as any)
adminRouter.get('/users/:id/history', getUserHistory as any)

// Complimentary Pro grant / revoke (no Stripe charge).
adminRouter.post('/users/:id/grant-pro', validateBody(AdminGrantProSchema), grantProUser as any)
adminRouter.post('/users/:id/revoke-pro', revokeProUser as any)
adminRouter.get('/feedback', getAdminFeedback as any)
adminRouter.patch('/feedback/:id', validateBody(AdminFeedbackUpdateSchema), updateFeedback as any)
adminRouter.post('/feedback/analyze', analyzeFeedback as any)
adminRouter.get('/link-health', getLinkHealth as any)
// Read-only session inspector — ?tripId= or ?email=. Owner-gated by the
// adminRouter.use mount above (requireAuth + requireVerifiedEmail + requireOwner).
adminRouter.get('/session-inspector', inspectSession as any)
