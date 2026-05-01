import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { validateBody } from '../middleware/validate'
import { StopUpdateSchema } from '../schemas'
import { getBookings, createBooking, getBooking, updateBooking, cancelBooking } from '../controllers/bookings'

export const bookingsRouter = Router()
bookingsRouter.use(requireAuth)

bookingsRouter.get('/', getBookings as any)
bookingsRouter.post('/', createBooking as any)
bookingsRouter.get('/:id', getBooking as any)
bookingsRouter.put('/:id', validateBody(StopUpdateSchema), updateBooking as any)
bookingsRouter.post('/:id/cancel', cancelBooking as any)
