import { Request, Response, NextFunction } from 'express'
import { Resend } from 'resend'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { stripe, createStripeCustomer, createCheckoutSession, createPortalSession } from '../services/stripe'

// Same client + env-var setup as auth.ts:10 (forgotPassword email). Kept as
// a per-controller singleton rather than extracted to a shared helper because
// the existing convention in this codebase is inline HTML per call site —
// see auth.ts:161-173. If we add a third email, extract a sendEmail() helper
// then.
const resend = new Resend(process.env.RESEND_API_KEY)

// Reply / contact addresses. FROM_EMAIL stays the Resend-verified sending
// subdomain (e.g. noreply@send.roamready.ai), but customers who hit Reply on
// these mails should land in support, not the no-reply mailbox — that's what
// `replyTo` does. SUPPORT_EMAIL / BILLING_EMAIL are surfaced in-body as
// explicit contact lines (general questions vs payment issues, respectively).
// Defaults keep the prod values inline so a missing env var degrades to
// correct-looking output rather than `undefined` in a customer-facing email.
const replyToEmail = process.env.REPLY_TO_EMAIL ?? 'support@roamready.ai'
const supportEmail = process.env.SUPPORT_EMAIL ?? 'support@roamready.ai'
const billingEmail = process.env.BILLING_EMAIL ?? 'billing@roamready.ai'

function getClientOrigin(req: AuthRequest): string {
  const fwdHost = req.headers['x-forwarded-host']
  if (fwdHost) {
    const host = Array.isArray(fwdHost) ? fwdHost[0] : fwdHost
    const proto = Array.isArray(req.headers['x-forwarded-proto'])
      ? req.headers['x-forwarded-proto'][0]
      : (req.headers['x-forwarded-proto'] as string | undefined) || 'http'
    return `${proto}://${host}`
  }
  return process.env.CLIENT_URL || 'http://localhost:3000'
}

export async function createCheckout(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { priceId } = req.body
    if (!priceId) throw new AppError('priceId required', 400)

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!user) throw new AppError('User not found', 404)

    // Trial eligibility — must be computed BEFORE we create a Stripe customer
    // below, otherwise the freshly-set customerId would flip this check and
    // trial-eligible first-time users would be denied their trial. Eligible
    // means: never had a trial AND never had a Stripe customer record.
    // Anything else (past trial, prior subscription, returning user) is
    // ineligible — checkout will pass trial_period_days: 0.
    const trialEligible = !user.trialEndsAt && !user.customerId

    // On-demand customer creation. The registration path at auth.ts:68 wraps
    // createStripeCustomer in try/catch with console.error on failure (so a
    // Stripe outage during signup doesn't block account creation), which
    // means customerId can be null on accounts that registered during an
    // outage. Recover here by creating the customer on the first checkout
    // attempt, then persist for future requests.
    let customerId = user.customerId
    if (!customerId) {
      const customer = await createStripeCustomer(
        user.email,
        `${user.firstName} ${user.lastName}`.trim(),
      )
      customerId = customer.id
      await prisma.user.update({
        where: { id: user.id },
        data: { customerId },
      })
    }

    const session = await createCheckoutSession(
      customerId,
      priceId,
      user.id,
      getClientOrigin(req),
      !trialEligible,
    )
    res.json({ url: session.url })
  } catch (err) { next(err) }
}

export async function createPortal(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!user?.customerId) throw new AppError('No billing account found', 400)

    const session = await createPortalSession(user.customerId, getClientOrigin(req))
    res.json({ url: session.url })
  } catch (err) { next(err) }
}

/** Map a Stripe priceId to our internal tier by matching against the four
 *  STRIPE_*_PRICE_ID env vars. Used by the two tier-detection paths in the
 *  webhook handler — keeping them on a single helper means a future tier
 *  rename or new tier addition only edits one place.
 *
 *  Falls back to PRO with a warn log when the priceId doesn't match any
 *  configured env var. We deliberately don't crash the webhook on misses:
 *  Stripe retries 5xx responses, and an unknown priceId is more likely a
 *  config gap than a transient failure — failing loud in logs but returning
 *  200 prevents a retry storm. Startup validation in index.ts is the
 *  upstream guard that catches missing/placeholder env vars before they
 *  reach this function.
 */
