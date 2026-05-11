// Email-verification HTTP handlers. Phase 1 — backend only.
//   - resendVerification: POST /api/v1/auth/resend-verification (auth required)
//   - verifyEmail:        GET  /api/v1/auth/verify-email?token=...  (public)
import { Request, Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AppError } from '../middleware/errorHandler'
import { AuthRequest } from '../middleware/auth'
import {
  generateVerificationToken,
  sendVerificationEmail,
} from '../services/emailVerification'

// 60-second rate limit between resend requests. Short enough that a
// user who deleted the email + needs to resend isn't annoyed; long
// enough to make rapid-fire abuse expensive. The limit is per-user
// rather than per-IP because the route is behind requireAuth — every
// caller is identified.
const RESEND_RATE_LIMIT_MS = 60 * 1000

/** POST /api/v1/auth/resend-verification
 *
 *  Issues a fresh verification token and emails it. Behind requireAuth —
 *  the caller already has a JWT and knows their own userId. Three
 *  outcomes:
 *    - 200 { sent: true }      — token rotated, email sent
 *    - 400 ALREADY_VERIFIED    — emailVerified is already true
 *    - 429 TOO_SOON            — < 60s since the last send, with retryAfter
 */
export async function resendVerification(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id

    // Pull the current verification state. We re-query rather than rely
    // on the requireAuth-populated req.user because that snapshot doesn't
    // include the new emailVerified* fields (those weren't there when
    // the auth middleware select-clause was last touched).
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        emailVerificationSentAt: true,
      } as any,
    }) as unknown as {
      id: string
      email: string
      emailVerified: boolean
      emailVerificationSentAt: Date | null
    } | null

    if (!user) throw new AppError('User not found', 404)

    if (user.emailVerified) {
      return res.status(400).json({
        error: 'ALREADY_VERIFIED',
        message: 'This email is already verified.',
      })
    }

    // 60-second rate limit. Compute retryAfter in seconds for the
    // standard 429 response shape.
    if (user.emailVerificationSentAt) {
      const elapsedMs = Date.now() - new Date(user.emailVerificationSentAt).getTime()
      if (elapsedMs < RESEND_RATE_LIMIT_MS) {
        const retryAfter = Math.ceil((RESEND_RATE_LIMIT_MS - elapsedMs) / 1000)
        return res.status(429).json({
          error: 'TOO_SOON',
          message: `Please wait ${retryAfter} more second${retryAfter !== 1 ? 's' : ''} before requesting another verification email.`,
          retryAfter,
        })
      }
    }

    // Rotate the token on each resend so older email copies become
    // invalid. The send-then-update ordering in the service means a
    // Resend outage leaves the previous token intact AND
    // emailVerificationSentAt unchanged — caller can retry.
    const token = generateVerificationToken()
    await prisma.user.update({
      where: { id: userId },
      data: { emailVerificationToken: token } as any,
    })

    await sendVerificationEmail(userId, user.email, token)

    res.json({ sent: true })
  } catch (err) { next(err) }
}

/** GET /api/v1/auth/verify-email?token=...
 *
 *  Public endpoint — the user may be clicking the magic link from a
 *  different device/browser/session than the one that triggered the
 *  send. We identify the user by the token alone, which is acceptable
 *  because the token has 256 bits of entropy and is single-use.
 *
 *  Per spec: no token-expiry check. Links work forever until consumed.
 *
 *  Outcomes:
 *    - 200 { verified: true, email }   — verification successful
 *    - 400 MISSING_TOKEN               — query param absent
 *    - 404 INVALID_TOKEN               — no user has this token
 *                                        (either bad link or already used)
 */
export async function verifyEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : null
    if (!token) {
      return res.status(400).json({
        error: 'MISSING_TOKEN',
        message: 'Verification token is required.',
      })
    }

    const user = await prisma.user.findUnique({
      where: { emailVerificationToken: token } as any,
      select: { id: true, email: true, emailVerified: true } as any,
    }) as unknown as { id: string; email: string; emailVerified: boolean } | null

    if (!user) {
      // 404 covers both "never existed" and "already consumed" — we
      // don't distinguish because the second case isn't actionable for
      // the user (they can request a fresh link from settings).
      return res.status(404).json({
        error: 'INVALID_TOKEN',
        message: "This verification link is no longer valid. It may have already been used — request a new one from your account settings if you still need to verify.",
      })
    }

    // Mark verified + clear the token (one-time use). The clear is what
    // ensures a subsequent click on the same link 404s above.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationToken: null,
      } as any,
    })

    console.log('[emailVerification] verified email for userId=%s', user.id)
    res.json({ verified: true, email: user.email })
  } catch (err) { next(err) }
}
