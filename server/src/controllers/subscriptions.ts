import { Request, Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { stripe, createStripeCustomer, createCheckoutSession, createPortalSession } from '../services/stripe'

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
          await prisma.user.update({
            where: { id: userId },
            data: {
              subscriptionId: session.subscription,
              subscriptionTier: tier,
            },
          })
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
        // TODO: send email via Resend
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
