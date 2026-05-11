import { Router } from 'express'
import { requireAuth, requireFeature } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { getResources } from '../controllers/resources'

export const resourcesRouter = Router()
resourcesRouter.use(requireAuth, requireVerifiedEmail)
resourcesRouter.get('/', requireFeature('resourcesAlongRoute'), getResources as any)
