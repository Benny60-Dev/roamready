import { Router } from 'express'
import { requireAuth, requireFeature } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { validateBody } from '../middleware/validate'
import { StopUpdateSchema } from '../schemas'
import { getBookings, createBooking, getBooking, updateBooking, cancelBooking } from '../controllers/bookings'

export const bookingsRouter = Router()
bookingsRouter.use(requireAuth, requireVerifiedEmail)
// Compute feature: gate the entire router. Bookings is reservation activity,
// not user-authored data — downgraded users lose access to making/editing
// reservations but no personal records get locked away.
bookingsRouter.use(requireFeature('campgroundBooking'))

bookingsRouter.get('/', getBookings as any)
bookingsRouter.post('/', createBooking as any)
bookingsRouter.get('/:id', getBooking as any)
bookingsRouter.put('/:id', validateBody(StopUpdateSchema), updateBooking as any)
bookingsRouter.post('/:id/cancel', cancelBooking as any)
