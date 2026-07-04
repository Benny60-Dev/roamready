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
      <p>Hi ${firstName}, welcome to RoamReady — we're really glad you're here.</p>
      <p>We're Benny and Cindy, the two people behind it. RoamReady takes the stress out of planning RV and road trips, so you can spend less time on logistics and more time actually out there.</p>
      <p>To get started, just confirm your email:</p>
      <p><a href="${verifyUrl}" style="display:inline-block;background:#1F6F8B;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500">Verify my email →</a></p>
      <p>Or paste this link into your browser:</p>
      <p><a href="${verifyUrl}">${verifyUrl}</a></p>
      <p>And because it's just the two of us, we read every email. A question, a bug, or something you wish it did? Just reply — real travelers' ideas shape what we build next.</p>
      <p>Good roads and clear skies,</p>
      <p style="margin-bottom:2px">— Benny &amp; Cindy</p>
      <p style="margin-top:0;color:#6b7280">Founders, RoamReady</p>
    </div>
  `.trim()

  const text = `Hi ${firstName}, welcome to RoamReady — we're really glad you're here.

We're Benny and Cindy, the two people behind it. RoamReady takes the stress out of planning RV and road trips, so you can spend less time on logistics and more time actually out there.

To get started, just confirm your email:
${verifyUrl}

And because it's just the two of us, we read every email. A question, a bug, or something you wish it did? Just reply — real travelers' ideas shape what we build next.

Good roads and clear skies,
— Benny & Cindy
Founders, RoamReady`

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
