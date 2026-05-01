import { Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import type { StopUpdateInput } from '../schemas'
import { generatePackingListAI, generateTripItineraryAI, generateStopActivitiesAI, generateRouteHighlightsAI } from '../services/ai'
import { fetchLiveForecast, fetchHistoricalWeather, isoDate } from '../services/weatherFetch'

// ─── Stop order helpers ───────────────────────────────────────────────────────

/** Re-number all stops for a trip to 1, 2, 3, … in their current relative order.
 *  Runs after any create/update/delete so fractional midpoint orders never accumulate. */
async function resequenceStops(tripId: string): Promise<void> {
  const stops = await prisma.stop.findMany({
    where: { tripId },
    orderBy: { order: 'asc' },
    select: { id: true },
  })
  await prisma.$transaction(
    stops.map((s, i) => prisma.stop.update({ where: { id: s.id }, data: { order: i + 1 } }))
  )
}

// ─── Google Maps Directions helpers ──────────────────────────────────────────

const DIR_MAP: Record<string, string> = { N: 'North', S: 'South', E: 'East', W: 'West' }

/** Strip HTML tags from a Google Maps instruction string. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Walk Directions API steps and pull out every unique highway/interstate name
 * in travel order.  Returns a formatted string like:
 *   "SR-202 East → I-17 North → US-89 North"
 */
function parseHighwaysFromSteps(steps: any[]): string {
  const highways: string[] = []

  for (const step of steps) {
    const html: string = step.html_instructions || ''

    // Google Maps wraps road names in <b> tags
    const boldMatches = [...html.matchAll(/<b>([^<]+)<\/b>/g)]

    for (const m of boldMatches) {
      const text = m[1].trim()

      // Match highway designations: I-40, US-89, SR-260, AZ-89, CO-128, etc.
      const hwMatch = text.match(/^(I-\d+|US-\d+|SR-\d+|[A-Z]{2,3}-\d+)\s*([NSEW])?/i)
      if (!hwMatch) continue

      const hwName = hwMatch[1].toUpperCase()
      const dirChar = hwMatch[2]?.toUpperCase()

      // Direction: from road name suffix, or fall back to instruction text
      let direction = dirChar ? DIR_MAP[dirChar] : null
      if (!direction) {
        const plain = stripHtml(html).toLowerCase()
        if (plain.includes('north')) direction = 'North'
        else if (plain.includes('south')) direction = 'South'
        else if (plain.includes('east')) direction = 'East'
        else if (plain.includes('west')) direction = 'West'
      }

      const formatted = direction ? `${hwName} ${direction}` : hwName

      // Deduplicate: skip if it is the same highway as the last entry
      if (highways.length === 0 || highways[highways.length - 1] !== formatted) {
        highways.push(formatted)
      }
    }
  }

  return highways.join(' → ')
}

/**
 * Fetch the real highway route for every consecutive stop pair in a trip
 * using the Google Maps Directions HTTP API.
 */
async function fetchAllSegmentRoutes(
  trip: any,
): Promise<{ segmentIdx: number; route: string }[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    console.warn('[fetchAllSegmentRoutes] GOOGLE_MAPS_API_KEY not set — skipping real routes')
    return []
  }

  const stops: any[] = [...(trip.stops || [])].sort((a: any, b: any) => a.order - b.order)
  const results: { segmentIdx: number; route: string }[] = []

  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1]
    const to   = stops[i]

    const origin = from.latitude && from.longitude
      ? `${from.latitude},${from.longitude}`
      : `${from.locationName}${from.locationState ? ', ' + from.locationState : ''}`
    const destination = to.latitude && to.longitude
      ? `${to.latitude},${to.longitude}`
      : `${to.locationName}${to.locationState ? ', ' + to.locationState : ''}`

    try {
      const res = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
        params: { origin, destination, key: apiKey },
        timeout: 10000,
      })

      const data = res.data
      if (data.status !== 'OK' || !data.routes?.[0]) {
        console.warn('[fetchAllSegmentRoutes] Directions API status=%s for segment %d', data.status, i - 1)
        results.push({ segmentIdx: i - 1, route: '' })
        continue
      }

      const steps = (data.routes[0].legs as any[]).flatMap((leg: any) => leg.steps)
      const route = parseHighwaysFromSteps(steps)
      console.log('[fetchAllSegmentRoutes] segment %d route: %s', i - 1, route)
      results.push({ segmentIdx: i - 1, route })
    } catch (err: any) {
      console.error('[fetchAllSegmentRoutes] segment %d error:', i - 1, err?.message)
      results.push({ segmentIdx: i - 1, route: '' })
    }
  }

  return results
}

