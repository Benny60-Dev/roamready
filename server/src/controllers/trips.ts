import { Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { randomBytes } from 'crypto'
import axios from 'axios'
import { Prisma } from '@prisma/client'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import type { StopUpdateInput, TripUpdateInput, TripShiftDatesInput } from '../schemas'
import { generatePackingListAI, generateTripItineraryAI, generateStopActivitiesAI, generateRouteHighlightsAI } from '../services/ai'
import { fetchLiveForecast, fetchHistoricalWeather, isoDate } from '../services/weatherFetch'
import { computeFuelEstimate } from '../services/fuelPrice'

// ─── City name normalization ─────────────────────────────────────────────────
// Strip ZIP, country, full state name, and trailing 2-letter state code so a
// stop's locationName ("Mesa, AZ") can be compared against a user's homeCity
// ("Mesa") for the home-coords backfill in createStop and the H/F label
// decision in getTripMapImage.
function normalizeCity(s: string): string {
  return s.toLowerCase()
    .replace(/,?\s*\d{5}(-\d{4})?$/, '')
    .replace(/,?\s*(usa|united states)$/, '')
    .replace(/,?\s*(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/, '')
    .replace(/,?\s+[a-z]{2}$/, '')
    .trim()
}

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

/** Recompute Trip.startLocation / endLocation from the current first/last stop.
 *  Trip endpoints were originally set at creation time and not refreshed on stop
 *  mutations, so removing a return-home (round trip → one-way) used to leave
 *  endLocation pointing at the old return city. Modify-mode prompts that surface
 *  Route then misframe the trip shape for the AI. */
async function syncTripEndpoints(tripId: string): Promise<void> {
  const stops = await prisma.stop.findMany({
    where: { tripId },
    orderBy: { order: 'asc' },
    select: { locationName: true },
  })
  if (stops.length === 0) return
  await prisma.trip.update({
    where: { id: tripId },
    data: {
      startLocation: stops[0].locationName,
      endLocation: stops[stops.length - 1].locationName,
    },
  })
}

const MS_PER_DAY = 86_400_000

/**
 * Walk every stop in `order` ascending from the trip's anchor date and
 * recompute Stop.arrivalDate = running date, Stop.departureDate = running
 * date + nights, advancing the running date by the stop's nights. Persist
 * each stop, then sync Trip.totalNights and Trip.endDate in the same
 * transaction.
 *
 * Closes a bug where AI-modified add_stop inserted a stop with
 * arrivalDate=null / departureDate=null. The client's buildTimeline
 * fallback would then run out of a valid running date and emit entries
 * with date=null, which buildGroups silently drops — the stop existed in
 * the DB but was invisible in the itinerary.
 *
 * Anchor priority mirrors shiftTripDates: trip.startDate is unreliable
 * (the promote flow doesn't write it), so we fall back to the first stop
 * that has an arrivalDate set, and ultimately to `new Date()` when neither
 * is present. This matches what TripSummaryPage.cascadeAndSaveDates does
 * on the client when a user manually edits a stop.
 *
 * Distinct from shiftTripDates which moves all dates by a delta — this
 * recomputes from scratch using each stop's `nights` value, so the call
 * sites that perturb the schedule (createStop, updateStop on nights
 * change, deleteStop) all converge on the same canonical layout.
 */
async function recomputeStopDates(tripId: string): Promise<void> {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: { stops: { orderBy: { order: 'asc' } } },
  })
  if (!trip || trip.stops.length === 0) return

  // Anchor: trip.startDate if set, else the first stop with a stored
  // arrivalDate (cascade-populated by prior edits), else today. Null
  // here would re-introduce the bug we're fixing, hence the new Date()
  // floor — same fallback the client cascade uses. Validate against
  // an Invalid Date snuck in from corrupted data so the walk never
  // propagates NaN into stop.arrivalDate columns.
  const firstDatedStop = trip.stops.find(s => s.arrivalDate != null)
  const anchorRaw = trip.startDate ?? firstDatedStop?.arrivalDate ?? new Date()
  const anchor: Date = isNaN(anchorRaw.getTime()) ? new Date() : anchorRaw
  let current = new Date(anchor.getTime())
  let totalNights = 0

  // Build the per-stop update operations up front, then run the whole
  // batch atomically via the array form of $transaction.
  //
  // The prior version used the interactive callback form
  // (`$transaction(async (tx) => { for await tx.stop.update … })`),
  // which has subtle timing semantics: an await inside the callback
  // that hits Prisma's interactive-tx timeout (default 5s) or transient
  // pool contention can cause the whole tx to silently roll back —
  // including, critically, the LAST update in the loop. The bug
  // observed was exactly that shape: stops 1..N-1 wrote successfully
  // but the trailing return-home stop kept its pre-insert date because
  // the rollback erased its update. Switching to the array form makes
  // the batch a single declarative unit Prisma resolves in one round
  // trip — no interactive-tx timeout window, no per-await re-entry,
  // and the LAST write is no more privileged than any other.
  //
  // `.map()` runs synchronously, so the closure captures `arrival`,
  // `departure`, and the running `current` cleanly in iteration order
  // before any Prisma promise is awaited. Each returned PrismaPromise
  // carries its own snapshotted payload.
  const stopWrites = trip.stops.map(stop => {
    const nights = stop.type === 'OVERNIGHT_ONLY' ? 1 : (stop.nights ?? 0)
    const arrival = new Date(current.getTime())
    const departure = new Date(current.getTime() + nights * MS_PER_DAY)
    totalNights += nights
    current = new Date(current.getTime() + nights * MS_PER_DAY)
    return prisma.stop.update({
      where: { id: stop.id },
      data: { arrivalDate: arrival, departureDate: departure },
    })
  })

  // Snapshot the post-walk current as endDate. Also persist `anchor`
  // back to Trip.startDate so subsequent recomputes (a later AI
  // modify, a delete, a nights edit) anchor on the same date instead
  // of re-falling-back to new Date() if startDate was originally null
  // — without this, each call would drift the trip's whole schedule
  // by the time between calls.
  const finalAnchor = new Date(anchor.getTime())
  const finalEndDate = new Date(current.getTime())

  await prisma.$transaction([
    ...stopWrites,
    prisma.trip.update({
      where: { id: tripId },
      data: {
        startDate: finalAnchor,
        endDate: finalEndDate,
        totalNights,
      },
    }),
  ])

  // Visibility: every recompute logs its inputs and outputs so a
  // future regression in this path is diagnosable without a debugger.
  // Cheap (a single line per write path) and useful for confirming
  // the LAST stop got its walked date in production logs.
  console.log(
    '[recomputeStopDates] tripId=%s stops=%d anchor=%s endDate=%s totalNights=%d',
    tripId,
    trip.stops.length,
    finalAnchor.toISOString(),
    finalEndDate.toISOString(),
    totalNights,
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

    // Travel Party Phase B: clone the user's default party onto this trip.
    // Trip-scoped party (tripId set, userId null, isDefault false) becomes
    // the authoritative party for AI prompts on this trip — modify-mode
    // already reads trip.party first and falls back to user.parties.
    // This is the ONLY place trip-scoped parties are created in v1.
    //
    // Best-effort: if the user has no default party (e.g. account created
    // before the backfill) or the clone fails for any reason, the trip is
    // still returned. The AI falls back to user-level defaultParty, or to
    // legacy TravelProfile fields, exactly as before this commit.
    try {
      const defaultParty = await prisma.travelParty.findFirst({
        where: { userId: req.user!.id, isDefault: true },
        include: { people: true, pets: true },
      })
      if (defaultParty) {
        await prisma.travelParty.create({
          data: {
            tripId: trip.id,
            isDefault: false,
            notes: defaultParty.notes,
            people: {
              create: defaultParty.people.map(p => ({
                role: p.role,
                name: p.name,
                age: p.age,
                isTraveling: p.isTraveling,
                isEmergencyContact: p.isEmergencyContact,
                emergencyPhone: p.emergencyPhone,
                accessibilityNeeds: p.accessibilityNeeds ?? undefined,
                dietaryNotes: p.dietaryNotes,
                militaryStatus: p.militaryStatus,
                firstResponder: p.firstResponder,
              })),
            },
            pets: {
              create: defaultParty.pets.map(p => ({
                type: p.type,
                name: p.name,
                breed: p.breed,
                weightLbs: p.weightLbs,
                leashTrained: p.leashTrained,
                comfortableInCrowds: p.comfortableInCrowds,
                comfortableAtNight: p.comfortableAtNight,
                notes: p.notes,
              })),
            },
          },
        })
        console.log('[createTrip] cloned default party → trip.party for trip=%s', trip.id)
      }
    } catch (cloneErr: any) {
      console.warn('[createTrip] party clone failed (non-fatal) for trip=%s:', trip.id, cloneErr?.message ?? cloneErr)
    }

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
    // Defense-in-depth: ownership check stays even though validateBody has already
    // stripped any client-supplied userId/sharedToken/packingList/etc. from the payload.
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)

    // req.body is guaranteed to be a parsed TripUpdateInput by validateBody on the route.
    const data: TripUpdateInput = req.body
    // See sessions.ts:145 for the rationale on the adHocVehicle cast — Zod
    // typed it as Record<string, unknown> which TS can't prove satisfies
    // Prisma.InputJsonValue; the cast bridges the two type systems without
    // changing runtime behavior (null still nulls, undefined still skips).
    const updated = await prisma.trip.update({
      where: { id: req.params.id },
      data: { ...data, adHocVehicle: data.adHocVehicle as Prisma.InputJsonValue | undefined },
    })
    res.json(updated)
  } catch (err) { next(err) }
}

