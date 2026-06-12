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
import { fbRef } from '../utils/fbRef'

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

export async function sendFeedbackNotification(
  feedback: FeedbackRow,
  attachments: { filename: string; content: Buffer }[] = [],
): Promise<void> {
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

  const subject = `[Feedback][${fbRef(feedback.id)}] ${feedback.type.replace(/_/g, ' ')}: ${feedback.title || feedback.body.slice(0, 60)}`

  const lines: [string, string][] = [
    ['Type', feedback.type],
    ['Title', feedback.title || '—'],
    ['Rating', feedback.rating != null ? `${feedback.rating}/5` : '—'],
    ['Importance', feedback.importance || '—'],
    ['Screen', feedback.screen || '—'],
    ['From', `${submitterName} <${submitterEmail}>`],
    ['Ref', fbRef(feedback.id)],
    ['Feedback ID', feedback.id],
  ]
  if (attachments.length) lines.push(['Screenshots', String(attachments.length)])

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

  const message = {
    from: fromAddress ?? 'RoamReady <onboarding@resend.dev>',
    to: supportEmail,
    // reply_to the submitter so Benny can answer from the support inbox
    // with one click; falls back to the support address itself when the
    // row has no user (shouldn't happen — route requires auth).
    reply_to: user?.email ?? supportEmail,
    subject,
    html,
    text,
  }

  // Attachments are best-effort: if Resend rejects the attachment send,
  // log and fall through to a plain send so the notification itself still
  // lands. A failure of the plain send throws to the caller's .catch.
  if (attachments.length) {
    try {
      await resend.emails.send({ ...message, attachments })
      console.log(
        `[feedbackNotification] support notification sent for feedback ${feedback.id} with ${attachments.length} screenshot(s)`
      )
      return
    } catch (err) {
      console.error('[feedbackNotification] send with attachments failed — retrying without:', err)
    }
  }

  await resend.emails.send(message)
  console.log('[feedbackNotification] support notification sent for feedback', feedback.id)
}

/** Acknowledgment email to the submitter. Same fire-and-forget contract as
 *  sendFeedbackNotification: the controller calls this without awaiting and
 *  attaches its own .catch — throws here surface only in that log line and
 *  never affect the 201. Only called after a successful create, so it never
 *  fires for failed/invalid submissions. */
export async function sendFeedbackAcknowledgment(feedback: FeedbackRow): Promise<void> {
  const user = feedback.userId
    ? await prisma.user.findUnique({
        where: { id: feedback.userId },
        select: { email: true, firstName: true },
      })
    : null
  if (!user?.email) {
    // No recipient — nothing to acknowledge (shouldn't happen; route requires auth).
    console.warn('[feedbackNotification] no submitter email for feedback', feedback.id, '— skipping acknowledgment')
    return
  }
  const firstName = user.firstName ?? 'there'

  const fromAddress = process.env.FROM_EMAIL
  if (!fromAddress) {
    console.warn(
      '[feedbackNotification] FROM_EMAIL is not set — falling back to Resend sandbox sender. ' +
      'Set FROM_EMAIL in .env once your domain is verified in the Resend dashboard.'
    )
  }

  const typeLabel = feedback.type.replace(/_/g, ' ').toLowerCase()

  const html = `
    <p>Hi ${escapeHtml(firstName)},</p>
    <p>Thanks for sharing your feedback — we read every submission, and we'll take a look at yours as soon as possible.</p>
    <p>Here's what you sent us:</p>
    <table cellpadding="4" style="border-collapse:collapse;font-size:14px">
      <tr><td style="color:#6b7280">Type</td><td>${escapeHtml(typeLabel)}</td></tr>
      ${feedback.title ? `<tr><td style="color:#6b7280">Title</td><td>${escapeHtml(feedback.title)}</td></tr>` : ''}
    </table>
    <p style="white-space:pre-wrap;border-left:3px solid #1F6F8B;padding-left:12px">${escapeHtml(feedback.body)}</p>
    <p>If we plan it, you'll see it appear on our <strong>public roadmap</strong> — that's where ideas graduate to once they're on the way.</p>
    <p>Hit reply if you want to add anything — it goes straight to us.</p>
    <p>— The RoamReady team</p>
    <p style="color:#9ca3af;font-size:12px">Reference: ${fbRef(feedback.id)}</p>
  `.trim()

  const text =
    `Hi ${firstName},\n\n` +
    `Thanks for sharing your feedback — we read every submission, and we'll take a look at yours as soon as possible.\n\n` +
    `Here's what you sent us:\n` +
    `Type: ${typeLabel}\n` +
    (feedback.title ? `Title: ${feedback.title}\n` : '') +
    `\n${feedback.body}\n\n` +
    `If we plan it, you'll see it appear on our public roadmap — that's where ideas graduate to once they're on the way.\n\n` +
    `Hit reply if you want to add anything — it goes straight to us.\n\n` +
    `— The RoamReady team\n\nReference: ${fbRef(feedback.id)}`

  await resend.emails.send({
    from: fromAddress ?? 'RoamReady <onboarding@resend.dev>',
    to: user.email,
    // Replies land in the support inbox, not the no-reply sender.
    reply_to: supportEmail,
    subject: `We received your feedback [${fbRef(feedback.id)}] — RoamReady`,
    html,
    text,
  })

  console.log('[feedbackNotification] acknowledgment sent to submitter for feedback', feedback.id)
}

