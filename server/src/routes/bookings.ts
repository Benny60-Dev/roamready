import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getBookings, createBooking, getBooking, updateBooking, cancelBooking } from '../controllers/bookings'

export const bookingsRouter = Router()
bookingsRouter.use(requireAuth)

bookingsRouter.get('/', getBookings as any)
bookingsRouter.post('/', createBooking as any)
bookingsRouter.get('/:id', getBooking as any)
bookingsRouter.put('/:id', updateBooking as any)
bookingsRouter.post('/:id/cancel', cancelBooking as any)
