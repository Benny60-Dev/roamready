import { Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Resend } from 'resend'
import { prisma } from '../utils/prisma'
import { AppError } from '../middleware/errorHandler'
import { AuthRequest } from '../middleware/auth'
import { isFounderEligible } from '../config/founderPricing'
import { isDisposableEmail } from '../utils/disposableEmails'
import { generateVerificationToken, sendVerificationEmail } from '../services/emailVerification'
import { sendNewSignupAlert } from '../services/feedbackNotification'
import { maybeSendFounderWelcome } from '../services/founderWelcome'
import { validatePassword } from '../utils/passwordPolicy'
import { getClientOrigin } from '../utils/clientOrigin'
import { normalizeEmail } from '../utils/email'

const resend = new Resend(process.env.RESEND_API_KEY)

function generateTokens(userId: string) {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: '15m' })
  const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET!, { expiresIn: '30d' })
  return { accessToken, refreshToken }
}

function setRefreshCookie(res: Response, token: string) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
}

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { email: rawEmail, password, firstName, lastName } = req.body
    if (!rawEmail || !password || !firstName || !lastName) {
      throw new AppError('All fields required', 400)
    }

    // Normalize once and reuse everywhere below (disposable check, duplicate
    // lookup, the create write, and the echoed response). Lowercasing at the
    // door is what makes the case-sensitive unique index behave
    // case-insensitively.
    const email = normalizeEmail(rawEmail)

    // Block known disposable / throwaway email providers. Anti-abuse:
    // disposable inboxes are the primary vector for trial-cycling
    // (sign up → consume 7-day Pro trial → discard inbox → repeat).
    // The list lives in utils/disposableEmails.ts; extend by editing
    // that file. Returns 400 with a clear code so the client can show
    // a tailored message instead of the generic "email already in use"
    // confusion.
    if (isDisposableEmail(email)) {
      return res.status(400).json({
        error: 'INVALID_EMAIL_DOMAIN',
        message: "Please use a real email address. We'll send you trip planning tips and need to reach you if there's a booking issue.",
      })
    }

    // Password policy gate. Server-side enforcement is the source of
    // truth — clients can be bypassed (curl, DevTools). The matching
    // client-side check on SignupPage handles obvious cases (empty,
    // too short) instantly without a round trip; the breach-list
    // check is server-only because shipping the blocklist would bloat
    // the bundle. Match the existing 400-with-error-code response
    // shape used by INVALID_EMAIL_DOMAIN above so the client renders
    // both rejections through the same code path.
    const pwCheck = validatePassword(password)
    if (!pwCheck.valid) {
      return res.status(400).json({
        error: 'INVALID_PASSWORD',
        message: pwCheck.error,
      })
    }

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) throw new AppError('Email already in use', 409)

    const passwordHash = await bcrypt.hash(password, 12)
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    // Founder pricing flag is set once at signup based on the signup
    // timestamp vs. FOUNDER_CUTOFF_DATE. Stamped in the same row write so
    // there's no chance of partial state (account created without the flag).
    const founderPricing = isFounderEligible()

    const user = await prisma.user.create({
      // Cast to `any` because the running dev server holds an open handle
      // on the Prisma DLL, so `prisma generate` could not refresh the
      // client types this session (verified: EPERM on rename). The DB
      // column is in place; the cast is removed on the next dev-server
      // restart when the regenerated client picks up `founderPricing`.
      data: {
        email,
        firstName,
        lastName,
        passwordHash,
        subscriptionTier: 'FREE',
        trialEndsAt,
        founderPricing,
      } as any,
    })

    // Owner alert: new signup. Fire-and-forget — the .catch keeps a Resend
    // outage off the registration response path.
    sendNewSignupAlert(user, { provider: 'email' }).catch(() => {})

    // Stripe customer creation is deferred to first checkout (createCheckout
    // controller has an on-demand recovery path that creates + persists
    // customerId when it's still null). This matches the hybrid trial
    // model — no card required to start, so no Stripe-side state needed
    // until the user actually upgrades.

    // Email verification — Phase 2 signup hook. Generate a magic-link
    // token, save it on the user row, fire the send fire-and-forget.
    // Registration MUST succeed even if Resend is down — the user can
    // request a fresh link from settings later. Same non-blocking try/
    // catch pattern that cron.ts + subscriptions.ts use for their
    // best-effort sends. Phase 3 will add the verification-gate
    // middleware and the 1-hour grace period; for now this just queues
    // the email and stamps the token in the DB.
    try {
      const token = generateVerificationToken()
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerificationToken: token } as any,
      })
      // Don't await — Resend's HTTP call can take seconds and we don't
      // want to lengthen the registration response. Errors land in the
      // .catch and get logged but never thrown.
      void sendVerificationEmail(user.id, user.email, token).catch(err => {
        console.error(
          `[register] verification email send FAILED for ${user.email}:`,
          err?.message ?? err,
        )
      })
      console.log(`[register] queued verification email for ${user.email}`)
    } catch (verifyErr: any) {
      // Token write failed (extremely rare — would mean a DB blip
      // between user.create above and this update). Log + continue —
      // signup still succeeds, user can request a fresh link from
      // settings once Phase 3 ships the UI.
      console.error(
        `[register] failed to queue verification email for ${user.email}:`,
        verifyErr?.message ?? verifyErr,
      )
    }

    const { accessToken, refreshToken } = generateTokens(user.id)
    setRefreshCookie(res, refreshToken)

    res.status(201).json({
      accessToken,
      // Shape matches login's response below — keep them in lockstep so
      // freshly-registered users have the same client state shape as
      // freshly-logged-in users (no missing isOwner / founderPricing).
      // emailVerified is hardcoded false here — fresh email/password
      // signups always start unverified. The Phase 3 frontend reads
      // this flag to decide whether to show the verification banner.
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        subscriptionTier: user.subscriptionTier,
        trialEndsAt: user.trialEndsAt,
        isOwner: user.isOwner,
        founderPricing: (user as any).founderPricing,
        emailVerified: false,
        // Marketing opt-in (FR-MARKETING-OPTIN). A fresh signup is always
        // false / null — null marketingConsentAt is what makes the onboarding
        // opt-in modal show. Surfaced here (in lockstep with login) so the
        // client has it immediately, though rehydrateUser → /users/me also fills it.
        marketingConsent: (user as any).marketingConsent,
        marketingConsentAt: (user as any).marketingConsentAt,
        // createdAt powers the 1-hour grace window the Phase 3b
        // verification banner computes against — surface it on the
        // initial signup response so the client doesn't need to wait
        // for a /auth/me round-trip to know when the grace expires.
        createdAt: user.createdAt,
      },
    })
  } catch (err) {
    next(err)
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email: rawEmail, password } = req.body
    if (!rawEmail || !password) throw new AppError('Email and password required', 400)

    const email = normalizeEmail(rawEmail)
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user || !user.passwordHash) throw new AppError('Invalid credentials', 401)

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) throw new AppError('Invalid credentials', 401)

    // Block deactivated accounts AFTER the password check so we never reveal
    // (to someone guessing) that a given email exists but is deactivated — only
    // a caller who already knows the correct password reaches this branch. A
    // distinct message + code lets support tell "deactivated" apart from a
    // wrong password without it being an enumeration oracle for unknown emails.
    if ((user as any).deactivatedAt) {
      throw new AppError(
        'This account has been deactivated. Contact support@roamready.ai to restore access.',
        403,
        { code: 'ACCOUNT_DEACTIVATED' },
      )
    }

    const { accessToken, refreshToken } = generateTokens(user.id)
    setRefreshCookie(res, refreshToken)

    res.json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        subscriptionTier: user.subscriptionTier,
        trialEndsAt: user.trialEndsAt,
        isOwner: user.isOwner,
        founderPricing: (user as any).founderPricing,
        // Phase 3 frontend uses this to render the verification banner.
        // `as any` here for the same DLL-lock reason as the other new
        // fields on the user row — the locally-shipped Prisma client
        // doesn't yet know about emailVerified, but the column exists
        // in the DB and `findUnique` with no `select` returns it.
        emailVerified: (user as any).emailVerified,
        // Marketing opt-in (FR-MARKETING-OPTIN) — in lockstep with register so
        // the client state shape matches. Drives the in-app toggle + (for a user
        // who never answered) the onboarding modal.
        marketingConsent: (user as any).marketingConsent,
        marketingConsentAt: (user as any).marketingConsentAt,
        // createdAt powers the 1-hour grace window computation on the
        // Phase 3b client banner (now - createdAt < 1h → in-grace).
        createdAt: user.createdAt,
      },
    })
  } catch (err) {
    next(err)
  }
}

