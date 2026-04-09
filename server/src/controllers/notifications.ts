import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'

export async function getNotifications(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    res.json(notifications)
  } catch (err) { next(err) }
}

export async function updateSettings(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const settings = req.body as Array<{ type: string; enabled: boolean; method: string[] }>
    const results = await Promise.all(
      settings.map(s =>
        prisma.notificationSetting.upsert({
          where: { id: `${req.user!.id}-${s.type}` },
          update: { enabled: s.enabled, method: s.method },
          create: { id: `${req.user!.id}-${s.type}`, userId: req.user!.id, type: s.type, enabled: s.enabled, method: s.method },
        })
      )
    )
    res.json(results)
  } catch (err) { next(err) }
}

export async function markRead(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user!.id },
      data: { isRead: true },
    })
    res.json({ ok: true })
  } catch (err) { next(err) }
}

export async function deleteNotification(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.notification.deleteMany({
      where: { id: req.params.id, userId: req.user!.id },
    })
    res.json({ ok: true })
  } catch (err) { next(err) }
}
