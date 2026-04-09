import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { searchCampgrounds, getCampground, getCompatible, getMilitary, getOhv, getVan, getCarCamping } from '../controllers/campgrounds'

export const campgroundsRouter = Router()
campgroundsRouter.use(requireAuth)

campgroundsRouter.get('/search', searchCampgrounds as any)
campgroundsRouter.get('/compatible', getCompatible as any)
campgroundsRouter.get('/military', getMilitary as any)
campgroundsRouter.get('/ohv', getOhv as any)
campgroundsRouter.get('/van', getVan as any)
campgroundsRouter.get('/car-camping', getCarCamping as any)
campgroundsRouter.get('/:id', getCampground as any)
