import { Router } from 'express'
import { requireAuth, requireFeature } from '../middleware/auth'
import { getResources } from '../controllers/resources'

export const resourcesRouter = Router()
resourcesRouter.use(requireAuth)
resourcesRouter.get('/', requireFeature('resourcesAlongRoute'), getResources as any)