/** "Your request shipped!" notice, sent when an admin moves an item to
 *  SHIPPED. Same fire-and-forget contract as the other senders, with one
 *  twist: returns whether a send ACTUALLY happened so the caller can stamp
 *  shippedNotifiedAt only on real success (the stamp is the idempotency
 *  guard — a failed or skipped send leaves it null so a later transition
 *  can retry). No submitter email → warn + return false, never throw. */
export async function sendFeedbackShippedNotification(feedback: FeedbackRow): Promise<boolean> {
  const user = feedback.userId
    ? await prisma.user.findUnique({
        where: { id: feedback.userId },
        select: { email: true, firstName: true },
      })
    : null
  if (!user?.email) {
    console.warn('[feedbackNotification] no submitter email for feedback', feedback.id, '— skipping shipped notice')
    return false
  }
  const firstName = user.firstName ?? 'there'

  const fromAddress = process.env.FROM_EMAIL
  if (!fromAddress) {
    console.warn(
      '[feedbackNotification] FROM_EMAIL is not set — falling back to Resend sandbox sender. ' +
      'Set FROM_EMAIL in .env once your domain is verified in the Resend dashboard.'
    )
  }

  const clientOrigin = process.env.CLIENT_URL || 'http://localhost:3000'
  const roadmapUrl = `${clientOrigin}/roadmap`
  const ref = fbRef(feedback.id)
  const snippet = feedback.body.length > 200 ? `${feedback.body.slice(0, 200)}…` : feedback.body
  const quotedHtml =
    `${feedback.title ? `<p style="font-weight:500">${escapeHtml(feedback.title)}</p>` : ''}
    <p style="white-space:pre-wrap;border-left:3px solid #1F6F8B;padding-left:12px">${escapeHtml(snippet)}</p>`
  const quotedText = (feedback.title ? `${feedback.title}\n` : '') + snippet

  // Plain-language copy — deliberately no "shipped"/dev jargon; the reader
  // is a camper, not a release manager. Two variants: bug reports hear
  // "fixed", everything else hears "we built it".
  const isBug = feedback.type === 'BUG_REPORT'

  const subject = isBug
    ? `Good news — the issue you reported is fixed [${ref}]`
    : `Good news — we built what you asked for [${ref}]`

  const html = isBug
    ? `
    <p>Hi ${escapeHtml(firstName)},</p>
    <p>You recently reported a problem:</p>
    ${quotedHtml}
    <p>We wanted to let you know it's been fixed, and the fix is now live on RoamReady. You don't need to do anything — the next time you use the site, you'll have the corrected version.</p>
    <p>Thank you for taking the time to report it. Reports like yours genuinely help us make RoamReady better for everyone.</p>
    <p>If you're still running into the problem, just reply to this email and we'll take another look.</p>
    <p>Happy travels,<br/>The RoamReady team</p>
    <p style="color:#9ca3af;font-size:12px">Reference: ${ref}</p>
  `.trim()
    : `
    <p>Hi ${escapeHtml(firstName)},</p>
    <p>A while back you suggested:</p>
    ${quotedHtml}
    <p>We built it, and it's now available on RoamReady. Thank you for the idea — suggestions like yours shape what we work on next.</p>
    <p>You can see what else we're working on at <a href="${roadmapUrl}">${roadmapUrl}</a>.</p>
    <p>If you have any questions or more ideas, just reply to this email.</p>
    <p>Happy travels,<br/>The RoamReady team</p>
    <p style="color:#9ca3af;font-size:12px">Reference: ${ref}</p>
  `.trim()

  const text = isBug
    ? `Hi ${firstName},\n\n` +
      `You recently reported a problem:\n\n${quotedText}\n\n` +
      `We wanted to let you know it's been fixed, and the fix is now live on RoamReady. You don't need to do anything — the next time you use the site, you'll have the corrected version.\n\n` +
      `Thank you for taking the time to report it. Reports like yours genuinely help us make RoamReady better for everyone.\n\n` +
      `If you're still running into the problem, just reply to this email and we'll take another look.\n\n` +
      `Happy travels,\nThe RoamReady team\n\nReference: ${ref}`
    : `Hi ${firstName},\n\n` +
      `A while back you suggested:\n\n${quotedText}\n\n` +
      `We built it, and it's now available on RoamReady. Thank you for the idea — suggestions like yours shape what we work on next.\n\n` +
      `You can see what else we're working on at ${roadmapUrl}\n\n` +
      `If you have any questions or more ideas, just reply to this email.\n\n` +
      `Happy travels,\nThe RoamReady team\n\nReference: ${ref}`

  await resend.emails.send({
    from: fromAddress ?? 'RoamReady <onboarding@resend.dev>',
    to: user.email,
    reply_to: supportEmail,
    subject,
    html,
    text,
  })

  console.log('[feedbackNotification] shipped notice sent to submitter for feedback', feedback.id)
  return true
}