// ─── POI geocoding helpers ────────────────────────────────────────────────────

function pointToSegmentDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
  latP: number, lngP: number,
): number {
  const cosLat = Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180))
  const dx = lat2 - lat1
  const dy = (lng2 - lng1) * cosLat
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(latP - lat1, (lngP - lng1) * cosLat)
  const t = Math.max(0, Math.min(1,
    ((latP - lat1) * dx + (lngP - lng1) * cosLat * dy) / lenSq
  ))
  return Math.hypot(latP - lat1 - t * dx, (lngP - lng1 - t * (lng2 - lng1)) * cosLat)
}

async function geocodeQuery(query: string, apiKey: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: query, key: apiKey },
      timeout: 5000,
    })
    if (res.data.status === 'OK' && res.data.results?.[0]) {
      const loc = res.data.results[0].geometry.location
      return { lat: loc.lat, lng: loc.lng }
    }
    console.warn('[geocode] status=%s for "%s"', res.data.status, query)
    return null
  } catch (err: any) {
    console.error('[geocode] error for "%s":', query, err?.message)
    return null
  }
}

export async function reassignPOIs(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) {
      console.warn('[reassignPOIs] GOOGLE_MAPS_API_KEY not set — skipping')
      return res.json({ skipped: true })
    }

    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const stops = trip.stops as any[]

    const hasPOIs = stops.some((s: any) => (s.pointsOfInterest ?? []).length > 0)
    if (!hasPOIs) return res.json({ skipped: true })

    // Resolve coordinates for all stops in parallel — use DB value if present, geocode city otherwise
    const stopCoords = await Promise.all(
      stops.map(async (stop: any) => {
        if (stop.latitude && stop.longitude) {
          return { id: stop.id, order: stop.order, lat: stop.latitude as number, lng: stop.longitude as number }
        }
        const query = [stop.locationName, stop.locationState].filter(Boolean).join(', ')
        const coords = await geocodeQuery(query, apiKey)
        return { id: stop.id, order: stop.order, lat: coords?.lat ?? null, lng: coords?.lng ?? null }
      })
    )

    // Build drive legs from consecutive stops that both have coordinates
    interface Leg { fromLat: number; fromLng: number; toStopId: string; toLat: number; toLng: number }
    const legs: Leg[] = []
    for (let i = 1; i < stopCoords.length; i++) {
      const from = stopCoords[i - 1]
      const to   = stopCoords[i]
      if (from.lat && from.lng && to.lat && to.lng) {
        legs.push({ fromLat: from.lat, fromLng: from.lng, toStopId: to.id, toLat: to.lat, toLng: to.lng })
      }
    }

    if (legs.length < 2) {
      console.log('[reassignPOIs] fewer than 2 resolvable legs — skipping')
      return res.json({ skipped: true })
    }

    // Geocode all POIs across all stops in parallel
    const poiTasks: Array<{ poi: { name: string; durationMinutes: number }; originalStopId: string }> = stops.flatMap((stop: any) =>
      (stop.pointsOfInterest ?? []).map((poi: any) => ({ poi, originalStopId: stop.id }))
    )

    const poiCoords = await Promise.all(
      poiTasks.map(({ poi }) => geocodeQuery(poi.name, apiKey))
    )

    // Assign each POI to the destination stop of the nearest leg
    const reassigned: Record<string, any[]> = {}

    poiTasks.forEach(({ poi, originalStopId }, idx) => {
      const coords = poiCoords[idx]

      if (!coords) {
        console.warn('[reassignPOIs] could not geocode "%s" — keeping on original stop', poi.name)
        reassigned[originalStopId] = [...(reassigned[originalStopId] ?? []), poi]
        return
      }

      let bestStopId = originalStopId
      let minDist = Infinity
      for (const leg of legs) {
        const dist = pointToSegmentDistance(leg.fromLat, leg.fromLng, leg.toLat, leg.toLng, coords.lat, coords.lng)
        if (dist < minDist) { minDist = dist; bestStopId = leg.toStopId }
      }

      console.log('[reassignPOIs] "%s" → stopId=%s (dist=%.5f)', poi.name, bestStopId, minDist)
      reassigned[bestStopId] = [...(reassigned[bestStopId] ?? []), poi]
    })

    // Write updated pointsOfInterest back to all stops in parallel
    await Promise.all(
      stops.map((stop: any) =>
        prisma.stop.update({
          where: { id: stop.id },
          data: { pointsOfInterest: reassigned[stop.id] ?? [] },
        })
      )
    )

    res.json({ reassigned })
  } catch (err) { next(err) }
}

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
    // Caller may send a fractional midpoint; round to nearest int so it never breaks the Int column.
    let order = Math.round(req.body.order ?? (maxOrder._max.order ?? 0) + 1)

    // Fix 2: HOME stop guard — never allow inserting at or before the HOME stop's position.
    // The HOME stop is the departure point and must always be order 1.
    const homeStopForGuard = await prisma.stop.findFirst({
      where: { tripId: req.params.id, type: 'HOME' },
      select: { order: true },
    })
    if (homeStopForGuard && order <= homeStopForGuard.order) {
      order = homeStopForGuard.order + 1
      console.warn('[createStop] Clamped insertion order to %d — cannot place stop before HOME', order)
    }

    // Whitelist only known Stop fields — AI response may include extras like `notes`
    // that don't exist in the schema and would cause a Prisma validation error
    const {
      type: rawType, locationName, locationState, latitude, longitude,
      arrivalDate, departureDate, nights, campgroundName, campgroundId,
      bookingStatus: rawBookingStatus, confirmationNum, siteRate, estimatedFuel, hookupType,
      isPetFriendly, isMilitaryOnly, isCompatible: rawIsCompatible,
      incompatibilityReasons, alternates, weatherForecast,
      notes, checkInTime, checkOutTime, siteNumber, pointsOfInterest,
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

    // Fetch user's exact home coordinates — used to pin HOME stops precisely instead
    // of geocoding the city name (which resolves to city center, not the street address).
    const homeOwner = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { homeLat: true, homeLng: true },
    })
    const exactHomeLat = homeOwner?.homeLat ?? null
    const exactHomeLng = homeOwner?.homeLng ?? null
    console.log('[createStop:homeCoords] userId=%s homeLat=%s homeLng=%s', req.user!.id, exactHomeLat, exactHomeLng)

    // If this is the first stop being added and it is NOT a HOME stop,
    // automatically prepend a HOME stop using the trip's starting location.
    if (order === 1 && type !== 'HOME' && (trip as any).startLocation) {
      const raw: string = (trip as any).startLocation
      const commaIdx = raw.indexOf(',')
      const homeName  = commaIdx >= 0 ? raw.slice(0, commaIdx).trim() : raw.trim()
      const homeState = commaIdx >= 0 ? raw.slice(commaIdx + 1).trim() : null
      console.log('[createStop] First stop is not HOME — auto-creating HOME stop for startLocation=%s', raw)
      await prisma.stop.create({
        data: {
          type: 'HOME',
          locationName: homeName,
          locationState: homeState,
          latitude: exactHomeLat,
          longitude: exactHomeLng,
          nights: 0,
          bookingStatus: 'NOT_BOOKED',
          isCompatible: true,
          tripId: req.params.id,
          order: 1,
        },
      })
      order = 2
    }

    // Last-stop enforcement for OVERNIGHT_ONLY is handled by:
    //   1. The client (NewTripPage) which fixes first/last before calling this endpoint
    //   2. The startup migration in index.ts which corrects any existing bad data

    // Apply safe defaults for fields the AI sometimes omits
    const bookingStatus = rawBookingStatus ?? 'NOT_BOOKED'
    const isCompatible = rawIsCompatible ?? true

    // For HOME stops, always use the user's exact home coordinates (if available) so the
    // marker lands on the street address rather than the city center returned by geocoding.
    const resolvedLat = (type === 'HOME' && exactHomeLat != null) ? exactHomeLat : (latitude ?? null)
    const resolvedLng = (type === 'HOME' && exactHomeLng != null) ? exactHomeLng : (longitude ?? null)

    console.log('[createStop] tripId=%s locationName=%s type=%s order=%d incomingLat=%s incomingLng=%s resolvedLat=%s resolvedLng=%s',
      req.params.id, locationName, type, order, latitude, longitude, resolvedLat, resolvedLng)

    // Fix 1: Integer shift-up — bump every existing stop at the target position (and above) up by 1
    // so the new stop slots in cleanly without fractional orders or collisions on the Int column.
    await prisma.stop.updateMany({
      where: { tripId: req.params.id, order: { gte: order } },
      data: { order: { increment: 1 } },
    })

    const stop = await prisma.stop.create({
      data: {
        type, locationName, locationState, latitude: resolvedLat, longitude: resolvedLng,
        arrivalDate, departureDate, nights, campgroundName, campgroundId,
        bookingStatus, confirmationNum, siteRate, estimatedFuel, hookupType,
        isPetFriendly, isMilitaryOnly, isCompatible,
        incompatibilityReasons, alternates, weatherForecast,
        notes, checkInTime, checkOutTime, siteNumber, pointsOfInterest,
        tripId: req.params.id,
        order,
      },
    })
    await resequenceStops(req.params.id)
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

    // req.body has been parsed and stripped by validateBody(StopUpdateSchema) on the route,
    // so unknown keys (incl. id, tripId, type, createdAt, updatedAt) cannot reach Prisma.
    // Pull routeHighlights out of the data object — it goes through a raw-SQL fallback below.
    const body: StopUpdateInput = req.body
    const { routeHighlights, ...data } = body

    // Reservation Honesty: when a stop is being unbooked, force-clear the user-entered
    // reservation detail fields so stale data can't leak across rebook cycles. Overrides
    // anything the client may have sent for these fields in the same request.
    if (data.bookingStatus === 'NOT_BOOKED') {
      data.confirmationNum = null
      data.siteNumber = null
      data.checkInTime = null
      data.checkOutTime = null
      data.notes = null
    }

    const updated = await prisma.stop.update({
      where: { id: req.params.stopId },
      data,
    })

    // routeHighlights requires raw SQL until prisma generate is run after db push
    if (routeHighlights !== undefined) {
      await prisma.$executeRaw`UPDATE "Stop" SET "routeHighlights" = ${routeHighlights} WHERE id = ${req.params.stopId}`
    }

    await resequenceStops(req.params.id)
    res.json(updated)
  } catch (err) { next(err) }
}

