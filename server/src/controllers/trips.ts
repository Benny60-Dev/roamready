import { Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { generatePackingListAI, generateTripItineraryAI, generateRouteStringsAI, generateStopActivitiesAI } from '../services/ai'

export async function getTrips(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trips = await prisma.trip.findMany({
      where: { userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    })
    res.json(trips)
  } catch (err) { next(err) }
}

export async function createTrip(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const {
      rigId, name, status, startLocation, endLocation,
      startDate, endDate, totalMiles, totalNights,
      estimatedFuel, estimatedCamp, actualFuel, actualCamp,
      fuelPrice, packingList, aiConversation,
    } = req.body

    console.log('[createTrip] user=%s name=%s', req.user!.id, name)

    const trip = await prisma.trip.create({
      data: {
        rigId, name, status, startLocation, endLocation,
        startDate, endDate, totalMiles, totalNights,
        estimatedFuel, estimatedCamp, actualFuel, actualCamp,
        fuelPrice, packingList, aiConversation,
        userId: req.user!.id,
      },
      include: { stops: true },
    })
    console.log('[createTrip] created trip id=%s', trip.id)
    res.status(201).json(trip)
  } catch (err: any) {
    console.error('[createTrip] FAILED:', err?.message)
    next(err)
  }
}

export async function getTrip(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' }, include: { journalEntry: true } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)
    res.json(trip)
  } catch (err) { next(err) }
}

export async function updateTrip(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)
    const updated = await prisma.trip.update({ where: { id: req.params.id }, data: req.body })
    res.json(updated)
  } catch (err) { next(err) }
}

export async function deleteTrip(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)
    await prisma.trip.delete({ where: { id: req.params.id } })
    res.json({ message: 'Trip deleted' })
  } catch (err) { next(err) }
}

export async function getStops(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)
    const stops = await prisma.stop.findMany({
      where: { tripId: req.params.id },
      orderBy: { order: 'asc' },
      include: { journalEntry: true },
    })
    res.json(stops)
  } catch (err) { next(err) }
}

export async function createStop(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)

    const maxOrder = await prisma.stop.aggregate({
      where: { tripId: req.params.id },
      _max: { order: true },
    })
    const order = (maxOrder._max.order ?? 0) + 1

    // Whitelist only known Stop fields — AI response may include extras like `notes`
    // that don't exist in the schema and would cause a Prisma validation error
    const {
      type: rawType, locationName, locationState, latitude, longitude,
      arrivalDate, departureDate, nights, campgroundName, campgroundId,
      bookingStatus: rawBookingStatus, confirmationNum, siteRate, estimatedFuel, hookupType,
      isPetFriendly, isMilitaryOnly, isCompatible: rawIsCompatible,
      incompatibilityReasons, alternates, weatherForecast,
      notes, checkInTime, checkOutTime, siteNumber,
    } = req.body

    // Map any invalid stop type to a valid enum value
    const VALID_STOP_TYPES = ['DESTINATION', 'OVERNIGHT_ONLY', 'HOME'] as const
    let type: typeof VALID_STOP_TYPES[number] = VALID_STOP_TYPES.includes(rawType) ? rawType : 'DESTINATION'
    if (rawType !== type) {
      console.warn('[createStop] Remapped invalid stop type %s → DESTINATION', rawType)
    }

    // First stop (order=1) and last stop can never be OVERNIGHT_ONLY
    // Check last-stop condition: if the current stop's order equals the max existing order (after increment)
    // we detect first stop directly; last-stop guard is also applied here as a heuristic when the
    // AI mistakenly assigns OVERNIGHT_ONLY to what it has marked as the route terminus.
    if (order === 1 && type === 'OVERNIGHT_ONLY') {
      console.warn('[createStop] order=1 stop cannot be OVERNIGHT_ONLY — overriding to DESTINATION')
      type = 'DESTINATION'
    }

    // Last-stop enforcement for OVERNIGHT_ONLY is handled by:
    //   1. The client (NewTripPage) which fixes first/last before calling this endpoint
    //   2. The startup migration in index.ts which corrects any existing bad data

    // Apply safe defaults for fields the AI sometimes omits
    const bookingStatus = rawBookingStatus ?? 'NOT_BOOKED'
    const isCompatible = rawIsCompatible ?? true

    console.log('[createStop] tripId=%s locationName=%s type=%s order=%d', req.params.id, locationName, type, order)

    const stop = await prisma.stop.create({
      data: {
        type, locationName, locationState, latitude, longitude,
        arrivalDate, departureDate, nights, campgroundName, campgroundId,
        bookingStatus, confirmationNum, siteRate, estimatedFuel, hookupType,
        isPetFriendly, isMilitaryOnly, isCompatible,
        incompatibilityReasons, alternates, weatherForecast,
        notes, checkInTime, checkOutTime, siteNumber,
        tripId: req.params.id,
        order,
      },
    })
    res.status(201).json(stop)
  } catch (err: any) {
    console.error('[createStop] FAILED tripId=%s:', req.params.id, err?.message)
    next(err)
  }
}

