// Internal cron endpoints. Each endpoint is guarded by a shared-secret
// header (X-Cron-Secret). Designed to be called by an external scheduler
// (Vercel Cron, GitHub Actions, cron-job.org, etc.) at a fixed cadence;
// the scheduler is configured outside this codebase.
import { Request, Response, NextFunction } from 'express'
import { Resend } from 'resend'
import { prisma } from '../utils/prisma'
import { AppError } from '../middleware/errorHandler'
import { runOhvLinkCheck } from '../services/ohvLinkCheck'

const resend = new Resend(process.env.RESEND_API_KEY)
const replyToEmail = process.env.REPLY_TO_EMAIL ?? 'support@roamready.ai'

/** Verify the X-Cron-Secret header matches CRON_SECRET in env. Returns
 *  true if authorized (or throws via res). Returns false if the response
 *  was already written — caller must early-return. We return rather
 *  than throw because a 401 from an internal cron endpoint shouldn't
 *  page Sentry the way a real 5xx would. */
function checkCronSecret(req: Request, res: Response): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    // No secret configured → refuse to run rather than silently allow.
    // Better to fail loud than email customers from a misconfigured cron.
    console.error('[cron] CRON_SECRET is not set — refusing to run cron job')
    res.status(503).json({ error: 'CRON_SECRET not configured' })
    return false
  }
  const provided = req.headers['x-cron-secret']
  if (provided !== expected) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}

/** Send the trial-ending reminder email to users whose trialEndsAt falls
 *  in the next 23–25h window and who haven't already been emailed.
 *
 *  Scheduling: external caller should hit this every 1h. The 23–25h
 *  window is intentionally 2 hours wide so a missed firing (cron down,
 *  network blip, deploy in progress) doesn't skip a user's reminder.
 *  Idempotency is enforced via trialEndEmailSentAt — once set, the
 *  user is filtered out of subsequent runs.
 *
 *  Returns { sent, skipped, errors } so the caller (or a human running
 *  the endpoint manually for debugging) can see what happened. */
export async function trialEndingReminder(req: Request, res: Response, next: NextFunction) {
  try {
    if (!checkCronSecret(req, res)) return

    const now = new Date()
    const windowStart = new Date(now.getTime() + 23 * 60 * 60 * 1000)
    const windowEnd   = new Date(now.getTime() + 25 * 60 * 60 * 1000)

    // The `as any` casts on `where` and `select` are temporary — the new
    // trialEndEmailSentAt + founderPricing fields exist in the DB but
    // the generated Prisma client hasn't picked them up yet (running
    // dev server holds an EPERM lock on the engine DLL, same pattern as
    // earlier today). Removable on next dev-server restart + regen.
    const candidates = await prisma.user.findMany({
      where: {
        // Trial ends in the next 23–25 hours.
        trialEndsAt: { gte: windowStart, lte: windowEnd },
        // Idempotency — null means we haven't emailed this user yet.
        trialEndEmailSentAt: null,
        // Don't email users who have already paid (their trial was
        // either cleared on checkout or never expires from their side).
        subscriptionTier: 'FREE',
      } as any,
      select: {
        id: true,
        email: true,
        firstName: true,
        founderPricing: true,
      } as any,
    }) as unknown as Array<{ id: string; email: string; firstName: string; founderPricing: boolean }>


    const clientOrigin = process.env.CLIENT_URL || 'https://roamready.ai'
    const upgradeUrl = `${clientOrigin}/profile/billing/upgrade`

    let sent = 0
    const errors: Array<{ userId: string; message: string }> = []

    for (const u of candidates) {
      // Founder users see the founder rates in the email body; others see
      // regular rates. Both rates are placed inline (rather than computed
      // from env) since this is a customer-facing template and we want
      // determinism — the same wording per audience regardless of env
      // changes. If pricing changes, update both this email and the
      // PricingPage display.
      const isFounder = u.founderPricing === true
      const rateLine = isFounder
        ? 'Founding member rates are still available right now: $7.99/month or $69.99/year, locked in for as long as your subscription stays active.'
        : 'Pro is $8.99/month or $89.99/year.'

      const html = `
        <p>Hi ${u.firstName},</p>
        <p>Your 7-day Pro trial of RoamReady ends tomorrow. Once it ends, you'll still have access to RoamReady for free with basic features — but campground booking, trip journal, weather alerts, maintenance tracker, PDF export, and the rest of the Pro tools will lock until you subscribe.</p>
        <p>If you've been enjoying the trial, you can add a card now to keep everything running smoothly:</p>
        <p><a href="${upgradeUrl}" style="display:inline-block;background:#F7A829;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500">Keep my Pro features →</a></p>
        <p>${rateLine}</p>
        <p>Hit reply if you have any questions — I read every email.</p>
        <p>— Benny<br/>Founder, RoamReady</p>
      `
      const text = `Hi ${u.firstName},\n\nYour 7-day Pro trial of RoamReady ends tomorrow. Once it ends, you'll still have access to RoamReady for free with basic features — but campground booking, trip journal, weather alerts, maintenance tracker, PDF export, and the rest of the Pro tools will lock until you subscribe.\n\nIf you've been enjoying the trial, you can add a card now to keep everything running smoothly:\n\n${upgradeUrl}\n\n${rateLine}\n\nHit reply if you have any questions — I read every email.\n\n— Benny\nFounder, RoamReady`

      try {
        await resend.emails.send({
          from: process.env.FROM_EMAIL!,
          reply_to: replyToEmail,
          to: u.email,
          subject: 'Your RoamReady trial ends tomorrow',
          html,
          text,
        })
        // Only stamp trialEndEmailSentAt AFTER a successful send so a
        // Resend outage doesn't permanently skip the user.
        await prisma.user.update({
          where: { id: u.id },
          data: { trialEndEmailSentAt: new Date() } as any,
        })
        sent += 1
        console.log('[cron:trial-ending] sent to', u.email)
      } catch (sendErr: any) {
        const message = sendErr?.message ?? String(sendErr)
        console.error(`[cron:trial-ending] FAILED for userId=${u.id}:`, message)
        errors.push({ userId: u.id, message })
      }
    }

    res.json({
      sent,
      skipped: candidates.length - sent - errors.length,
      errors,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    })
  } catch (err) {
    next(err)
  }
}