export async function deleteStop(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)
    await prisma.stop.delete({ where: { id: req.params.stopId } })
    await resequenceStops(req.params.id)
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

export async function getTripMapImage(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const [trip, user] = await Promise.all([
      prisma.trip.findFirst({
        where: { id: req.params.id, userId: req.user!.id },
        include: { stops: { orderBy: { order: 'asc' } } },
      }),
      prisma.user.findUnique({ where: { id: req.user!.id }, select: { homeCity: true, homeState: true, homeLocation: true } }),
    ])
    if (!trip) throw new AppError('Trip not found', 404)

    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) throw new AppError('Google Maps API key not configured', 500)

    const stops = trip.stops as any[]
    if (!stops.length) return res.json({ base64: null })

    const params = new URLSearchParams()
    params.set('size', '800x400')
    params.set('maptype', 'roadmap')
    params.set('key', apiKey)

    // Build markers and path using S / H / F / number badge logic
    const pathPoints: string[] = []
    const lastStop = stops[stops.length - 1]
    let stopNum = 1

    function normalizeCity(s: string): string {
      return s.toLowerCase()
        .replace(/,?\s*\d{5}(-\d{4})?$/, '')
        .replace(/,?\s*(usa|united states)$/, '')
        .replace(/,?\s*(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/, '')
        .replace(/,?\s+[a-z]{2}$/, '')
        .trim()
    }

    for (const stop of stops) {
      if (!stop.latitude || !stop.longitude) continue
      const coord = `${stop.latitude},${stop.longitude}`
      pathPoints.push(coord)
      let label: string
      if (stop.order === stops[0].order) {
        label = 'S'
      } else if (stop.id === lastStop.id) {
        let isHome = false
        if (user?.homeCity) {
          const stopCity  = normalizeCity(stop.locationName)
          const hCity     = user.homeCity.toLowerCase().trim()
          const hState    = user.homeState?.toLowerCase().trim()
          const stopState = stop.locationState ? normalizeCity(stop.locationState) : undefined
          isHome = stopCity === hCity && (!hState || !stopState || stopState === hState)
        } else if (user?.homeLocation) {
          const stopCity = normalizeCity(stop.locationName + (stop.locationState ? `, ${stop.locationState}` : ''))
          isHome = stopCity === normalizeCity(user.homeLocation)
        }
        label = isHome ? 'H' : 'F'
      } else {
        label = String(stopNum++)
      }
      params.append('markers', `color:green|label:${label}|${coord}`)
    }

    if (pathPoints.length > 1) {
      params.append('path', `color:0xF97316ff|weight:3|${pathPoints.join('|')}`)
    }

    const url = `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`
    const imgResponse = await axios.get(url, { responseType: 'arraybuffer' })
    const base64 = `data:image/png;base64,${Buffer.from(imgResponse.data).toString('base64')}`
    res.json({ base64 })
  } catch (err) { next(err) }
}

