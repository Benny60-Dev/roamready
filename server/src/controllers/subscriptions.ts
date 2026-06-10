import { Request, Response, NextFunction } from 'express'
import { Resend } from 'resend'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { stripe, createStripeCustomer, createCheckoutSession, createPortalSession } from '../services/stripe'
import { getClientOrigin } from '../utils/clientOrigin'

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

/** Allowlist of price IDs this server is configured to accept. Computed at
 *  request time (rather than module load) so that an env-var change on a
 *  hot-reload or restart is picked up without a code change. Any priceId
 *  arriving in the request body must match one of these — otherwise we
 *  refuse with 503 BILLING_NOT_CONFIGURED before reaching Stripe. This
 *  closes a class of bugs where the client falls back to a placeholder
 *  literal (e.g. from a missing VITE_-prefixed env var on the frontend)
 *  and the server faithfully forwards it, producing a confusing Stripe
 *  "No such price" 500 to the user. */
function configuredPriceIds(): string[] {
  return [
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
    process.env.STRIPE_PRO_ANNUAL_PRICE_ID,
    process.env.STRIPE_PRO_FOUNDER_MONTHLY_PRICE_ID,
    process.env.STRIPE_PRO_FOUNDER_ANNUAL_PRICE_ID,
  ].filter(
    (v): v is string =>
      typeof v === 'string' && v.length > 0 && v.startsWith('price_') && !/placeholder/i.test(v),
  )
}

/** Returns true if `priceId` matches one of the two founder-rate env vars.
 *  Used by createCheckout to enforce that only founder-eligible users can
 *  check out at the founder rate — otherwise a non-founder client could
 *  pick a founder priceId in dev-tools and pay the discounted rate. */
function isFounderPriceId(priceId: string): boolean {
  return (
    priceId === process.env.STRIPE_PRO_FOUNDER_MONTHLY_PRICE_ID ||
    priceId === process.env.STRIPE_PRO_FOUNDER_ANNUAL_PRICE_ID
  )
}