function tierFromPriceId(priceId: string | null | undefined): 'PRO' | 'PRO_PLUS' {
  if (
    priceId === process.env.STRIPE_PROPLUS_MONTHLY_PRICE_ID ||
    priceId === process.env.STRIPE_PROPLUS_ANNUAL_PRICE_ID
  ) {
    return 'PRO_PLUS'
  }
  if (
    priceId === process.env.STRIPE_PRO_MONTHLY_PRICE_ID ||
    priceId === process.env.STRIPE_PRO_ANNUAL_PRICE_ID
  ) {
    return 'PRO'
  }
  console.error(
    `[StripeWebhook] tierFromPriceId: unrecognized priceId=${priceId} — ` +
    `defaulting to PRO. Check STRIPE_PRO_MONTHLY_PRICE_ID / STRIPE_PRO_ANNUAL_PRICE_ID / ` +
    `STRIPE_PROPLUS_MONTHLY_PRICE_ID / STRIPE_PROPLUS_ANNUAL_PRICE_ID env vars match the Stripe dashboard.`
  )
  return 'PRO'
}

export async function getStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { subscriptionTier: true, subscriptionId: true, trialEndsAt: true, subscriptionEndsAt: true },
    })
    res.json(user)
  } catch (err) { next(err) }
}

