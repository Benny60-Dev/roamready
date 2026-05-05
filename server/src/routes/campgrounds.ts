import { Router } from 'express'
import { requireAuth, requireFeature, AuthRequest } from '../middleware/auth'
import { searchCampgrounds, getCampground, getCompatible, getMilitary, getOhv, getVan, getCarCamping } from '../controllers/campgrounds'

export const campgroundsRouter = Router()
campgroundsRouter.use(requireAuth)

campgroundsRouter.get('/search', requireFeature('campgroundBooking'), searchCampgrounds as any)
campgroundsRouter.get('/compatible', requireFeature('campgroundBooking'), getCompatible as any)
campgroundsRouter.get('/military', requireFeature('militaryCampgrounds'), getMilitary as any)
campgroundsRouter.get('/ohv', requireFeature('ohvDestinations'), getOhv as any)
campgroundsRouter.get('/van', requireFeature('vanDestinations'), getVan as any)
campgroundsRouter.get('/car-camping', getCarCamping as any)
campgroundsRouter.get('/:id', getCampground as any)
