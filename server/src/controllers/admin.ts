import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { stripe } from '../services/stripe'
import { analyzeFeedbackAI } from '../services/ai'

export async function getMetrics(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const [totalUsers, proUsers, proPlusUsers, totalTrips, completedTrips] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { subscriptionTier: 'PRO' } }),
      prisma.user.count({ where: { subscriptionTier: 'PRO_PLUS' } }),
      prisma.trip.count(),
      prisma.trip.count({ where: { status: 'COMPLETED' } }),
    ])

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const newUsers = await prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } })

    res.json({
      totalUsers,
      proUsers,
      proPlusUsers,
      freeUsers: totalUsers - proUsers - proPlusUsers,
      totalTrips,
      completedTrips,
      newUsersLast30Days: newUsers,
    })
  } catch (err) { next(err) }
}

export async function getSubscribers(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const subscribers = await prisma.user.findMany({
      where: { subscriptionTier: { not: 'FREE' } },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        subscriptionTier: true, subscriptionEndsAt: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })
    res.json(subscribers)
  } catch (err) { next(err) }
}

export async function getRevenue(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.includes('placeholder')) {
      return res.json({ message: 'Stripe not configured', mrr: 0, arr: 0 })
    }

    const charges = await stripe.charges.list({ limit: 100 })
    const totalRevenue = charges.data.reduce((sum, c) => sum + (c.amount_captured || 0), 0) / 100

    const proCount = await prisma.user.count({ where: { subscriptionTier: 'PRO' } })
    const proPlusCount = await prisma.user.count({ where: { subscriptionTier: 'PRO_PLUS' } })

    res.json({
      totalRevenue,
      mrr: (proCount * 8.99) + (proPlusCount * 12.99),
      arr: ((proCount * 8.99) + (proPlusCount * 12.99)) * 12,
      proSubscribers: proCount,
      proPlusSubscribers: proPlusCount,
    })
  } catch (err) { next(err) }
}

export async function getAdminFeedback(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const feedback = await prisma.feedback.findMany({
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
      orderBy: [{ votes: 'desc' }, { createdAt: 'desc' }],
    })
    res.json(feedback)
  } catch (err) { next(err) }
}

export async function analyzeFeedback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const feedbackItems = await prisma.feedback.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    const analysis = await analyzeFeedbackAI(feedbackItems, { userId: req.user!.id })
    res.json({ analysis })
  } catch (err) { next(err) }
}
