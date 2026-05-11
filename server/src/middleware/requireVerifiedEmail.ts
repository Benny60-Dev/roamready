// Email-verification gate. Phase 3a — server-side enforcement only;
// the Phase 3b frontend will render the banner during the grace window
// and the full gate screen post-grace.
//
// Mounting convention: applied AFTER requireAuth on the route groups
// that should be gated. The auth-flow endpoints (login, register,
// refresh, logout, resend-verification, verify-email, GET /auth/me)
// are exempt by NOT having this middleware applied to them — there's
// no global app.use() for this gate, so the exempt list is implicit
// rather than hardcoded.
//
// Bypass rules (in order):
//   1. isOwner === true       — owner accounts are never gated, ever.
//                                Belt-and-suspenders for the bmolini /
//                                momann test accounts and for any future
//                                staff account that needs to operate
//                                even when their email state is weird.
//   2. emailVerified === true — clicked the magic link; no gate.
//   3. createdAt + 1h > now   — within grace window, allow through.
//                                The client renders a verification
//                                banner during this window; this
//                                middleware does NOT log the allow
//                                (would spam logs on every request).
//   4. Otherwise              — 403 EMAIL_VERIFICATION_REQUIRED with
//                                graceExpiredAt timestamp so the client
//                                can render the post-grace gate screen.
import { Response, NextFunction } from 'express'
import { AuthRequest } from './auth'

const GRACE_PERIOD_MS = 60 * 60 * 1000  // 1 hour

export function requireVerifiedEmail(req: AuthRequest, res: Response, next: NextFunction) {
  const u = req.user
  if (!u) {
    // Defense in depth — should never happen because requireAuth is
    // always mounted before this middleware. If it does, surface a 401
    // rather than a 403 so the client redirects to login, not to the
    // gate screen.
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // (1) Owner bypass — never gated.
  if (u.isOwner === true) return next()

  // (2) Verified — no gate.
  if (u.emailVerified === true) return next()

  // (3) Within grace window — allow through. Client shows banner.
  const graceEndsAt = new Date(new Date(u.createdAt).getTime() + GRACE_PERIOD_MS)
  if (new Date() < graceEndsAt) return next()

  // (4) Over grace — 403 with structured error.
  console.warn(
    `[verifyGate] blocked ${req.method} ${req.path} for unverified user ` +
    `${u.email} (grace expired ${graceEndsAt.toISOString()})`
  )
  res.status(403).json({
    error: 'EMAIL_VERIFICATION_REQUIRED',
    message: 'Please verify your email to continue using RoamReady.',
    graceExpiredAt: graceEndsAt.toISOString(),
  })
}
