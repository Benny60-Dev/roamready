import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { getNotifications, updateSettings, markRead, deleteNotification } from '../controllers/notifications'

export const notificationsRouter = Router()
notificationsRouter.use(requireAuth, requireVerifiedEmail)

notificationsRouter.get('/', getNotifications as any)
notificationsRouter.put('/settings', updateSettings as any)
notificationsRouter.post('/:id/read', markRead as any)
notificationsRouter.delete('/:id', deleteNotification as any)
