import { Request, Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { stripe, createCheckoutSession, createPortalSession } from '../services/stripe'

export async function createCheckout(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { priceId } = req.body
    if (!priceId) throw new AppError('priceId required', 400)

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!user) throw new AppError('User not found', 404)

    if (!user.customerId) throw new AppError('No Stripe customer found', 400)

    const session = await createCheckoutSession(user.customerId, priceId, user.id)
    res.json({ url: session.url })
  } catch (err) { next(err) }
}

export async function createPortal(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!user?.customerId) throw new AppError('No billing account found', 400)

    const session = await createPortalSession(user.customerId)
    res.json({ url: session.url })
  } catch (err) { next(err) }
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
    const sig = req.headers['stripe-signature'] as string
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!

    let event
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret)
    } catch (err) {
      return res.status(400).send('Webhook signature verification failed')
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as any
        const userId = session.metadata?.userId
        if (userId) {
          await prisma.user.update({
            where: { id: userId },
            data: {
              subscriptionId: session.subscription,
              subscriptionTier: 'PRO',
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
          let tier: 'FREE' | 'PRO' | 'PRO_PLUS' = 'PRO'
          if (priceId === process.env.STRIPE_PROPLUS_MONTHLY_PRICE_ID ||
              priceId === process.env.STRIPE_PROPLUS_ANNUAL_PRICE_ID) {
            tier = 'PRO_PLUS'
          }
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
