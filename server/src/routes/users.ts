import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { validateBody } from '../middleware/validate'
import { MembershipCreateSchema, MembershipUpdateSchema, TravelProfileUpsertSchema, MarketingConsentSchema } from '../schemas'
import {
  getMe,
  updateMe,
  updateMarketingConsent,
  deleteMe,
  getRigs,
  createRig,
  updateRig,
  deleteRig,
  getTravelProfile,
  upsertTravelProfile,
  getMemberships,
  createMembership,
  updateMembership,
  deleteMembership,
} from '../controllers/users'

export const usersRouter = Router()

// GET /users/me is EXEMPT from the email-verification gate. The
// frontend auth store's rehydrateUser hits this endpoint on every page
// load to refresh user state — if we gate it, over-grace unverified
// users get a 403 before the gate-screen UI can even read their
// `emailVerified` state to render itself. Auth still required.
// (The /auth/me endpoint is the spec-canonical exemption; /users/me
// happens to duplicate it. Both are exempt for this same reason — see
// the duplicate-endpoint backlog item flagged in prior commits.)
usersRouter.get('/me', requireAuth, getMe as any)

// PATCH /me/marketing-consent is EXEMPT from the email-verification gate (same
// rationale as GET /me): the onboarding opt-in modal fires immediately after
// signup, BEFORE the user verifies their email, so gating it here would 403 the
// modal's submit for every brand-new user — exactly the user it targets. Auth is
// still required, and the body is a single validated boolean.
usersRouter.patch('/me/marketing-consent', requireAuth, validateBody(MarketingConsentSchema), updateMarketingConsent as any)

// Everything below is gated. requireAuth + requireVerifiedEmail apply
// to all subsequent routes registered on this router.
usersRouter.use(requireAuth, requireVerifiedEmail)

usersRouter.put('/me', updateMe as any)
usersRouter.delete('/me', deleteMe as any)

usersRouter.get('/me/rigs', getRigs as any)
usersRouter.post('/me/rigs', createRig as any)
usersRouter.put('/me/rigs/:id', updateRig as any)
usersRouter.delete('/me/rigs/:id', deleteRig as any)

usersRouter.get('/me/travel-profile', getTravelProfile as any)
usersRouter.put('/me/travel-profile', validateBody(TravelProfileUpsertSchema), upsertTravelProfile as any)

usersRouter.get('/me/memberships', getMemberships as any)
usersRouter.post('/me/memberships', validateBody(MembershipCreateSchema), createMembership as any)
usersRouter.put('/me/memberships/:id', validateBody(MembershipUpdateSchema), updateMembership as any)
usersRouter.delete('/me/memberships/:id', deleteMembership as any)
