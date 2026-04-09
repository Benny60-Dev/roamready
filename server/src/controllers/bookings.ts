import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export async function getBookings(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const stops = await prisma.stop.findMany({
      where: {
        trip: { userId: req.user!.id },
        bookingStatus: { not: 'NOT_BOOKED' },
      },
      include: { trip: { select: { name: true } } },
      orderBy: { arrivalDate: 'asc' },
    })
    res.json(stops)
  } catch (err) { next(err) }
}

export async function createBooking(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { stopId, confirmationNum, siteRate, campgroundName, campgroundId } = req.body

    const stop = await prisma.stop.findFirst({
      where: { id: stopId, trip: { userId: req.user!.id } },
    })
    if (!stop) throw new AppError('Stop not found', 404)

    const updated = await prisma.stop.update({
      where: { id: stopId },
      data: {
        bookingStatus: 'CONFIRMED',
        confirmationNum,
        siteRate,
        campgroundName,
        campgroundId,
      },
    })
    res.json(updated)
  } catch (err) { next(err) }
}

export async function getBooking(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const stop = await prisma.stop.findFirst({
      where: { id: req.params.id, trip: { userId: req.user!.id } },
      include: { trip: true, journalEntry: true },
    })
    if (!stop) throw new AppError('Booking not found', 404)
    res.json(stop)
  } catch (err) { next(err) }
}

export async function updateBooking(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const stop = await prisma.stop.findFirst({
      where: { id: req.params.id, trip: { userId: req.user!.id } },
    })
    if (!stop) throw new AppError('Booking not found', 404)

    const updated = await prisma.stop.update({ where: { id: req.params.id }, data: req.body })
    res.json(updated)
  } catch (err) { next(err) }
}

export async function cancelBooking(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const stop = await prisma.stop.findFirst({
      where: { id: req.params.id, trip: { userId: req.user!.id } },
    })
    if (!stop) throw new AppError('Booking not found', 404)

    const updated = await prisma.stop.update({
      where: { id: req.params.id },
      data: { bookingStatus: 'CANCELLED' },
    })
    res.json(updated)
  } catch (err) { next(err) }
}
