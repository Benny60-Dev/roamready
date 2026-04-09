import { Request, Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export async function submitFeedback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { type, title, body, screen, rating, importance, isPublic, rigType, tripContext } = req.body
    const feedback = await prisma.feedback.create({
      data: {
        userId: req.user!.id,
        type,
        title,
        body,
        screen,
        rating,
        importance,
        isPublic: isPublic !== false,
        rigType,
        tripContext,
      },
    })
    res.status(201).json(feedback)
  } catch (err) { next(err) }
}

export async function getPublicRoadmap(_req: Request, res: Response, next: NextFunction) {
  try {
    const feedback = await prisma.feedback.findMany({
      where: { isPublic: true, status: { in: ['PLANNED', 'IN_PROGRESS', 'SHIPPED'] } },
      orderBy: [{ votes: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, type: true, title: true, body: true, status: true,
        votes: true, rigType: true, createdAt: true,
      },
    })

    const columns = {
      planned: feedback.filter(f => f.status === 'PLANNED'),
      inProgress: feedback.filter(f => f.status === 'IN_PROGRESS'),
      shipped: feedback.filter(f => f.status === 'SHIPPED'),
    }

    res.json(columns)
  } catch (err) { next(err) }
}

export async function voteFeedback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const feedback = await prisma.feedback.findUnique({ where: { id: req.params.id } })
    if (!feedback) throw new AppError('Feedback not found', 404)

    const voterIds = (feedback.voterIds as string[]) || []
    const userId = req.user!.id

    if (voterIds.includes(userId)) {
      // Remove vote
      await prisma.feedback.update({
        where: { id: req.params.id },
        data: { votes: { decrement: 1 }, voterIds: voterIds.filter(id => id !== userId) },
      })
      return res.json({ voted: false })
    }

    await prisma.feedback.update({
      where: { id: req.params.id },
      data: { votes: { increment: 1 }, voterIds: [...voterIds, userId] },
    })
    res.json({ voted: true })
  } catch (err) { next(err) }
}

export async function getAdminFeedback(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const feedback = await prisma.feedback.findMany({
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    })
    res.json(feedback)
  } catch (err) { next(err) }
}

export async function updateStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { status } = req.body
    const updated = await prisma.feedback.update({
      where: { id: req.params.id },
      data: { status },
    })
    res.json(updated)
  } catch (err) { next(err) }
}
