import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getItems, createItem, updateItem, logService, getHistory } from '../controllers/maintenance'

export const maintenanceRouter = Router()
maintenanceRouter.use(requireAuth)

maintenanceRouter.get('/:rigId', getItems as any)
maintenanceRouter.post('/:rigId', createItem as any)
maintenanceRouter.put('/:rigId/:itemId', updateItem as any)
maintenanceRouter.post('/:rigId/:itemId/log', logService as any)
maintenanceRouter.get('/:rigId/history', getHistory as any)