export async function updateStop(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)
    const stop = await prisma.stop.findFirst({ where: { id: req.params.stopId, tripId: req.params.id } })
    if (!stop) throw new AppError('Stop not found', 404)

    const {
      type, locationName, locationState, latitude, longitude,
      arrivalDate, departureDate, nights, campgroundName, campgroundId,
      bookingStatus, confirmationNum, siteRate, estimatedFuel, hookupType,
      isPetFriendly, isMilitaryOnly, isCompatible,
      incompatibilityReasons, alternates, weatherForecast,
      notes, checkInTime, checkOutTime, siteNumber,
    } = req.body

    const updated = await prisma.stop.update({
      where: { id: req.params.stopId },
      data: {
        type, locationName, locationState, latitude, longitude,
        arrivalDate, departureDate, nights, campgroundName, campgroundId,
        bookingStatus, confirmationNum, siteRate, estimatedFuel, hookupType,
        isPetFriendly, isMilitaryOnly, isCompatible,
        incompatibilityReasons, alternates, weatherForecast,
        notes, checkInTime, checkOutTime, siteNumber,
      },
    })
    res.json(updated)
  } catch (err: any) {
    console.error('[updateStop] FAILED stopId=%s:', req.params.stopId, err?.message)
    next(err)
  }
}

export async function deleteStop(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)
    await prisma.stop.delete({ where: { id: req.params.stopId } })
    res.json({ message: 'Stop deleted' })
  } catch (err) { next(err) }
}

export async function getSharedTrip(req: Request, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { sharedToken: req.params.token },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Shared trip not found', 404)
    res.json(trip)
  } catch (err) { next(err) }
}

export async function exportPdf(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    if (!req.user?.id) throw new AppError('Unauthorized', 401)

    // Generate share token if not exists
    if (!trip.sharedToken) {
      await prisma.trip.update({ where: { id: trip.id }, data: { sharedToken: uuidv4() } })
    }

    res.json({ message: 'PDF export initiated', tripId: trip.id })
  } catch (err) { next(err) }
}

export async function generateItinerary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: true },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { rigs: { where: { isDefault: true } }, travelProfile: true },
    })

    const itinerary = await generateTripItineraryAI(trip, user)

    await prisma.trip.update({ where: { id: trip.id }, data: { itinerary } })

    res.json(itinerary)
  } catch (err) { next(err) }
}

export async function saveItinerary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)
    const updated = await prisma.trip.update({ where: { id: req.params.id }, data: { itinerary: req.body } })
    res.json(updated.itinerary)
  } catch (err) { next(err) }
}

export async function generateRoutes(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)
    const routes = await generateRouteStringsAI(trip)
    res.json(routes)
  } catch (err) { next(err) }
}

export async function generateActivities(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    // Only generate for DESTINATION stops (not HOME or OVERNIGHT_ONLY)
    const destStops = trip.stops
      .filter((s: any) => s.type === 'DESTINATION' && s.nights > 0)
      .map((s: any, i: number) => ({
        stopIdx: i,
        stopId: s.id,
        locationName: s.locationName,
        locationState: s.locationState || undefined,
        nights: s.nights || 1,
      }))

    if (destStops.length === 0) return res.json([])

    const results = await generateStopActivitiesAI(destStops)

    // Return { stopId, activities }[] so client can match by stop id
    const withIds = results.map(r => ({
      stopId: destStops[r.stopIdx]?.stopId,
      activities: r.activities,
    })).filter(r => r.stopId)

    res.json(withIds)
  } catch (err) { next(err) }
}

export async function generatePackingList(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: true },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { rigs: { where: { isDefault: true } }, travelProfile: true },
    })

    const packingList = await generatePackingListAI(trip, user)

    await prisma.trip.update({ where: { id: trip.id }, data: { packingList } })

    res.json(packingList)
  } catch (err) { next(err) }
}