export async function handleWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    console.log('[StripeWebhook] handler called, body type:', typeof req.body)
    const sig = req.headers['stripe-signature'] as string
    console.log('[StripeWebhook] signature header present:', sig ? 'yes' : 'no')
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!

    let event
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret)
    } catch (err: any) {
      console.error('[StripeWebhook] constructEvent failed:', err?.message)
      return res.status(400).send('Webhook signature verification failed')
    }
    console.log('[StripeWebhook] verified event:', event.type)

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as any
        const userId = session.metadata?.userId
        if (userId && session.subscription) {
          // Retrieve the subscription so we can derive the actual tier from
          // its priceId. The previous version hardcoded PRO here, which left
          // PRO_PLUS purchases briefly mis-tiered (and permanently mis-tiered
          // if customer.subscription.updated never fired). Stripe usually
          // fires subscription.updated shortly after this event, but the
          // ordering is not guaranteed and the in-between window is enough
          // to ship the user the wrong feature gates.
          const sub = await stripe.subscriptions.retrieve(session.subscription as string)
          const priceId = sub.items.data[0]?.price?.id
          const tier = tierFromPriceId(priceId)
          // .update returns the updated row — capture it instead of a separate
          // findUnique so we have email + firstName for the confirmation email
          // without a second round trip.
          const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: {
              subscriptionId: session.subscription,
              subscriptionTier: tier,
            },
          })

          // Confirmation email. Fire-and-log: webhook MUST return 200 even if
          // Resend is down, otherwise Stripe retries and we'd re-process the
          // tier update (idempotent, but still wasteful) — and we'd never
          // hand control back to Stripe at all if Resend hangs. Catch keeps
          // the response path clean.
          const tierLabel = tier === 'PRO_PLUS' ? 'Pro+' : 'Pro'
          const billingUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/profile/billing`
          try {
            await resend.emails.send({
              from: process.env.FROM_EMAIL!,
              reply_to: replyToEmail,
              to: updatedUser.email,
              subject: `Welcome to RoamReady ${tierLabel}!`,
              html: `
                <p>Hi ${updatedUser.firstName},</p>
                <p>Your RoamReady <strong>${tierLabel}</strong> subscription is now active — thanks for upgrading!</p>
                <p>You've unlocked:</p>
                <ul>
                  <li>Unlimited AI trip planning &amp; modifications</li>
                  <li>Campground booking with real-time availability</li>
                  <li>Weather alerts &amp; route-aware forecasts along your trip</li>
                </ul>
                <p>Manage your subscription anytime from your <a href="${billingUrl}">Profile billing page</a>.</p>
                <p>Questions? Reach us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
                <p>Happy travels,<br/>The RoamReady team</p>
              `,
              text: `Hi ${updatedUser.firstName},\n\nYour RoamReady ${tierLabel} subscription is now active — thanks for upgrading!\n\nYou've unlocked:\n  • Unlimited AI trip planning & modifications\n  • Campground booking with real-time availability\n  • Weather alerts & route-aware forecasts along your trip\n\nManage your subscription anytime from your Profile billing page: ${billingUrl}\n\nQuestions? Reach us at ${supportEmail}.\n\nHappy travels,\nThe RoamReady team`,
            })
            console.log('[email] subscription confirmation sent to', updatedUser.email, `(${tierLabel})`)
          } catch (emailErr: any) {
            console.error(
              `[email] subscription confirmation FAILED for userId=${updatedUser.id} email=${updatedUser.email}:`,
              emailErr?.message,
            )
          }
        }
        break
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as any
        const user = await prisma.user.findFirst({ where: { subscriptionId: sub.id } })
        if (user) {
          const priceId = sub.items.data[0]?.price?.id
          const tier = tierFromPriceId(priceId)
          await prisma.user.update({
            where: { id: user.id },
            data: { subscriptionTier: tier, subscriptionEndsAt: new Date(sub.current_period_end * 1000) },
          })
        }
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as any
        const user = await prisma.user.findFirst({ where: { subscriptionId: sub.id } })
        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { subscriptionTier: 'FREE', subscriptionId: null },
          })
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as any
        console.error('Payment failed for customer:', invoice.customer)

        // Look up the user by Stripe customerId so we can email them. Skip
        // silently if there's no match (orphaned customer record, or the
        // invoice predates the user's account in this DB) — better to drop
        // the email than 500 the webhook.
        if (invoice.customer) {
          const user = await prisma.user.findFirst({
            where: { customerId: invoice.customer as string },
          })
          if (user) {
            const billingUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/profile/billing`
            try {
              await resend.emails.send({
                from: process.env.FROM_EMAIL!,
                reply_to: replyToEmail,
                to: user.email,
                subject: "We couldn't process your RoamReady payment",
                html: `
                  <p>Hi ${user.firstName},</p>
                  <p>We tried to charge the card on file for your most recent RoamReady subscription payment, but the charge didn't go through.</p>
                  <p>Your access continues during a short grace period (typically about three weeks) while Stripe automatically retries the charge. To avoid any interruption, please update your payment method on your <a href="${billingUrl}">Profile billing page</a>.</p>
                  <p>Don't worry — your trips, rigs, and travel data are all safe. Nothing has been deleted, and your saved plans will be waiting for you when payment is restored.</p>
                  <p>Need help? Contact us at <a href="mailto:${billingEmail}">${billingEmail}</a> or update your payment method from your <a href="${billingUrl}">Profile</a>.</p>
                  <p>The RoamReady team</p>
                `,
                text: `Hi ${user.firstName},\n\nWe tried to charge the card on file for your most recent RoamReady subscription payment, but the charge didn't go through.\n\nYour access continues during a short grace period (typically about three weeks) while Stripe automatically retries the charge. To avoid any interruption, please update your payment method here: ${billingUrl}\n\nDon't worry — your trips, rigs, and travel data are all safe. Nothing has been deleted, and your saved plans will be waiting for you when payment is restored.\n\nNeed help? Contact us at ${billingEmail} or update your payment method at ${billingUrl}.\n\nThe RoamReady team`,
              })
              console.log('[email] payment-failed notice sent to', user.email)
            } catch (emailErr: any) {
              console.error(
                `[email] payment-failed notice FAILED for userId=${user.id} email=${user.email}:`,
                emailErr?.message,
              )
            }
          }
        }
        break
      }
    }

    res.json({ received: true })
  } catch (err) { next(err) }
}

export async function getInvoices(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!user?.customerId) return res.json([])

    const invoices = await stripe.invoices.list({ customer: user.customerId, limit: 12 })
    res.json(invoices.data.map(inv => ({
      id: inv.id,
      amount: inv.amount_paid,
      currency: inv.currency,
      status: inv.status,
      date: new Date(inv.created * 1000),
      pdf: inv.invoice_pdf,
    })))
  } catch (err) { next(err) }
}
