// Support-inbox notification for new feedback submissions.
//
// Fire-and-forget by contract: the caller (controllers/feedback.ts
// submitFeedback) invokes this WITHOUT awaiting and attaches its own
// .catch — a Resend outage must never fail or delay the 201 response.
// That's why this throws on failure instead of swallowing: the caller's
// catch is the single place the error is logged.
//
// Follows the per-file Resend convention (emailVerification.ts, cron.ts,
// subscriptions.ts): module-level client, FROM_EMAIL with sandbox
// fallback, single sending identity.
import { Resend } from 'resend'
import { prisma } from '../utils/prisma'

const resend = new Resend(process.env.RESEND_API_KEY)
const supportEmail = process.env.SUPPORT_EMAIL ?? 'support@roamready.ai'

type FeedbackRow = {
  id: string
  type: string
  title: string | null
  body: string
  rating: number | null
  screen: string | null
  importance: string | null
  userId: string | null
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function sendFeedbackNotification(feedback: FeedbackRow): Promise<void> {
  // Submitter lookup happens here (not in the controller) so the extra
  // query rides the fire-and-forget path, off the response's critical path.
  const user = feedback.userId
    ? await prisma.user.findUnique({
        where: { id: feedback.userId },
        select: { email: true, firstName: true, lastName: true },
      })
    : null
  const submitterName =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Unknown'
  const submitterEmail = user?.email ?? 'unknown'

  const fromAddress = process.env.FROM_EMAIL
  if (!fromAddress) {
    console.warn(
      '[feedbackNotification] FROM_EMAIL is not set — falling back to Resend sandbox sender. ' +
      'Set FROM_EMAIL in .env once your domain is verified in the Resend dashboard.'
    )
  }

  const subject = `[Feedback] ${feedback.type.replace(/_/g, ' ')}: ${feedback.title || feedback.body.slice(0, 60)}`

  const lines: [string, string][] = [
    ['Type', feedback.type],
    ['Title', feedback.title || '—'],
    ['Rating', feedback.rating != null ? `${feedback.rating}/5` : '—'],
    ['Importance', feedback.importance || '—'],
    ['Screen', feedback.screen || '—'],
    ['From', `${submitterName} <${submitterEmail}>`],
    ['Feedback ID', feedback.id],
  ]

  const html = `
    <p><strong>New feedback submission</strong></p>
    <table cellpadding="4" style="border-collapse:collapse;font-size:14px">
      ${lines.map(([k, v]) => `<tr><td style="color:#6b7280">${k}</td><td>${escapeHtml(v)}</td></tr>`).join('\n      ')}
    </table>
    <p style="white-space:pre-wrap;border-left:3px solid #1F6F8B;padding-left:12px">${escapeHtml(feedback.body)}</p>
    <p style="color:#6b7280;font-size:12px">Reply to this email to respond to the submitter directly.</p>
  `.trim()

  const text =
    `New feedback submission\n\n` +
    lines.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\n${feedback.body}\n\nReply to this email to respond to the submitter directly.`

  await resend.emails.send({
    from: fromAddress ?? 'RoamReady <onboarding@resend.dev>',
    to: supportEmail,
    // reply_to the submitter so Benny can answer from the support inbox
    // with one click; falls back to the support address itself when the
    // row has no user (shouldn't happen — route requires auth).
    reply_to: user?.email ?? supportEmail,
    subject,
    html,
    text,
  })

  console.log('[feedbackNotification] support notification sent for feedback', feedback.id)
}