export async function generateItinerary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    console.log('[generateItinerary] endpoint hit — tripId=%s userId=%s', req.params.id, req.user?.id)
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: true },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { rigs: { where: { isDefault: true } }, travelProfile: true },
    })

    // Run itinerary AI and real Google Maps route fetching in parallel
    const [itinerary, routes] = await Promise.all([
      generateTripItineraryAI(trip, user),
      fetchAllSegmentRoutes(trip),
    ])

    // Always use the real Directions API route — overwrite anything the AI generated
    let driveIdx = 0
    const itineraryWithRoutes = itinerary.map((day: any) => {
      if (day.type !== 'DRIVE') return day
      const realRoute = routes.find((r: any) => r.segmentIdx === driveIdx)?.route ?? null
      driveIdx++
      return { ...day, highwayRoute: realRoute || day.highwayRoute || null }
    })

    await prisma.trip.update({ where: { id: trip.id }, data: { itinerary: itineraryWithRoutes } })

    res.json(itineraryWithRoutes)
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
    const routes = await fetchAllSegmentRoutes(trip)
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

export async function generateRouteHighlights(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const stop = trip.stops.find((s: any) => s.id === req.params.stopId)
    if (!stop) throw new AppError('Stop not found', 404)

    // Return cached highlights if already generated
    if ((stop as any).routeHighlights) {
      return res.json({ routeHighlights: (stop as any).routeHighlights })
    }

    // Find the preceding stop to determine the origin
    const stopIdx = trip.stops.findIndex((s: any) => s.id === req.params.stopId)
    const prevStop: any = stopIdx > 0 ? trip.stops[stopIdx - 1] : null

    const origin = prevStop
      ? `${prevStop.locationName}${prevStop.locationState ? ', ' + prevStop.locationState : ''}`
      : trip.startLocation
    const destination = `${stop.locationName}${(stop as any).locationState ? ', ' + (stop as any).locationState : ''}`

    const highlights = await generateRouteHighlightsAI(origin, destination, (stop as any).highwayRoute)

    // Persist so it only generates once.
    // Use raw SQL because the Prisma client may not yet know about routeHighlights
    // if prisma generate hasn't been run since the column was added via db push.
    await prisma.$executeRaw`UPDATE "Stop" SET "routeHighlights" = ${highlights} WHERE id = ${stop.id}`

    res.json({ routeHighlights: highlights })
  } catch (err) { next(err) }
}

