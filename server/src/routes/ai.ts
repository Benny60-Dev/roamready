import { Router } from 'express'
import { requireAuth, requireOwner, requireFeature, AuthRequest } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { chat, getChatHistory, getModifyHistory, generateItinerary, generatePackingList, analyzeFeedback } from '../controllers/ai'

export const aiRouter = Router()
aiRouter.use(requireAuth, requireVerifiedEmail)

// Block 9 — every user-facing AI route gets requireFeature('aiPlannerUnlimited')
// in addition to whatever else was already on it. The umbrella gate maps to
// FEATURE_GATES[aiPlannerUnlimited] = ['PRO'] in middleware/auth.ts; combined
// with hasAccess's inline bypasses for isOwner / active trial /
// subscriptionEndsAt grace, this resolves correctly for every cohort:
//   - owner          → bypass
//   - active trial   → bypass
//   - PRO            → allowed
//   - FREE / expired → 403 FEATURE_GATED → client opens paywall modal
//
// The two read-only chat-history routes stay ungated — they're DB views of
// existing trips that expired users must keep access to (paywall says no NEW
// AI, not "you can't look at the AI conversation that made your trip").
//
// /analyze-feedback stays on requireOwner only (admin-only route — owners
// bypass paywalls anyway, but the explicit owner gate is the actual security
// posture).
aiRouter.post('/chat', requireFeature('aiPlannerUnlimited'), chat as any)
aiRouter.get('/chat/:tripId/history', getChatHistory as any)
aiRouter.get('/chat/:tripId/modify-history', getModifyHistory as any)
aiRouter.post('/generate-itinerary', requireFeature('aiPlannerUnlimited'), generateItinerary as any)
// Packing list keeps its existing packingListGenerator gate (more specific
// error message — modal header reads "Unlock Packing List Generator" rather
// than the generic "AI Trip Planner") AND adds aiPlannerUnlimited as a
// defense-in-depth safety net. Order matters for which 403 fires first:
// packingListGenerator is checked first so the specific label wins; the
// umbrella gate is a redundant catch in case packingListGenerator is ever
// reclassified to a free tier without a coordinated AI-policy review.
aiRouter.post('/generate-packing-list', requireFeature('packingListGenerator'), requireFeature('aiPlannerUnlimited'), generatePackingList as any)
aiRouter.post('/analyze-feedback', requireOwner as any, analyzeFeedback as any)
