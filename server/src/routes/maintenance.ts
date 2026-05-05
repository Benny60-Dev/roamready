import { Router } from 'express'
import { requireAuth, requireFeature } from '../middleware/auth'
import { getItems, createItem, updateItem, logService, getHistory } from '../controllers/maintenance'

export const maintenanceRouter = Router()
maintenanceRouter.use(requireAuth)

// Reads stay open: a downgraded user can still see their own past maintenance
// items and service history. Only writes are gated.
maintenanceRouter.get('/:rigId', getItems as any)
maintenanceRouter.get('/:rigId/history', getHistory as any)
maintenanceRouter.post('/:rigId', requireFeature('maintenanceTracker'), createItem as any)
maintenanceRouter.put('/:rigId/:itemId', requireFeature('maintenanceTracker'), updateItem as any)
maintenanceRouter.post('/:rigId/:itemId/log', requireFeature('maintenanceTracker'), logService as any)