/**
 * Shift the entire trip forward or backward in time. Closes the
 * Modify-with-AI hallucination loop where the assistant claimed to change
 * dates but had no tool to actually do it (see commit message + the
 * `shift_trip_dates` action in the modify-mode system prompt).
 *
 * Semantics:
 *   - Anchor: the FIRST stop with a non-null arrivalDate (by `order`
 *     ascending). Trip.startDate is unreliable in this codebase — the
 *     promote flow doesn't write it and there's no UI to set it directly,
 *     so almost every real Trip row has startDate=null. Stop arrivalDates
 *     are the canonical source of truth (see TripSummaryPage's
 *     buildTimeline, which already prefers stop.arrivalDate for the same
 *     reason). delta = newStartDate − anchorStop.arrivalDate (ms).
 *   - Trip.startDate, Trip.endDate, every Stop.arrivalDate, every
 *     Stop.departureDate are shifted by the same delta. The `shifted()`
 *     helper is null-safe, so Trip.startDate / Trip.endDate / stops with
 *     null dates stay null — we don't invent values that weren't there.
 *   - Stop ordering, nights, and Trip.totalNights are NOT touched —
 *     duration is preserved by definition.
 *   - The whole mutation runs in a single prisma.$transaction so a partial
 *     failure leaves no half-shifted trip behind.
 *
 * Edge cases:
 *   - Trip with zero stop arrival dates: 400 — there's truly nothing to
 *     anchor against. Rare: it'd require a trip where every stop has both
 *     arrivalDate AND departureDate null, which only happens for an
 *     empty/half-built itinerary.
 *   - deltaMs === 0 (user picked the current effective start): return the
 *     trip unchanged without doing any writes.
 *   - No past-date guard at the API layer — the modify-mode prompt
 *     instructs the AI to avoid past dates unless the user explicitly
 *     asks. Backdating COMPLETED trips for record-keeping must remain
 *     possible, so blocking server-side would over-constrain.
 */