export async function logout(_req: Request, res: Response) {
  res.clearCookie('refreshToken')
  res.json({ message: 'Logged out' })
}

export async function refreshToken(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies.refreshToken
    if (!token) throw new AppError('No refresh token', 401)

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as { userId: string }
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } })
    if (!user) throw new AppError('User not found', 401)

    // A 30-day refresh cookie must not revive a deactivated session — reject
    // here too, otherwise the access-token gate in requireAuth is the only
    // thing standing between a deactivated user and a fresh 15-min token.
    if ((user as any).deactivatedAt) throw new AppError('Account deactivated', 401)

    const tokens = generateTokens(user.id)
    setRefreshCookie(res, tokens.refreshToken)

    res.json({ accessToken: tokens.accessToken })
  } catch (err) {
    next(new AppError('Invalid refresh token', 401))
  }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { email: rawEmail } = req.body
    const email = normalizeEmail(rawEmail ?? '')
    const user = await prisma.user.findUnique({ where: { email } })

    // Always return success to prevent email enumeration
    if (!user) return res.json({ message: 'If that email exists, a reset link was sent.' })

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const resetUrl = `${getClientOrigin(req)}/reset-password?token=${token}`

    console.log('Password reset token for', email, ':', token)

    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL!,
        to: email,
        subject: 'Reset your RoamReady password',
        html: `
          <p>Hi ${user.firstName},</p>
          <p>We received a request to reset your RoamReady password. Click the link below to choose a new one:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>
          <p>— The RoamReady Team</p>
        `,
        text: `Hi ${user.firstName},\n\nWe received a request to reset your RoamReady password.\n\nReset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.\n\n— The RoamReady Team`,
      })
      console.log('[email] password reset email sent to', email)
    } catch (emailErr: any) {
      console.error('[email] password reset email FAILED:', emailErr?.message)
    }

    res.json({ message: 'If that email exists, a reset link was sent.' })
  } catch (err) {
    next(err)
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, password } = req.body
    if (!token || !password) throw new AppError('Token and password required', 400)

    // Password policy gate — applied BEFORE jwt.verify so a bad
    // password fails with a useful message rather than getting
    // swallowed by the catch-all "Invalid or expired token" below.
    // Same response shape as the register handler so the
    // ResetPasswordPage can render INVALID_PASSWORD identically.
    const pwCheck = validatePassword(password)
    if (!pwCheck.valid) {
      return res.status(400).json({
        error: 'INVALID_PASSWORD',
        message: pwCheck.error,
      })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string }
    const passwordHash = await bcrypt.hash(password, 12)

    await prisma.user.update({
      where: { id: decoded.userId },
      data: { passwordHash },
    })

    res.json({ message: 'Password updated' })
  } catch (err) {
    next(new AppError('Invalid or expired token', 400))
  }
}

