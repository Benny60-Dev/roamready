// Founders' welcome for GOOGLE sign-ups — a personal note from Benny & Cindy,
// sent ONCE the first time a Google-auth user loads the app. Email/password
// sign-ups get this same welcome folded into their verification email
// (emailVerification.ts); Google users skip verification, so this standalone note
// is how THEY get greeted. Gated on having no passwordHash so the two audiences
// never overlap and no one is welcomed twice.
//
// Follows the per-file Resend convention (emailVerification.ts, cron.ts):
// module-level client, FROM_EMAIL with sandbox fallback, single sending identity.
import { Resend } from 'resend'
import { prisma } from '../utils/prisma'

const resend = new Resend(process.env.RESEND_API_KEY)
const replyToEmail = process.env.REPLY_TO_EMAIL ?? 'support@roamready.ai'

type WelcomeUser = {
  id: string
  email: string
  firstName: string | null
  /** Present for email/password accounts, null for Google/OAuth. Used to gate:
   *  only no-password (Google) users get this standalone note. */
  passwordHash: string | null
  founderWelcomeSentAt: Date | null
}

/**
 * One-time founders' welcome for GOOGLE sign-ups. Called from the /me load paths
 * (auth.ts + users.ts getMe). Email/password sign-ups already get this welcome in
 * their verification email; Google users skip verification, so without this
 * they'd never be greeted. Gate: a null passwordHash means a Google/OAuth account
 * (email/password users always have one), so only they get this standalone note.
 *
 * Race-safe: an atomic conditional updateMany "claims" the send — only the
 * request that flips founderWelcomeSentAt null->now wins the right to email, so
 * two concurrent /me calls can never both send. The claim is awaited (one cheap
 * write, only on the first-ever load); the SEND is detached with its own .catch
 * so a Resend outage never affects or delays the /me response.
 */
export async function maybeSendFounderWelcome(user: WelcomeUser): Promise<void> {
  if (user.passwordHash || user.founderWelcomeSentAt) return
  const claim = await prisma.user.updateMany({
    where: { id: user.id, founderWelcomeSentAt: null } as any,
    data: { founderWelcomeSentAt: new Date() } as any,
  })
  if (claim.count !== 1) return // another concurrent request already claimed it
  void sendFounderWelcome(user.email, user.firstName).catch(err =>
    console.error('[founderWelcome] send failed for', user.email, err?.message ?? err),
  )
}

/** Sends the founders' welcome via Resend. Throws on failure so the caller's
 *  .catch is the single place it's logged (same fire-and-forget contract as the
 *  other lifecycle senders). */
export async function sendFounderWelcome(email: string, firstName: string | null): Promise<void> {
  const name = firstName ?? 'there'
  const fromAddress = process.env.FROM_EMAIL
  if (!fromAddress) {
    console.warn(
      '[founderWelcome] FROM_EMAIL is not set — falling back to Resend sandbox sender. ' +
      'Set FROM_EMAIL in .env once your domain is verified in the Resend dashboard.'
    )
  }

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;max-width:560px">
      <p>Hi ${name}, welcome to RoamReady — we're really glad you're here.</p>
      <p>We're Benny and Cindy, the two people behind it. RoamReady exists to take the stress out of planning RV and road trips so you can spend more time actually out there.</p>
      <p>Because it's just us, we read every email. Got a question, found a bug, or wish it did something it doesn't? Reply to this one — real travelers' ideas are what shape what we build next.</p>
      <p>Good roads and clear skies,</p>
      <p style="margin-bottom:2px">— Benny &amp; Cindy</p>
      <p style="margin-top:0;color:#6b7280">Founders, RoamReady</p>
    </div>`.trim()

  const text = `Hi ${name}, welcome to RoamReady — we're really glad you're here.

We're Benny and Cindy, the two people behind it. RoamReady exists to take the stress out of planning RV and road trips so you can spend more time actually out there.

Because it's just us, we read every email. Got a question, found a bug, or wish it did something it doesn't? Reply to this one — real travelers' ideas are what shape what we build next.

Good roads and clear skies,
— Benny & Cindy
Founders, RoamReady`

  await resend.emails.send({
    from: fromAddress ?? 'RoamReady <onboarding@resend.dev>',
    reply_to: replyToEmail,
    to: email,
    subject: 'A quick hello from Benny & Cindy',
    html,
    text,
  })

  console.log('[founderWelcome] sent to', email)
}