export async function shiftTripDates(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    // Anchor on the first stop that actually has a date. Stops are already
    // ordered by `order` ascending from the include above, so .find() walks
    // them in the user-facing sequence.
    const anchorStop = trip.stops.find(s => s.arrivalDate != null)
    if (!anchorStop) {
      throw new AppError(
        'Cannot shift a trip with no stop dates set. The trip needs dates on at least one stop before it can be shifted.',
        400,
      )
    }

    const { newStartDate }: TripShiftDatesInput = req.body
    // .find() above asserts arrivalDate is non-null, but TS doesn't narrow
    // through .find predicates — the ! is the minimal cast.
    const currentStartMs = anchorStop.arrivalDate!.getTime()
    const deltaMs = newStartDate.getTime() - currentStartMs

    // No-op shortcut: same date in, same trip out. Mirror getTrip's return
    // shape so the client can hot-swap state either way.
    if (deltaMs === 0) {
      return res.json(trip)
    }

    const shifted = (d: Date | null): Date | null =>
      d ? new Date(d.getTime() + deltaMs) : null

    const updated = await prisma.$transaction(async (tx) => {
      await tx.trip.update({
        where: { id: trip.id },
        data: {
          startDate: shifted(trip.startDate),
          // Trip.endDate may be null on legacy/in-progress trips; shifted()
          // preserves null so we never invent an endDate that wasn't there.
          endDate: shifted(trip.endDate),
        },
      })

      for (const stop of trip.stops) {
        // Skip stops with both dates null (typically HOME/transit stops
        // the user never dated) so we don't issue a no-op UPDATE per row.
        if (stop.arrivalDate == null && stop.departureDate == null) continue
        await tx.stop.update({
          where: { id: stop.id },
          data: {
            arrivalDate: shifted(stop.arrivalDate),
            departureDate: shifted(stop.departureDate),
          },
        })
      }

      // Return the post-shift trip in the same shape as getTrip so the
      // frontend can pass response.data straight into onTripUpdated().
      return tx.trip.findUnique({
        where: { id: trip.id },
        include: { stops: { orderBy: { order: 'asc' }, include: { journalEntry: true } } },
      })
    })

    console.log(
      '[shiftTripDates] tripId=%s deltaDays=%d stopsShifted=%d',
      trip.id,
      Math.round(deltaMs / 86400000),
      trip.stops.filter(s => s.arrivalDate != null || s.departureDate != null).length,
    )

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
      campgroundCandidates,
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
      select: { homeLat: true, homeLng: true, homeCity: true, homeState: true },
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
    // Also catch the AI-emitted return-home stop on round trips: the prompt requires the
    // last stop to be DESTINATION, so a Mesa→Flagstaff→Mesa loop ends with type=DESTINATION
    // for the home Mesa stop. Match by homeCity so that stop still gets the precise home pin.
    const looksLikeHome =
      !!homeOwner?.homeCity &&
      !!locationName &&
      normalizeCity(locationName) === homeOwner.homeCity.toLowerCase().trim()
    const useHomeCoords = (type === 'HOME' || looksLikeHome) && exactHomeLat != null && exactHomeLng != null
    const resolvedLat = useHomeCoords ? exactHomeLat : (latitude ?? null)
    const resolvedLng = useHomeCoords ? exactHomeLng : (longitude ?? null)
    if (looksLikeHome && type !== 'HOME' && useHomeCoords) {
      console.log(`[createStop:homeCoords] backfill via city match — locationName="${locationName}" matches homeCity="${homeOwner!.homeCity}" → using home coords (${exactHomeLat}, ${exactHomeLng})`)
    }

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
        // Phase 1B: AI-suggested names for Google Places verification at booking-page render
        // time. Persisted on Stop so candidates survive across sessions and trips don't have
        // to re-call the AI for the same itinerary.
        campgroundCandidates: campgroundCandidates ?? undefined,
        tripId: req.params.id,
        order,
      },
    })
    await resequenceStops(req.params.id)
    try {
      await syncTripEndpoints(req.params.id)
    } catch (e: any) {
      console.warn('[syncTripEndpoints] createStop tripId=%s failed: %s', req.params.id, e?.message)
    }
    // AI-modified add_stop inserts a Stop with arrivalDate=null /
    // departureDate=null because the AI doesn't supply them. Without
    // this recompute, the client's buildTimeline falls back to its
    // running-date pointer, which used to drift to undefined when a
    // null-dated stop appeared mid-trip — the stop's cards then dropped
    // out of the rendered itinerary even though the row was in the DB.
    // Recomputing fills in the new stop AND re-walks following stops so
    // any schedule shift propagates cleanly. Try/catch so a recompute
    // failure doesn't roll back the successful create — the stop is
    // still inserted, dates can be cascaded later via a manual edit.
    try {
      await recomputeStopDates(req.params.id)
    } catch (e: any) {
      // Surface code + message + stack. Previously this swallowed the
      // root cause with just `.message`, which hid an interactive-tx
      // rollback that caused the trailing stop's update to disappear.
      console.warn(
        '[recomputeStopDates] createStop tripId=%s failed code=%s message=%s\n%s',
        req.params.id, e?.code, e?.message, e?.stack,
      )
    }
    // Refetch the stop so the response reflects the post-recompute
    // arrivalDate/departureDate. The caller (ModifyTripPanel) does its
    // own GET-trip refetch afterward, but returning fresh dates here
    // keeps the contract honest for any future caller that consumes
    // the create response directly.
    const finalStop = await prisma.stop.findUnique({ where: { id: stop.id } })
    res.status(201).json(finalStop ?? stop)
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
    try {
      await syncTripEndpoints(req.params.id)
    } catch (e: any) {
      console.warn('[syncTripEndpoints] updateStop tripId=%s failed: %s', req.params.id, e?.message)
    }
    // If nights changed, the schedule downstream of this stop shifts. The
    // client's handleSaveEditStop runs cascadeAndSaveDates after a nights
    // edit, but the AI modify-mode path (change_nights action) hits this
    // endpoint directly without that client cascade, so the server has
    // to re-walk dates itself. Gated on an actual change so a notes /
    // campground / booking edit doesn't pay the recompute cost.
    const nightsChanged =
      data.nights !== undefined && data.nights !== null && data.nights !== stop.nights
    if (nightsChanged) {
      try {
        await recomputeStopDates(req.params.id)
      } catch (e: any) {
        console.warn('[recomputeStopDates] updateStop tripId=%s failed: %s', req.params.id, e?.message)
      }
    }
    res.json(updated)
  } catch (err) { next(err) }
}

