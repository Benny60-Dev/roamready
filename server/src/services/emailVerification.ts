// Email-verification magic-link service. Phase 1 — pure backend; the
// signup hooks, login gates, and UI are added in later phases.
//
// Token shape: 32 bytes from crypto.randomBytes, hex-encoded → 64-char
// string. 256 bits of entropy is overkill for a magic link but cheap;
// fits comfortably in a URL query param. @unique on the DB column means
// O(log n) lookup on verify and no risk of cross-account collision.
import crypto from 'crypto'
import { Resend } from 'resend'
import { prisma } from '../utils/prisma'

const resend = new Resend(process.env.RESEND_API_KEY)
const replyToEmail = process.env.REPLY_TO_EMAIL ?? 'support@roamready.ai'

/** Generates a 64-character hex token for an email-verification magic link. */
export function generateVerificationToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/** Sends the verification email via Resend. On successful send, updates
 *  the user's `emailVerificationSentAt` so the 60-second resend rate-limit
 *  can detect rapid-fire abuse. Throws on Resend failure so the caller
 *  (the resend-verification controller) can surface the error properly —
 *  this is a synchronous user-facing flow, not a fire-and-forget like the
 *  trial-end cron, so we WANT to know if delivery fails.
 *
 *  Reuses the existing FROM_EMAIL / REPLY_TO_EMAIL convention from
 *  controllers/subscriptions.ts + controllers/cron.ts — single sending
 *  identity across all transactional mail. If FROM_EMAIL points at a
 *  domain that's not yet Resend-verified, Resend will fall back to its
 *  sandbox sender and emit a warning header; we surface that as a
 *  console.warn from the caller side. */
export async function sendVerificationEmail(
  userId: string,
  email: string,
  token: string,
): Promise<void> {
  // CLIENT_URL is the existing convention across the codebase for
  // building user-facing links (subscriptions.ts, cron.ts). Defaults to
  // localhost:3000 for dev so the flow works out of the box.
  const clientOrigin = process.env.CLIENT_URL || 'http://localhost:3000'
  const verifyUrl = `${clientOrigin}/verify-email?token=${encodeURIComponent(token)}`

  // Look up the user's firstName for personalization. One small query in
  // exchange for a warm greeting; same pattern as the cron email.
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true },
  })
  const firstName = u?.firstName ?? 'there'

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;max-width:560px">
      <p>Hi ${firstName},</p>
      <p>Welcome to RoamReady — we're so glad you're here.</p>
      <p>We're Benny and Cindy. We built RoamReady because planning an RV trip shouldn't take longer than the trip itself — so we made something to handle the logistics and let you focus on the road.</p>
      <p>We're a team of two, which means when you reply to this email, or click on the feedback button in the app, it's us reading it. Questions, snags, wishlist ideas — send them our way. They shape what we build next.</p>
      <p>Ready when you are — just confirm your email below.</p>
      <p><a href="${verifyUrl}" style="display:inline-block;background:#1F6F8B;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500">Verify my email →</a></p>
      <p style="color:#6b7280;font-size:13px">Or paste this link into your browser:<br/><a href="${verifyUrl}">${verifyUrl}</a></p>
      <p>See you out there,</p>
      <p style="margin-bottom:2px">— Benny &amp; Cindy</p>
      <p style="margin-top:0;color:#6b7280">Founders of RoamReady</p>
    </div>
  `.trim()

  const text = `Hi ${firstName},

Welcome to RoamReady — we're so glad you're here.

We're Benny and Cindy. We built RoamReady because planning an RV trip shouldn't take longer than the trip itself — so we made something to handle the logistics and let you focus on the road.

We're a team of two, which means when you reply to this email, or click on the feedback button in the app, it's us reading it. Questions, snags, wishlist ideas — send them our way. They shape what we build next.

Ready when you are — just confirm your email below.

Verify your email: ${verifyUrl}

See you out there,
— Benny & Cindy
Founders of RoamReady`

  const fromAddress = process.env.FROM_EMAIL
  if (!fromAddress) {
    // Spec said: "if domain is not verified yet — log a console.warn if
    // falling back". Resend's sandbox sender is `onboarding@resend.dev`
    // which is always-on for unverified accounts.
    console.warn(
      '[emailVerification] FROM_EMAIL is not set — falling back to Resend sandbox sender. ' +
      'Set FROM_EMAIL in .env once your domain is verified in the Resend dashboard.'
    )
  }

  await resend.emails.send({
    from: fromAddress ?? 'RoamReady <onboarding@resend.dev>',
    reply_to: replyToEmail,
    to: email,
    subject: "Welcome to RoamReady — let's get you started",
    html,
    text,
  })

  // Stamp emailVerificationSentAt AFTER a successful send. A Resend
  // outage means we keep the previous (or null) timestamp, so the user
  // can retry without hitting the 60-second rate limit erroneously.
  await prisma.user.update({
    where: { id: userId },
    data: { emailVerificationSentAt: new Date() } as any,
  })

  console.log('[emailVerification] verification email sent to', email)
}
