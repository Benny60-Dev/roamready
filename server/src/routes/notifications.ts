import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getNotifications, updateSettings, markRead, deleteNotification } from '../controllers/notifications'

export const notificationsRouter = Router()
notificationsRouter.use(requireAuth)

notificationsRouter.get('/', getNotifications as any)
notificationsRouter.put('/settings', updateSettings as any)
notificationsRouter.post('/:id/read', markRead as any)
notificationsRouter.delete('/:id', deleteNotification as any)