// ─── Trip weather — DB-cached, 6-hour TTL ─────────────────────────────────────

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

export async function getTripWeather(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const today      = new Date()
    const tripStart  = trip.startDate ? new Date(trip.startDate) : null
    const daysUntil  = tripStart
      ? Math.ceil((tripStart.getTime() - today.getTime()) / 86_400_000)
      : null
    const useLive    = daysUntil !== null && daysUntil <= 10

    const results: Record<string, any> = {}

    await Promise.all(
      (trip.stops as any[])
        .filter(s => s.latitude && s.longitude)
        .map(async (stop) => {
          const cached    = stop.weatherForecast as any
          const cachedAt  = cached?.cachedAt ? new Date(cached.cachedAt).getTime() : 0
          const isFresh   = Date.now() - cachedAt < SIX_HOURS_MS
          const modeMatch = cached?.mode && (
            (useLive  && cached.mode === 'live') ||
            (!useLive && cached.mode === 'historical')
          )

          if (isFresh && modeMatch) {
            // Strip internal cachedAt before sending to client
            const { cachedAt: _c, ...clean } = cached
            results[stop.id] = clean
            return
          }

          try {
            let data: any = null

            if (useLive) {
              // Live mode: use stop arrivalDate, or fall back to trip startDate, or today
              const base = stop.arrivalDate
                ? new Date((stop.arrivalDate as string).split('T')[0])
                : tripStart ?? today
              const startDate = isoDate(base)
              const endDate   = isoDate(new Date(new Date(startDate).setDate(new Date(startDate).getDate() + (stop.nights || 1))))
              data = await fetchLiveForecast(stop.latitude, stop.longitude, startDate, endDate)
            } else {
              // Historical mode: use stop arrivalDate month, trip startDate month, or current month
              const base = stop.arrivalDate
                ? new Date(stop.arrivalDate as string)
                : tripStart ?? today
              data = await fetchHistoricalWeather(
                stop.latitude, stop.longitude,
                base.getMonth() + 1, base.getDate(), stop.nights || 1,
              )
            }

            if (data) {
              const withTs = { ...data, cachedAt: new Date().toISOString() }
              await prisma.stop.update({ where: { id: stop.id }, data: { weatherForecast: withTs } })
              results[stop.id] = data
            } else {
              results[stop.id] = null
            }
          } catch (e) {
            console.error(`[weather] failed for stop ${stop.id}:`, e)
            results[stop.id] = null
          }
        })
    )

    res.json(results)
  } catch (err) { next(err) }
}