export async function createCheckout(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { priceId } = req.body
    if (!priceId) throw new AppError('priceId required', 400)

    // Defense-in-depth: the priceId must (a) look like a real Stripe price
    // ID, (b) not be a placeholder, and (c) match one of the env-configured
    // tier prices. Any failure here is a 503 (server not configured to
    // service this checkout), which Sentry's setupExpressErrorHandler will
    // capture via next(err). NEVER pass an unvetted string through to Stripe
    // — Stripe's "No such price" 500 is a dead-end UX (the user just sees
    // a generic 500 with no actionable next step).
    const allowed = configuredPriceIds()
    const looksReal = typeof priceId === 'string' && priceId.startsWith('price_') && !/placeholder/i.test(priceId)
    if (!looksReal || !allowed.includes(priceId)) {
      console.error(
        `[Checkout] Refusing to create session — priceId=${JSON.stringify(priceId)} ` +
        `looksReal=${looksReal} matchedConfigured=${allowed.includes(priceId)} ` +
        `configuredCount=${allowed.length}`
      )
      throw new AppError(
        'Billing is not configured for this checkout. Please contact support.',
        503,
        { code: 'BILLING_NOT_CONFIGURED' },
      )
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!user) throw new AppError('User not found', 404)

    // Founder-rate gating: only users whose founderPricing flag is true
    // (set at signup if joined before FOUNDER_CUTOFF_DATE) are allowed to
    // check out at a founder-rate priceId. Without this check, a
    // non-founder could open dev-tools and submit a founder priceId to
    // pay the lower rate. The client also picks the right priceId based
    // on user.founderPricing — this guard is the server-side enforcement.
    //
    // Note: we DO NOT block the inverse (founder client submitting a
    // regular priceId). That's user-side overpayment, not exploit; if a
    // founder's stale client sends a regular priceId, let them through
    // rather than block their upgrade.
    if (isFounderPriceId(priceId) && !(user as any).founderPricing) {
      console.error(
        `[Checkout] Refusing founder-rate checkout for non-founder userId=${user.id} ` +
        `priceId=${priceId}`
      )
      throw new AppError(
        'Founder pricing is not available for this account.',
        403,
        { code: 'FOUNDER_INELIGIBLE' },
      )
    }

    // Hybrid trial model: the 7-day trial is purely app-side (granted at
    // signup via trialEndsAt). Stripe charges immediately on checkout — no
    // Stripe-side trial. There's nothing to compute or branch on here:
    // every checkout that reaches this controller results in a real charge.

    // On-demand customer creation. Signup no longer pre-creates Stripe
    // customers (auth.ts + passport.ts), so the user's customerId is null
    // on first checkout — create it here and persist for future requests.
    // Also covers any legacy account whose signup-time creation failed.
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

/** Map a Stripe priceId to our internal tier. PRO is currently the
 *  only paid tier so this helper always returns 'PRO' today —
 *  but it is intentionally kept as a function (rather than inlined) so a
 *  future tier addition is a one-place edit.
 *
 *  Unrecognized priceIds still log loudly because they indicate a config
 *  gap (Stripe Dashboard out of sync with .env) that we want visible in
 *  webhook logs. We return 'PRO' anyway because Stripe just successfully
 *  charged the user — failing the tier assignment would leave a paying
 *  customer on FREE, which is worse than over-granting Pro.
 */
function tierFromPriceId(priceId: string | null | undefined): 'PRO' {
  if (
    priceId === process.env.STRIPE_PRO_MONTHLY_PRICE_ID ||
    priceId === process.env.STRIPE_PRO_ANNUAL_PRICE_ID
  ) {
    return 'PRO'
  }
  console.error(
    `[StripeWebhook] tierFromPriceId: unrecognized priceId=${priceId} — ` +
    `defaulting to PRO. Check STRIPE_PRO_MONTHLY_PRICE_ID / STRIPE_PRO_ANNUAL_PRICE_ID ` +
    `env vars match the Stripe dashboard.`
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
          // Retrieve the subscription so we can derive the tier from its
          // priceId. With only PRO as a paid tier today, tierFromPriceId
          // always returns 'PRO' — but the indirection stays so a future
          // tier addition is a single-helper edit.
          const sub = await stripe.subscriptions.retrieve(session.subscription as string)
          const priceId = sub.items.data[0]?.price?.id
          const tier = tierFromPriceId(priceId)

          // Eagerly compute subscriptionEndsAt from the same subscription
          // object we just retrieved (no additional Stripe call). Previously
          // this field was only written by customer.subscription.updated,
          // which races with this handler — the BillingPage subtext would
          // briefly fall through to a "no active subscription" message for
          // freshly-paid users between the two webhook deliveries. Writing
          // it here closes that window. Wrap the read in try/catch so an
          // unexpected shape on the Stripe response doesn't break the
          // user.update — subscription.updated will still write it on its
          // next delivery as a fallback.
          let periodEnd: Date | null = null
          try {
            const cpe = (sub as any).current_period_end
            if (typeof cpe === 'number' && cpe > 0) {
              periodEnd = new Date(cpe * 1000)
            }
          } catch (err: any) {
            console.error(
              `[StripeWebhook] failed to read current_period_end for sub=${session.subscription}; ` +
              `subscription.updated will populate it instead:`,
              err?.message ?? err,
            )
          }

          // .update returns the updated row — capture it instead of a separate
          // findUnique so we have email + firstName for the confirmation email
          // without a second round trip.
          const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: {
              subscriptionId: session.subscription,
              subscriptionTier: tier,
              // Clear the app-side trial — once the user has actually paid,
              // the in-app "Trial active — X days left" banner should stop
              // showing. trialEndsAt is the SOURCE OF TRUTH for that banner.
              // We set it to null on FIRST successful checkout; subsequent
              // renewals (subscription.updated) leave it null since it was
              // already cleared here.
              trialEndsAt: null,
              // null is acceptable here — subscription.updated will populate
              // it on its own delivery if we couldn't compute it above.
              subscriptionEndsAt: periodEnd,
            },
          })

          // Confirmation email. Fire-and-log: webhook MUST return 200 even if
          // Resend is down, otherwise Stripe retries and we'd re-process the
          // tier update (idempotent, but still wasteful) — and we'd never
          // hand control back to Stripe at all if Resend hangs. Catch keeps
          // the response path clean.
          // tierFromPriceId currently always returns 'PRO'; the display
          // label stays as a const so re-introducing a second tier means
          // a single-line ternary edit here.
          const tierLabel = 'Pro'
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
          // Dual-shape period read: pre-basil API versions (< 2025-03-31)
          // carry current_period_end at the subscription's top level;
          // post-basil payloads moved it to items.data[].current_period_end.
          // Webhook payload shape follows the SENDER's API version (CLI /
          // dashboard endpoint), not our pinned client apiVersion, so we
          // must accept both. The top-level-only read made new Date(NaN)
          // throw inside prisma.user.update — a 500 on exactly the
          // matched-user path.
          const cpe = sub.current_period_end
            ?? sub.items?.data?.[0]?.current_period_end
          const hasPeriodEnd = typeof cpe === 'number' && cpe > 0
          if (!hasPeriodEnd) {
            // OMIT subscriptionEndsAt rather than writing null — the
            // existing value drives the paid-through grace period
            // (middleware/auth.ts).
            console.warn(
              `[StripeWebhook] subscription.updated missing current_period_end (both shapes) for sub ${sub.id}`
            )
          }
          await prisma.user.update({
            where: { id: user.id },
            data: {
              subscriptionTier: tier,
              ...(hasPeriodEnd ? { subscriptionEndsAt: new Date(cpe * 1000) } : {}),
            },
          })
        }
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as any
        const user = await prisma.user.findFirst({ where: { subscriptionId: sub.id } })
        if (user) {
          // ToS forfeiture (Founding Member Pricing): a founder who
          // VOLUNTARILY cancels loses the founder rate — demoting the flag
          // here automatically aligns the client price display, the client
          // price-ID selection, and the FOUNDER_INELIGIBLE checkout guard,
          // since they all key off user.founderPricing. Involuntary churn
          // (payment_failed / payment_disputed / reason absent) keeps the
          // rate; Stripe marks voluntary portal/API cancellations with
          // cancellation_details.reason === 'cancellation_requested'.
          // subscriptionEndsAt is intentionally untouched (paid-through
          // grace period, see middleware/auth.ts).
          const forfeitsFounderRate =
            (user as any).founderPricing === true &&
            sub.cancellation_details?.reason === 'cancellation_requested'
          await prisma.user.update({
            where: { id: user.id },
            // Cast matches auth.ts: the generated Prisma client may be stale
            // (DLL lock prevents regenerate while the dev server runs); the
            // DB columns exist via the migration.
            data: {
              subscriptionTier: 'FREE',
              subscriptionId: null,
              ...(forfeitsFounderRate
                ? { founderPricing: false, founderRateForfeitedAt: new Date() }
                : {}),
            } as any,
          })
          if (forfeitsFounderRate) {
            console.log(
              `[StripeWebhook] founder rate forfeited for userId=${user.id} ` +
              `(voluntary cancellation, sub=${sub.id})`
            )
          }
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
