import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getResources } from '../controllers/resources'

export const resourcesRouter = Router()
resourcesRouter.use(requireAuth)
resourcesRouter.get('/', getResources as any)