export async function deleteStop(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Guard 1: trip ownership.
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)

    // Guard 2: the stopId in the URL must actually belong to this trip. Without
    // this, a user could DELETE someone else's stop by composing a URL with one
    // of their own tripIds plus an arbitrary stopId.
    const stop = await prisma.stop.findFirst({
      where: { id: req.params.stopId, tripId: req.params.id },
    })
    if (!stop) throw new AppError('Stop not found on this trip', 404)

    // Guard 3: HOME stops are structurally required (start of trip, sometimes
    // also the closing return-home entry). Refuse rather than allow a corrupt
    // trip shape — the AI modify-mode path can otherwise reach this codepath.
    if (stop.type === 'HOME') {
      throw new AppError('Cannot delete the home departure stop', 400, {
        code: 'HOME_STOP_PROTECTED',
      })
    }

    // Guard 4: a trip needs at least 2 stops (HOME + at least one destination).
    // Block the delete if it would drop below that floor. Mirrors the Summary
    // page's existing canDelete = sortedStops.length > 2 gate.
    const stopCount = await prisma.stop.count({ where: { tripId: req.params.id } })
    if (stopCount <= 2) {
      throw new AppError(
        'Cannot delete — a trip needs at least one destination after the home departure',
        400,
        { code: 'MIN_STOPS_VIOLATION' },
      )
    }

    await prisma.stop.delete({ where: { id: req.params.stopId } })
    await resequenceStops(req.params.id)
    try {
      await syncTripEndpoints(req.params.id)
    } catch (e: any) {
      console.warn('[syncTripEndpoints] deleteStop tripId=%s failed: %s', req.params.id, e?.message)
    }
    // Removing a stop shrinks the schedule — every later stop's
    // arrivalDate/departureDate should slide earlier so the itinerary
    // doesn't leave a hole. The client's confirmDeleteStop already runs
    // cascadeAndSaveDates after a delete, but the AI modify-mode
    // (remove_stop action) hits this endpoint directly without that
    // cascade, so the server has to re-walk dates itself.
    try {
      await recomputeStopDates(req.params.id)
    } catch (e: any) {
      console.warn('[recomputeStopDates] deleteStop tripId=%s failed: %s', req.params.id, e?.message)
    }
    res.json({ message: 'Stop deleted' })
  } catch (err) { next(err) }
}

