import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth'
import {
  getTrips, createTrip, getTrip, updateTrip, deleteTrip,
  getStops, createStop, updateStop, deleteStop,
  getSharedTrip, exportPdf, generatePackingList,
  generateItinerary, saveItinerary, generateRoutes, generateActivities,
  generateRouteHighlights,
} from '../controllers/trips'

export const tripsRouter = Router()

tripsRouter.get('/share/:token', getSharedTrip)

tripsRouter.use(requireAuth)

tripsRouter.get('/', getTrips as any)
tripsRouter.post('/', createTrip as any)
tripsRouter.get('/:id', getTrip as any)
tripsRouter.put('/:id', updateTrip as any)
tripsRouter.delete('/:id', deleteTrip as any)

tripsRouter.get('/:id/stops', getStops as any)
tripsRouter.post('/:id/stops', createStop as any)
tripsRouter.put('/:id/stops/:stopId', updateStop as any)
tripsRouter.delete('/:id/stops/:stopId', deleteStop as any)

tripsRouter.post('/:id/export/pdf', exportPdf as any)
tripsRouter.post('/:id/packing-list', generatePackingList as any)
tripsRouter.post('/:id/itinerary/generate', generateItinerary as any)
tripsRouter.put('/:id/itinerary', saveItinerary as any)
tripsRouter.post('/:id/routes', generateRoutes as any)
tripsRouter.post('/:id/activities/generate', generateActivities as any)
tripsRouter.post('/:id/stops/:stopId/highlights', generateRouteHighlights as any)
