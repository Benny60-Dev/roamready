import { Request, Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { sendFeedbackNotification, sendFeedbackAcknowledgment } from '../services/feedbackNotification'

export async function submitFeedback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Body already validated + stripped by validateBody(FeedbackSubmitSchema).
    // attachments stay out of the create call — images are never persisted,
    // they only ride the support notification email.
    const { type, title, body, screen, rating, importance, rigType, tripContext, attachments } = req.body
    const feedback = await prisma.feedback.create({
      data: {
        userId: req.user!.id,
        type,
        title,
        body,
        screen,
        rating,
        importance,
        // Explicit, not DB-default-dependent: submissions are private until
        // an admin flips the Public toggle (PATCH /admin/feedback/:id).
        isPublic: false,
        rigType,
        tripContext,
      },
    })

    // Fire-and-forget — an email failure must never fail or delay the 201.
    // Attachment decode is guarded separately: a bad buffer drops the
    // attachments, never the notification itself.
    let emailAttachments: { filename: string; content: Buffer }[] = []
    try {
      emailAttachments = (attachments ?? []).map(
        (a: { filename: string; data: string }) => ({ filename: a.filename, content: Buffer.from(a.data, 'base64') })
      )
    } catch (err) {
      console.error('[feedback] attachment decode failed — sending notification without attachments:', err)
    }
    sendFeedbackNotification(feedback, emailAttachments).catch(err =>
      console.error('[feedback] support notification failed (submission unaffected):', err)
    )
    sendFeedbackAcknowledgment(feedback).catch(err =>
      console.error('[feedback] submitter acknowledgment failed (submission unaffected):', err)
    )

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