// Public-view allowlist. Anything NOT in these select clauses is stripped before
// reaching a share-link viewer. Adding a new column to Trip/Stop defaults to NOT
// being exposed — keep it that way.
const PUBLIC_TRIP_SELECT = {
  id: true,
  name: true,
  status: true,
  startLocation: true,
  endLocation: true,
  startDate: true,
  endDate: true,
  totalMiles: true,
  totalNights: true,
  estimatedFuel: true,
  estimatedCamp: true,
  fuelPrice: true,
  itinerary: true,
  createdAt: true,
  updatedAt: true,
  stops: {
    orderBy: { order: 'asc' as const },
    select: {
      id: true,
      tripId: true,
      order: true,
      type: true,
      locationName: true,
      locationState: true,
      latitude: true,
      longitude: true,
      arrivalDate: true,
      departureDate: true,
      nights: true,
      campgroundName: true,
      campgroundId: true,
      bookingStatus: true,
      estimatedFuel: true,
      checkInTime: true,
      checkOutTime: true,
      hookupType: true,
      isPetFriendly: true,
      isMilitaryOnly: true,
      isCompatible: true,
      incompatibilityReasons: true,
      alternates: true,
      weatherForecast: true,
      highwayRoute: true,
      driveDuration: true,
      driveDistanceMiles: true,
      routeHighlights: true,
      pointsOfInterest: true,
      createdAt: true,
      updatedAt: true,
    },
  },
}