/** Monthly OHV link-checker. Pings every URL in server/src/data/ohvLinks.json
 *  (99: 4 national + 50 state authorities + 45 unique supplemental links),
 *  persists the result for the owner-only admin
 *  view, and emails ADMIN_EMAIL ONLY when one or more links are dead (silent on
 *  a fully-healthy run). Scheduling: external caller hits this monthly. Returns
 *  a summary like the other cron handlers.
 *
 *  The `(prisma as any)` cast on the new OhvLinkCheck model mirrors the
 *  trial-ending casts above — the generated Prisma client won't include the
 *  model until the migration runs + the client regenerates (the running dev
 *  server holds an EPERM lock on the engine DLL). Removable after regen. */
export async function ohvLinkCheck(req: Request, res: Response, next: NextFunction) {
  try {
    if (!checkCronSecret(req, res)) return

    const result = await runOhvLinkCheck()

    // Persist the latest run so the admin view can read it. Wrapped so a DB
    // hiccup (or a not-yet-migrated model) never fails the whole cron run —
    // the email alert below is the more important side effect.
    try {
      await (prisma as any).ohvLinkCheck.create({
        data: {
          checkedAt: new Date(result.checkedAt),
          total: result.total,
          okCount: result.okCount,
          deadCount: result.deadCount,
          dead: result.dead,
          driftWarning: result.driftWarning ?? null,
        },
      })
    } catch (persistErr: any) {
      console.error('[cron:ohv-link-check] persist failed:', persistErr?.message ?? persistErr)
    }

    // Email ONLY when something is dead — silent on a healthy run.
    if (result.deadCount > 0) {
      const to = process.env.ADMIN_EMAIL
      if (!to) {
        console.warn('[cron:ohv-link-check] ADMIN_EMAIL not set — skipping alert email')
      } else if (!process.env.FROM_EMAIL) {
        console.warn('[cron:ohv-link-check] FROM_EMAIL not set — skipping alert email')
      } else {
        const driftHtml = result.driftWarning ? `<p><strong>Drift:</strong> ${result.driftWarning}</p>` : ''
        const driftText = result.driftWarning ? `Drift: ${result.driftWarning}\n` : ''
        const rowsHtml = result.dead
          .map(d => `<li>${d.label} — <a href="${d.url}">${d.url}</a> (status: ${d.status})</li>`)
          .join('')
        const rowsText = result.dead.map(d => `- ${d.label} — ${d.url} (status: ${d.status})`).join('\n')
        try {
          await resend.emails.send({
            from: process.env.FROM_EMAIL!, // runtime-guarded above; matches trial-ending
            reply_to: replyToEmail,
            to,
            subject: `[RoamReady] OHV link check: ${result.deadCount} dead link${result.deadCount === 1 ? '' : 's'}`,
            html: `<p>${result.deadCount} of ${result.total} OHV resource link(s) failed the monthly check (${result.checkedAt}).</p>${driftHtml}<ul>${rowsHtml}</ul><p>Fix in <code>client/src/constants/ohvStateResources.ts</code>, then regenerate <code>server/src/data/ohvLinks.json</code>.</p>`,
            text: `${result.deadCount} of ${result.total} OHV resource link(s) failed the monthly check (${result.checkedAt}).\n${driftText}\n${rowsText}\n\nFix in client/src/constants/ohvStateResources.ts, then regenerate server/src/data/ohvLinks.json.`,
          })
          console.log(`[cron:ohv-link-check] alerted ${to} about ${result.deadCount} dead link(s)`)
        } catch (mailErr: any) {
          console.error('[cron:ohv-link-check] alert email failed:', mailErr?.message ?? mailErr)
        }
      }
    }

    res.json({
      total: result.total,
      okCount: result.okCount,
      deadCount: result.deadCount,
      dead: result.dead,
      driftWarning: result.driftWarning,
    })
  } catch (err) {
    next(err)
  }
}