export async function getMe(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        rigs: true,
        travelProfile: true,
        memberships: { where: { isActive: true } },
        // Travel Party Phase B: hydrate the user's parties (typically just
        // the default) with people + pets so the profile UI renders on
        // mount without a second round-trip. Mirror this in users.ts:getMe.
        parties: { include: { people: true, pets: true } },
      },
    })
    // Strip sensitive / server-only fields before responding:
    //   - passwordHash: bcrypt hash (existing strip)
    //   - emailVerificationToken: magic-link secret — anyone with this
    //     value can verify the account WITHOUT opening the email,
    //     defeating verification entirely. Critical strip.
    //   - emailVerificationSentAt: backend-only timestamp powering the
    //     60-second resend rate limit; no client need.
    // Destructure-and-rest is the smallest change that works against
    // the currently-shipped Prisma client types (cast through `any` so
    // TS doesn't complain about destructuring fields the stale client
    // doesn't yet know about). Once Prisma regens we could migrate to
    // `omit: { ... }` on the query. Mirror this in users.ts:getMe +
    // users.ts:updateMe whenever the strip list changes.
    if (!user) return res.json(null)

    // One-time founders' welcome (Benny & Cindy) for GOOGLE sign-ups, fired on
    // their first authenticated load. Email/password users get it in their verify
    // email instead; the helper gates on no-passwordHash so no one gets it twice.
    await maybeSendFounderWelcome(user as any)

    const {
      passwordHash: _ph,
      emailVerificationToken: _evt,
      emailVerificationSentAt: _evsa,
      ...safe
    } = user as any
    res.json(safe)
  } catch (err) {
    next(err)
  }
}

export async function googleCallback(req: Request, res: Response) {
  const user = req.user as any
  const origin = getClientOrigin(req)
  if (!user) return res.redirect(`${origin}/login?error=auth_failed`)

  const { accessToken, refreshToken } = generateTokens(user.id)
  setRefreshCookie(res, refreshToken)

  res.redirect(`${origin}/auth/callback?token=${accessToken}`)
}

export async function appleCallback(req: Request, res: Response) {
  res.redirect(`${getClientOrigin(req)}/login?error=apple_not_configured`)
}