export async function getSharedTrip(req: Request, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { sharedToken: req.params.token },
      select: PUBLIC_TRIP_SELECT,
    })
    if (!trip) throw new AppError('Shared trip not found', 404)
    res.json(trip)
  } catch (err) { next(err) }
}

async function mintUniqueShareToken(tripId: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomBytes(24).toString('base64url')
    try {
      await prisma.trip.update({
        where: { id: tripId },
        data: { sharedToken: token },
      })
      return token
    } catch (err: any) {
      // P2002 = unique constraint violation on sharedToken — retry with a new token
      if (err?.code === 'P2002') continue
      throw err
    }
  }
  throw new AppError('Could not mint a unique share token', 500)
}

export async function createShareToken(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true, sharedToken: true },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    if (trip.sharedToken) {
      return res.json({ sharedToken: trip.sharedToken, regenerated: false })
    }

    const sharedToken = await mintUniqueShareToken(trip.id)
    res.json({ sharedToken, regenerated: false })
  } catch (err) { next(err) }
}

export async function regenerateShareToken(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const sharedToken = await mintUniqueShareToken(trip.id)
    res.json({ sharedToken, regenerated: true })
  } catch (err) { next(err) }
}

export async function revokeShareToken(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    await prisma.trip.update({
      where: { id: trip.id },
      data: { sharedToken: null },
    })
    res.json({ sharedToken: null, revoked: true })
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

    // Block 15 (Step 2) — build the per-stop "things to do during your stay"
    // payload. Same shape and filter (DESTINATION + nights > 0) used by the
    // existing /activities/generate endpoint below; routing through the same
    // AI helper (generateStopActivitiesAI) keeps the day-by-day prompt risk
    // at zero — generateTripItineraryAI is unchanged.
    const destStops = trip.stops
      .filter((s: any) => s.type === 'DESTINATION' && s.nights > 0)
      .map((s: any, i: number) => ({
        stopIdx: i,
        stopId: s.id,
        locationName: s.locationName,
        locationState: s.locationState || undefined,
        nights: s.nights || 1,
      }))

    // Run itinerary AI, Google Maps route fetching, and per-stop stay-activities AI in parallel.
    // Skipping the third call when no qualifying stops exist saves a roundtrip
    // on edge-case trips (e.g. all-overnight transit routes).
    const [itinerary, routes, stayActivitiesResults] = await Promise.all([
      generateTripItineraryAI(trip, user, { userId: req.user!.id, tripId: trip.id }),
      fetchAllSegmentRoutes(trip),
      destStops.length > 0
        ? generateStopActivitiesAI(destStops, { userId: req.user!.id, tripId: trip.id })
        : Promise.resolve([] as { stopIdx: number; activities: string[] }[]),
    ])

    // Always use the real Directions API route — overwrite anything the AI generated
    let driveIdx = 0
    const itineraryWithRoutes = itinerary.map((day: any) => {
      if (day.type !== 'DRIVE') return day
      const realRoute = routes.find((r: any) => r.segmentIdx === driveIdx)?.route ?? null
      driveIdx++
      return { ...day, highwayRoute: realRoute || day.highwayRoute || null }
    })

    // Block 15 (Step 2) — write per-stop activities to Stop.stayActivities. Only
    // write when the AI actually returned a non-empty array for that stop; a
    // null/empty result leaves stayActivities as null so Step 4's backfill can
    // still distinguish "AI never produced one" from "intentionally empty []".
    // Per-day `activities` arrays inside Trip.itinerary are STILL populated by
    // generateTripItineraryAI (unchanged) — Step 3 will swap the renderer to
    // read from Stop.stayActivities; until then both shapes coexist so no new
    // or existing trip visibly regresses.
    const stayActivityWrites = stayActivitiesResults
      .filter(r => Array.isArray(r.activities) && r.activities.length > 0)
      .map(r => {
        const stopId = destStops[r.stopIdx]?.stopId
        if (!stopId) return Promise.resolve()
        return prisma.stop.update({
          where: { id: stopId },
          data: { stayActivities: r.activities },
        })
      })

    // Parallelize the writes — Trip.itinerary and Stop.stayActivities are independent rows.
    await Promise.all([
      prisma.trip.update({ where: { id: trip.id }, data: { itinerary: itineraryWithRoutes } }),
      ...stayActivityWrites,
    ])

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

    const results = await generateStopActivitiesAI(destStops, { userId: req.user!.id, tripId: trip.id })

    // Block 15 (Step 3 consistency) — persist per-stop activities to
    // Stop.stayActivities so the renderer's new read path stays in sync after
    // regeneration. Mirrors the write that generateItinerary performs at the
    // end of an initial AI run. Same "only-write-when-non-empty" guard so a
    // no-results stop stays null (Step 4's backfill can still distinguish
    // "never generated" from "intentionally emptied"). Runs in parallel
    // before the response so the next /trips/:id GET on this trip sees the
    // updated stayActivities.
    await Promise.all(
      results
        .filter(r => Array.isArray(r.activities) && r.activities.length > 0)
        .map(r => {
          const stopId = destStops[r.stopIdx]?.stopId
          if (!stopId) return Promise.resolve()
          return prisma.stop.update({
            where: { id: stopId },
            data: { stayActivities: r.activities },
          })
        })
    )

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

    const packingList = await generatePackingListAI(trip, user, { userId: req.user!.id, tripId: trip.id })

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

    const highlights = await generateRouteHighlightsAI(origin, destination, (stop as any).highwayRoute, { userId: req.user!.id, tripId: trip.id })

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
              // Live mode: use stop arrivalDate, or fall back to trip startDate, or today.
              // Prisma returns DateTime columns as Date instances — wrap directly via
              // new Date(...) so we copy the Date rather than coercing it to string and
              // back. The earlier `(stop.arrivalDate as string).split('T')[0]` form
              // threw TypeError at runtime (.split on a Date), the per-stop catch
              // swallowed it, and every live-mode trip's weather came back as { id:
              // null, … } with a 200 — surfacing as a blank Weather tab. Mirrors the
              // historical branch's tolerant `new Date(stop.arrivalDate)`.
              const base = stop.arrivalDate
                ? new Date(stop.arrivalDate)
                : tripStart ?? today
              const startDate = isoDate(base)
              // Add `nights` days to `base` directly with .setDate, then
              // isoDate the result. The prior form round-tripped through
              // `new Date(startDate)`, where the "YYYY-MM-DD" string is
              // parsed as UTC midnight; in UTC-N zones, .getDate() then
              // reads the previous local calendar day, and setDate(prev+
              // nights) lands the end one day short — for a 1-night stop
              // endDate came out EQUAL to startDate. Working off `base`
              // (which is already a Date with local-time semantics from
              // Prisma) keeps both endpoints anchored to the same local
              // calendar day, so endDate = startDate + nights reliably.
              const endBase = new Date(base)
              endBase.setDate(endBase.getDate() + (stop.nights || 1))
              const endDate = isoDate(endBase)
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

// ─── Fuel-cost estimate ───────────────────────────────────────────────────────

/**
 * GET /api/v1/trips/:id/fuel-estimate
 *
 * Returns the trip's per-leg + total fuel-cost estimate, priced by each
 * leg's destination state via the EIA regional retail price feed (with
 * Redis cache + hardcoded fallback). Also persists the computed total
 * back to trip.estimatedFuel as a fire-and-forget side effect, so list
 * surfaces (dashboard cards, public share view) can read a real stored
 * number without fanning out per-card fuel-estimate API calls of their
 * own. Mirrors the getTripWeather precedent: GET that caches the
 * computed value into the DB on the way out.
 *
 * Refresh cadence: every itinerary open or map-page open. EIA publishes
 * weekly, so a user who views their trip at least once a week effectively
 * stays current. Trips never re-opened can go stale; that's accepted —
 * list surfaces just show "what the owner last saw," which is honest.
 *
 * The persist is guarded by !noEstimate so we don't clobber a real prior
 * value with $0 when the rig has no MPG, and by Number.isFinite as a
 * belt-and-suspenders against a bad upstream number. NOT awaited — the
 * response shouldn't block on the cache write; a Prisma hiccup logs and
 * the user still gets their estimate JSON immediately.
 *
 * Rig selection: prefers trip.rigId (the rig the user assigned to this
 * trip at promote/edit time); falls back to the user's default rig
 * (isDefault=true) when trip.rigId is null. If neither exists, the
 * service returns noEstimate=true with a reason — the endpoint still
 * 200s with that shape so the client doesn't need a separate error path.
 *
 * Response shape — see TripFuelEstimate in services/fuelPrice.ts.
 * Always 200 unless the trip itself is missing / not the user's.
 */
export async function getTripFuelEstimate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    // Two-step rig resolution: prefer the trip-assigned rig, fall back to
    // the user's default. Both lookups scoped by userId so a malicious id
    // probe can't lift another user's rig.
    //
    // SELECT widened (towing-aware fuel estimate, Pass 1 of 3): the fuel
    // service now needs the towing-related rig fields to decide which MPG
    // to apply and which fuel type to price. Both findFirst selects must
    // stay in sync so the trip-assigned and default-rig paths feed the
    // service the same shape.
    //   · mpgTowing      — towing-regime mpg (new column, Pass 1 migration)
    //   · vehicleType    — discriminates TRAILER (rig is towed; tow
    //                      vehicle's mpg/fuel matter) vs MOTORHOME
    //                      (own mpg/fuel; towing only when toad is along)
    //   · isTowing       — motorhome's profile says "I tow a toad/trailer"
    //   · towedType      — VEHICLE | TRAILER, kept for Pass 3's disclosure
    //   · towedFuelType  — the tow vehicle's fuel type (used by the
    //                      service to price gallons for trailered rigs)
    const rigSelect = {
      fuelType: true,
      mpg: true,
      mpgTowing: true,
      vehicleType: true,
      isTowing: true,
      towedType: true,
      towedFuelType: true,
    } as const
    let rig = null
    if (trip.rigId) {
      rig = await prisma.rig.findFirst({
        where: { id: trip.rigId, userId: req.user!.id },
        select: rigSelect,
      })
    }
    if (!rig) {
      rig = await prisma.rig.findFirst({
        where: { userId: req.user!.id, isDefault: true },
        select: rigSelect,
      })
    }

    // Map Stop rows to the duck-typed shape computeFuelEstimate expects —
    // explicit field selection keeps this resilient to future Stop
    // column additions and trims the closure capture.
    const stops = trip.stops.map(s => ({
      order: s.order,
      locationState: s.locationState,
      latitude: s.latitude,
      longitude: s.longitude,
      driveDistanceMiles: s.driveDistanceMiles,
    }))

    // Pass trip.bringingTowed into the service so motorhome rigs with a
    // toad can flip between solo and towing mpg per trip. The whole Trip
    // row is loaded (no narrow select above), so this field is already
    // hydrated — no extra round-trip. Trailer rigs ignore this flag
    // entirely; the service knows to always treat trailers as towing.
    const estimate = await computeFuelEstimate(stops, rig, {
      bringingTowed: trip.bringingTowed,
    })

    // Cache the computed total back to trip.estimatedFuel so list surfaces
    // (dashboard, share view) can read a real stored number without their
    // own API call. Fire-and-forget — never await; the response goes back
    // immediately. Skip when noEstimate so a rig-missing-MPG case can't
    // clobber a previously-good value. Number.isFinite double-checks the
    // upstream computeFuelEstimate's contract.
    if (!estimate.noEstimate && Number.isFinite(estimate.total)) {
      prisma.trip.update({
        where: { id: trip.id },
        data: { estimatedFuel: estimate.total },
      }).catch(err => console.warn(
        '[getTripFuelEstimate] persist failed for tripId=%s: %s',
        trip.id, err?.message ?? 'unknown',
      ))
    }

    res.json(estimate)
  } catch (err) { next(err) }
}
