import { Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { randomBytes } from 'crypto'
import axios from 'axios'
import { Prisma } from '@prisma/client'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { enforcePerUserDailyCap } from './ai'
import type { StopUpdateInput, TripUpdateInput, TripShiftDatesInput } from '../schemas'
import { generatePackingListAI, generateTripItineraryAI, generateStopActivitiesAI, generateRouteHighlightsAI } from '../services/ai'
import { fetchLiveForecast, fetchHistoricalWeather, isoDate } from '../services/weatherFetch'
import { computeFuelEstimate } from '../services/fuelPrice'
import { stampModifyActionApplied } from '../services/modifyActions'
import { mergePackedState, resetCheckedState } from '../utils/packingMerge'
import { resolvePackingCounts, computeStaleness } from '../utils/packingMeta'
import { parseTripDate } from '../utils/dates'
import { computeTripShape } from '../utils/tripShape'
import { getClientOrigin } from '../utils/clientOrigin'
import { geocodeHomeAddress } from '../utils/geocodeHome'

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

/** Haversine distance in miles between two lat/lng points. Local helper — no dep. */
function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 3958.8 // earth radius, miles
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
}

/**
 * ADDSTOP-RESLOT Phase B — deterministically place a newly-added MODIFY stop in
 * its geographically-correct slot by MINIMUM ADDED DETOUR, moving ONLY that stop.
 * The AI picks the insertion point from stop names + coords (attempt 1) but still
 * mis-slots unfamiliar towns; this is the server safety net.
 *
 * The modify add path creates the stop coord-less, so we GEOCODE it first
 * (reusing geocodeHomeAddress — Google forward geocoder, no new dep). If geocoding
 * fails we no-op and keep the AI's chosen position.
 *
 * Guardrails: origin (first) never moves; on a ROUND_TRIP the return-home closer
 * stays LAST (the new stop lands before it); on a ONE_WAY the new stop MAY become
 * the last stop (a genuine extension). Booked stops are NOT blocked from being
 * passed (decision 2c — allow + warn; the caller surfaces any date shift) but are
 * never themselves reordered. No-op when the new stop has no coords, there are
 * <2 coordinated other stops, or it is already in the best slot.
 */
async function geoReslotModifyStop(
  tripId: string,
  newStopId: string,
  locationName: string,
  locationState?: string | null,
): Promise<void> {
  const newStop = await prisma.stop.findUnique({
    where: { id: newStopId },
    select: { latitude: true, longitude: true },
  })
  if (!newStop) return

  // 1. Ensure coordinates — geocode the (typically coord-less) modify-added stop.
  let nLat = newStop.latitude
  let nLng = newStop.longitude
  if (nLat == null || nLng == null) {
    const addr = [locationName, locationState].filter(Boolean).join(', ')
    const geo = await geocodeHomeAddress(addr)
    if (geo) {
      nLat = geo.homeLat
      nLng = geo.homeLng
      await prisma.stop.update({ where: { id: newStopId }, data: { latitude: nLat, longitude: nLng } })
      console.log('[geoReslot] geocoded new stop "%s" → (%s, %s)', addr, nLat, nLng)
    }
  }
  if (nLat == null || nLng == null) {
    console.log('[geoReslot] no coords for new stop %s — keeping AI position', newStopId)
    return
  }

  // 2. Ordered stops; need >=2 coordinated other stops to reason about geography.
  const stops = await prisma.stop.findMany({
    where: { tripId },
    orderBy: { order: 'asc' },
    select: { id: true, locationName: true, type: true, latitude: true, longitude: true },
  })
  const others = stops.filter(s => s.id !== newStopId)
  if (others.filter(s => s.latitude != null && s.longitude != null).length < 2) return

  // Candidate insertion = "after others[i]" for i in [0, maxI]:
  //   i=0 → right after the origin (never before it).
  //   ROUND_TRIP → maxI = others.length-2 so the new stop lands BEFORE the
  //     return-home closer (which stays last).
  //   ONE_WAY → maxI = others.length-1 so a genuine extension can become last.
  const isRoundTrip = computeTripShape(stops) === 'ROUND_TRIP'
  const maxI = (isRoundTrip ? others.length - 2 : others.length - 1)

  let bestI = -1
  let bestDetour = Infinity
  for (let i = 0; i <= maxI; i++) {
    const a = others[i]
    if (!a || a.latitude == null || a.longitude == null) continue
    const b = others[i + 1]
    let detour: number
    if (b) {
      if (b.latitude == null || b.longitude == null) continue
      detour =
        haversineMiles(a.latitude, a.longitude, nLat, nLng) +
        haversineMiles(nLat, nLng, b.latitude, b.longitude) -
        haversineMiles(a.latitude, a.longitude, b.latitude, b.longitude)
    } else {
      // Append at the end (ONE_WAY extension) — only the open new leg counts.
      detour = haversineMiles(a.latitude, a.longitude, nLat, nLng)
    }
    if (detour < bestDetour) {
      bestDetour = detour
      bestI = i
    }
  }
  if (bestI < 0) return

  // 3. Move ONLY the new stop to the best slot; every other stop keeps relative order.
  const targetIds = [
    ...others.slice(0, bestI + 1).map(s => s.id),
    newStopId,
    ...others.slice(bestI + 1).map(s => s.id),
  ]
  if (targetIds.join(',') === stops.map(s => s.id).join(',')) return // already best — no-op

  await prisma.$transaction(
    targetIds.map((id, idx) => prisma.stop.update({ where: { id }, data: { order: idx + 1 } })),
  )
  console.log('[geoReslot] moved new stop %s to slot after index %d (added detour %s mi)',
    newStopId, bestI, bestDetour.toFixed(1))
}

/** Recompute Trip.startLocation / endLocation from the current first/last stop.
 *  Trip endpoints were originally set at creation time and not refreshed on stop
 *  mutations, so removing a return-home (round trip → one-way) used to leave
 *  endLocation pointing at the old return city. Modify-mode prompts that surface
 *  Route then misframe the trip shape for the AI.
 *
 *  BUG-4 Phase 4 (MODIFY-TRIPTYPE-1): also recompute Trip.tripType here, in the
 *  SAME stop fetch + trip update. Trip.tripType is written at creation, but
 *  modify-mode createStop/deleteStop can change the round-trip/one-way shape
 *  (add/remove a return-home leg) and used to leave the stored value stale.
 *  computeTripShape is the shared source of truth (mirrors buildLiveTripState's
 *  read fallback). Safe per-call: it derives from the freshly-persisted stops
 *  and self-corrects across a multi-action batch (nothing reads tripType
 *  mid-batch). On the initial-build createStop loop it converges to the same
 *  value Phase 2 wrote at promote time — no conflict. */
async function syncTripEndpoints(tripId: string): Promise<void> {
  const stops = await prisma.stop.findMany({
    where: { tripId },
    orderBy: { order: 'asc' },
    select: { locationName: true, type: true },
  })
  if (stops.length === 0) return
  await prisma.trip.update({
    where: { id: tripId },
    data: {
      startLocation: stops[0].locationName,
      endLocation: stops[stops.length - 1].locationName,
      tripType: computeTripShape(stops),
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
  // arrivalDate (cascade-populated by prior edits). There is deliberately
  // NO `?? new Date()` fallback here.
  //
  // BUG-AI-NODATE-ASK-B (Part B): the prior version floored a missing/invalid
  // anchor to today, then walked real-looking dates onto every stop AND
  // persisted that fabricated "today" back to Trip.startDate (below) — silently
  // converting a date-unset trip into one that looks scheduled for today, with
  // the "no date set" signal gone for good. The build-gate (RR50) and opening
  // flow (RR48) keep a normal build from reaching here without a date, but a
  // legacy/edge trip with no real anchor must NOT be fabricated. When no real
  // anchor exists, we leave every stop date null (the client renders null dates
  // as blank / "Dates TBD") and do NOT write a fabricated Trip.startDate/endDate.
  // An Invalid Date from corrupted data is treated as "no anchor" for the same
  // reason — never propagate NaN, never fabricate today.
  const firstDatedStop = trip.stops.find(s => s.arrivalDate != null)
  const anchorCandidate = trip.startDate ?? firstDatedStop?.arrivalDate ?? null
  const anchor: Date | null =
    anchorCandidate && !isNaN(anchorCandidate.getTime()) ? anchorCandidate : null

  let totalNights = 0

  // No real start date anywhere → leave stop dates null, persist totalNights
  // only (date-independent), and leave Trip.startDate/endDate null so the
  // missing date stays visible instead of being invented.
  if (anchor === null) {
    const nullWrites = trip.stops.map(stop => {
      totalNights += stop.type === 'OVERNIGHT_ONLY' ? 1 : (stop.nights ?? 0)
      return prisma.stop.update({
        where: { id: stop.id },
        data: { arrivalDate: null, departureDate: null },
      })
    })
    await prisma.$transaction([
      ...nullWrites,
      prisma.trip.update({
        where: { id: tripId },
        data: { totalNights },
      }),
    ])
    console.log(
      '[recomputeStopDates] tripId=%s stops=%d NO ANCHOR — stop dates left null, Trip.startDate NOT fabricated; totalNights=%d',
      tripId,
      trip.stops.length,
      totalNights,
    )
    return
  }

  let current = new Date(anchor.getTime())

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

/**
 * Sibling to fetchAllSegmentRoutes — returns the RICH per-leg detail the
 * long-leg guard needs (total drive duration/distance + the ordered list of
 * steps with each step's duration and end coordinate). fetchAllSegmentRoutes
 * deliberately throws all of this away (it only wants highway names), so rather
 * than change its return shape and every caller, this fetches one segment's
 * detail on demand. Works on lat/lng OR "City, State" strings (Directions
 * resolves names itself), so it does not require pre-geocoded stop coords.
 * Returns null on any failure — caller treats a null leg as "leave it alone".
 */
interface LegStep {
  durationSec: number
  startLat: number
  startLng: number
  endLat: number
  endLng: number
}
interface LegDetail {
  durationSec: number
  distanceMeters: number
  steps: LegStep[]
}

async function fetchLegDetail(
  from: any,
  to: any,
  apiKey: string,
): Promise<LegDetail | null> {
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
      console.warn('[fetchLegDetail] Directions status=%s for %s → %s', data.status, origin, destination)
      return null
    }
    const legs = data.routes[0].legs as any[]
    const durationSec = legs.reduce((s: number, l: any) => s + (l.duration?.value ?? 0), 0)
    const distanceMeters = legs.reduce((s: number, l: any) => s + (l.distance?.value ?? 0), 0)
    // Capture each step's START and END coordinate + duration. We interpolate a
    // split point WITHIN the step that crosses the target (start→end linear), so a
    // single multi-hour interstate step no longer forces the split to its far end.
    const steps: LegStep[] = legs
      .flatMap((l: any) => l.steps ?? [])
      .map((st: any) => ({
        durationSec: st.duration?.value ?? 0,
        startLat: st.start_location?.lat,
        startLng: st.start_location?.lng,
        endLat: st.end_location?.lat,
        endLng: st.end_location?.lng,
      }))
      .filter((s: any) =>
        typeof s.startLat === 'number' && typeof s.startLng === 'number' &&
        typeof s.endLat === 'number' && typeof s.endLng === 'number')
    return { durationSec, distanceMeters, steps }
  } catch (err: any) {
    console.error('[fetchLegDetail] error for %s → %s:', origin, destination, err?.message)
    return null
  }
}

/**
 * Reverse-geocode a coordinate to a real town. Biases toward locality-level
 * results so a split point in open country resolves to the nearest named town
 * (rather than a street address). Returns null if no usable city+state found —
 * caller skips that split point gracefully.
 */
async function reverseGeocode(
  lat: number,
  lng: number,
  apiKey: string,
): Promise<{ city: string; state: string; lat: number; lng: number } | null> {
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        latlng: `${lat},${lng}`,
        key: apiKey,
        result_type: 'locality|postal_town|administrative_area_level_3',
      },
      timeout: 5000,
    })
    if (res.data.status !== 'OK' || !res.data.results?.length) {
      console.warn('[reverseGeocode] status=%s for %s,%s', res.data.status, lat, lng)
      return null
    }
    for (const r of res.data.results) {
      const comps: any[] = r.address_components || []
      const has = (t: string) => comps.find(c => c.types.includes(t))
      const city =
        has('locality')?.long_name ||
        has('postal_town')?.long_name ||
        has('administrative_area_level_3')?.long_name ||
        has('administrative_area_level_2')?.long_name
      const state = has('administrative_area_level_1')?.short_name
      if (city && state) return { city, state, lat, lng }
    }
    return null
  } catch (err: any) {
    console.error('[reverseGeocode] error for %s,%s:', lat, lng, err?.message)
    return null
  }
}

/** State (admin_area_level_1 short_name) for a coordinate via an UNRESTRICTED
 *  reverse geocode — reliable even in remote areas where no locality exists
 *  (a state-level result almost always covers the point). */
async function stateForCoords(lat: number, lng: number, apiKey: string): Promise<string | null> {
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${lat},${lng}`, key: apiKey },
      timeout: 5000,
    })
    if (res.data.status !== 'OK') return null
    for (const r of res.data.results || []) {
      const st = (r.address_components || []).find((c: any) => c.types.includes('administrative_area_level_1'))?.short_name
      if (st) return st
    }
    return null
  } catch (err: any) {
    console.warn('[stateForCoords] error for %s,%s: %s', lat, lng, err?.message)
    return null
  }
}

/**
 * Nearest-real-place fallback for split points that land in empty wilderness
 * (Four Corners / open desert), where strict reverseGeocode returns ZERO_RESULTS
 * because there is no locality at the exact point. Uses Places Nearby Search with
 * rankby=distance (nearest result wins, no radius) across an ordered set of place
 * types — a real town first, then overnight-appropriate POIs, then a generic
 * keyword sweep — widening the net by trying successive queries. For each hit it
 * resolves a clean city+state by reverse-geocoding the FOUND place's own coords
 * (which, being an actual place, normally succeeds); failing that, it uses the
 * place's own name + a state lookup. A campground / RV-park name is an acceptable
 * result — these are OVERNIGHT_ONLY transit stops. Returns null only when nothing
 * nameable turns up at all (then the caller fails soft).
 */
async function findNearestTown(lat: number, lng: number, apiKey: string): Promise<TransitTown | null> {
  const queries: Record<string, string>[] = [
    { type: 'locality' },    // a real town, ideal
    { keyword: 'town' },     // generic town sweep
    { type: 'rv_park' },     // overnight-appropriate POI
    { type: 'campground' },  // overnight-appropriate POI
  ]
  for (const q of queries) {
    try {
      const res = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: { location: `${lat},${lng}`, rankby: 'distance', key: apiKey, ...q },
        timeout: 6000,
      })
      const top = res.data?.results?.[0]
      if (res.data?.status !== 'OK' || !top?.geometry?.location) continue
      const plat = top.geometry.location.lat
      const plng = top.geometry.location.lng
      // Prefer a clean city+state from the found place's own coordinates.
      const rg = await reverseGeocode(plat, plng, apiKey)
      if (rg) {
        console.log('[findNearestTown] %s,%s → %s, %s (via %j → reverse-geocode)', lat, lng, rg.city, rg.state, q)
        return { locationName: rg.city, locationState: rg.state, latitude: rg.lat, longitude: rg.lng }
      }
      // Else use the place's own name + a state lookup on its coords.
      const state = await stateForCoords(plat, plng, apiKey)
      if (top.name && state) {
        console.log('[findNearestTown] %s,%s → %s, %s (via %j place name)', lat, lng, top.name, state, q)
        return { locationName: top.name, locationState: state, latitude: plat, longitude: plng }
      }
    } catch (err: any) {
      console.warn('[findNearestTown] nearbysearch %j failed for %s,%s: %s', q, lat, lng, err?.message)
    }
  }
  console.warn('[findNearestTown] no nameable place near %s,%s', lat, lng)
  return null
}

// ─── Long-leg split helpers ───────────────────────────────────────────────────

interface TransitTown { locationName: string; locationState: string; latitude: number; longitude: number }

/**
 * Find a coordinate `targetSec` of driving into a measured leg by interpolating
 * WITHIN the step that crosses the target — NOT at the step's far end. Google
 * steps can be multi-hour interstate runs; taking the step end overshoots the
 * target badly (the original bug: a single I-70 step ended ~9.4h out, so the
 * "6h" split landed at Grand Junction). Linear start→end interpolation inside
 * the crossing step keeps the point near the true target along the road.
 */
function interpolateSplitPoint(detail: LegDetail, targetSec: number): { lat: number; lng: number } | null {
  let acc = 0
  for (const step of detail.steps) {
    if (acc + step.durationSec >= targetSec) {
      const remaining = targetSec - acc
      const frac = step.durationSec > 0 ? Math.max(0, Math.min(1, remaining / step.durationSec)) : 0
      return {
        lat: step.startLat + (step.endLat - step.startLat) * frac,
        lng: step.startLng + (step.endLng - step.startLng) * frac,
      }
    }
    acc += step.durationSec
  }
  const last = detail.steps[detail.steps.length - 1]
  return last ? { lat: last.endLat, lng: last.endLng } : null
}

interface LegPlan {
  towns: TransitTown[]
  /** Ordered resulting sub-leg durations (hours) for logging — last entry is the tail. */
  subLegs: { from: string; to: string; hours: number; over: boolean }[]
  warnings: string[]
}

// ─── Split policy (module-level constants — easy to tune) ─────────────────────
// HARD CAP is per-user (maxDriveHours), computed at call time. These are fixed:
const LEG_GRACE_HOURS         = 1.0   // a leg ≤ cap+grace stays ONE day (no split)
const LEG_MIN_USEFUL_HOURS    = 3.0   // avoid creating sub-legs shorter than this
const LEG_DRIFT_TOLERANCE_MIN = 15    // slack on a placed sub-leg vs cap (town drift)
const MAX_TRANSIT_INSERTS_PER_LEG = 4 // safety rail vs. pathological cross-country legs

/**
 * Plan the transit-stop splits for ONE original leg (from → to) using REAL,
 * re-measured drive times, dividing the leg into roughly EQUAL days rather than
 * greedily maxing each sub-leg to the cap (the old approach stranded tiny 1h
 * stubs, e.g. 5.7h + 1.6h, or split a barely-over 6.4h leg into 5.4h + 1.0h).
 *
 * Per iteration over the REMAINING route (frontier → to):
 *   • If remaining ≤ cap + GRACE → it fits in one comfortable day; done. GRACE
 *     means a barely-over leg (e.g. 6.4h vs a 6h cap) is NOT split into a stub.
 *   • Else split into balanced days: days = ceil(remaining / cap) (uses cap, not
 *     cap+grace, so each day keeps margin under the hard cap), target each
 *     sub-leg at remaining / days. MIN_USEFUL floor: reduce `days` (fewer,
 *     slightly-longer but still-legal days) before producing a sub-leg below the
 *     floor. Place a split at ~target, name it (reverseGeocode → findNearestTown
 *     fallback), RE-MEASURE frontier→town, accept only when ≤ cap + drift
 *     tolerance (retry closer otherwise).
 *
 * Re-measuring the real remaining route each pass self-corrects placement drift
 * and keeps the resulting days balanced. Bounded by maxInserts; fails soft
 * (leaves remainder + logs) rather than looping.
 */
async function planLegSplits(
  from: TransitTown,
  to: TransitTown,
  apiKey: string,
  capSec: number,
  graceSec: number,
  minUsefulSec: number,
  tolSec: number,
  maxInserts: number,
): Promise<LegPlan> {
  const plan: LegPlan = { towns: [], subLegs: [], warnings: [] }
  let frontier = from
  let iterations = 0

  while (true) {
    if (++iterations > maxInserts + 5) {  // hard backstop against any pathological loop
      plan.warnings.push(`iteration backstop tripped on ${from.locationName}→${to.locationName}`)
      break
    }

    const detail = await fetchLegDetail(frontier, to, apiKey)
    if (!detail) {
      plan.warnings.push(`routing failed ${frontier.locationName}→${to.locationName}; leaving leg as-is`)
      // Record nothing for this tail (unknown) — fail soft.
      break
    }

    // Fits in one comfortable day (within grace) → final sub-leg, done. This
    // covers both "already short" legs and "barely over" legs (no stub split).
    if (detail.durationSec <= capSec + graceSec) {
      plan.subLegs.push({ from: frontier.locationName, to: to.locationName, hours: detail.durationSec / 3600, over: false })
      break
    }

    // Out of insert budget → leave the over-cap tail and warn.
    if (plan.towns.length >= maxInserts) {
      plan.subLegs.push({ from: frontier.locationName, to: to.locationName, hours: detail.durationSec / 3600, over: true })
      plan.warnings.push(
        `hit MAX_INSERTS_PER_LEG=${maxInserts} on ${from.locationName}→${to.locationName}; ` +
        `tail ${frontier.locationName}→${to.locationName} left at ${(detail.durationSec / 3600).toFixed(1)}h`,
      )
      break
    }

    // Even division of the REMAINING route into balanced days, each ≤ cap.
    let days = Math.ceil(detail.durationSec / capSec)
    // MIN_USEFUL floor: prefer fewer, slightly-longer (still-legal) days over a
    // sub-leg that's too short to be worth stopping for.
    while (days > 1 && detail.durationSec / days < minUsefulSec) days--
    const targetSec = detail.durationSec / days   // ≤ capSec by construction

    // Place a town ~targetSec into the REAL remaining route. Retry closer if the
    // named town snapped too far (measured frontier→town over cap+tolerance).
    let placed = false
    let tryTarget = targetSec
    for (let attempt = 0; attempt < 3; attempt++) {
      const pt = interpolateSplitPoint(detail, tryTarget)
      if (!pt) break
      // Reverse-geocode the exact point; if it lands in empty wilderness
      // (ZERO_RESULTS / no locality), fall back to the nearest real town/place
      // so the split can always be NAMED and therefore inserted.
      let town: TransitTown | null = null
      const rg = await reverseGeocode(pt.lat, pt.lng, apiKey)
      if (rg) {
        town = { locationName: rg.city, locationState: rg.state, latitude: rg.lat, longitude: rg.lng }
      } else {
        town = await findNearestTown(pt.lat, pt.lng, apiKey)
      }
      if (!town) { tryTarget *= 0.8; continue }
      // Don't accept a town that is effectively the frontier or the destination.
      if (
        town.locationName.toLowerCase() === frontier.locationName.toLowerCase() ||
        town.locationName.toLowerCase() === to.locationName.toLowerCase()
      ) { tryTarget *= 0.8; continue }

      const sub = await fetchLegDetail(frontier, town, apiKey)
      if (!sub) { tryTarget *= 0.8; continue }
      if (sub.durationSec <= capSec + tolSec) {
        plan.towns.push(town)
        plan.subLegs.push({ from: frontier.locationName, to: town.locationName, hours: sub.durationSec / 3600, over: false })
        frontier = town
        placed = true
        break
      }
      tryTarget *= 0.8  // overshoot — pull the split closer and retry
    }

    if (!placed) {
      plan.subLegs.push({ from: frontier.locationName, to: to.locationName, hours: detail.durationSec / 3600, over: true })
      plan.warnings.push(
        `could not place an under-cap split for ${frontier.locationName}→${to.locationName} after retries; leaving remainder as-is`,
      )
      break
    }
  }

  return plan
}

// ─── Transit-insert planner (pure, DB-free) ──────────────────────────────────
/**
 * Per-user daily drive cap in HOURS — the SINGLE source of truth for the
 * drive-time check (build's expandLongLegs and planning's transit-insert both
 * call this; never re-derive inline). Mirrors the planner prompt's DRIVE-TIME
 * CONSTRAINT fallback chain: maxDriveHours → derive from maxMilesPerDay
 * (~55 mph) → default 6h.
 */
export function deriveCapHours(
  travelProfile: { maxDriveHours?: number | null; maxMilesPerDay?: number | null } | null | undefined,
): number {
  let maxHours = travelProfile?.maxDriveHours ?? null
  if (maxHours == null && travelProfile?.maxMilesPerDay != null) maxHours = travelProfile.maxMilesPerDay / 55
  if (maxHours == null || maxHours <= 0) maxHours = 6
  return maxHours
}

/**
 * PLAN-IS-TRUTH (Part 2, step 1) — the measurement/splitting CORE extracted out
 * of expandLongLegs so the SAME deterministic drive-time check can run during
 * PLANNING (on the AI's city-name itinerary) as well as at build. Single source
 * of truth: build and planning can never disagree about which legs need a stop.
 *
 * Given an ORDERED stop list, the per-user drive cap in HOURS, and a Google Maps
 * key, it walks each leg with REAL Google Directions times (via planLegSplits →
 * fetchLegDetail, which works on lat/lng OR "City, State" strings — so it does
 * NOT require pre-geocoded coords) and returns:
 *   - inserts: one entry per leg that needs splitting — the index/order of the
 *     stop the transit stops go AFTER, the OVERNIGHT_ONLY towns to add, and the
 *     measured drive time of that leg (legHours) for honest narration.
 *   - stops:   a NEW array with the OVERNIGHT_ONLY transit stops spliced in and
 *     `order` renumbered 1..N. The input array is never mutated.
 *
 * IDEMPOTENT BY CONSTRUCTION (Part 2, step 2). The unit of work is the SEGMENT
 * between two consecutive REAL (non-OVERNIGHT_ONLY) stops:
 *   - A segment that ALREADY contains an OVERNIGHT_ONLY is "answered" — it was
 *     split on a prior turn — so it is SKIPPED: no measurement, no re-insertion.
 *     Re-emitting an unchanged itinerary therefore makes ZERO Google calls for
 *     every leg that needed a stop, and a transit stop can never be DOUBLED.
 *   - An EMPTY adjacent real→real segment is measured once. A stop removal that
 *     merges two legs leaves an empty (longer) segment, so the merged leg reads
 *     as unanswered and is correctly re-measured. The decision lives in the LEG
 *     structure itself (the presence/absence of the overnight) — there is NO
 *     separate snapshot of prior stop state to keep in sync.
 *   (Residual by design: an under-cap direct leg carries no structural "fine"
 *   marker, so it is re-measured — one cheap fetchLegDetail — on each emit. That
 *   is the accepted cost of having no second memory.)
 *
 * PURE: no prisma, no req/res, no DB writes. Callers decide how to persist
 * (build → DB writes; planning → re-serialize into the <itinerary> JSON).
 * Fail-soft per leg is inherited from planLegSplits (a routing failure leaves
 * that leg unsplit and is logged, never throws).
 */
export interface PlannableStop {
  locationName: string
  locationState?: string | null
  latitude?: number | null
  longitude?: number | null
  order?: number
  type?: string
  nights?: number
  [key: string]: any
}
export interface TransitInsert {
  /** 0-based index, in the INPUT array, of the stop the towns go AFTER. */
  afterIndex: number
  /** The input stop's `order` if present (build uses it for the order-shift); null otherwise. */
  afterOrder: number | null
  /** OVERNIGHT_ONLY towns to insert, in route order. */
  towns: TransitTown[]
  /** Measured total drive time of the original (pre-split) leg, in hours. */
  legHours: number
}
export interface PlanTransitResult {
  stops: PlannableStop[]
  inserts: TransitInsert[]
}

export async function planTransitInserts(
  stops: PlannableStop[],
  capHours: number,
  apiKey: string,
  ackKeys: Set<string> = new Set(),
): Promise<PlanTransitResult> {
  // No key or fewer than two stops → nothing to measure; return the input
  // unchanged (defensive copy) so callers can treat the result uniformly.
  if (!apiKey || !Array.isArray(stops) || stops.length < 2) {
    return { stops: [...(stops ?? [])], inserts: [] }
  }

  // Cap derivation lives in the caller (it may read the travel profile); here we
  // only guard a non-positive cap. Mirrors expandLongLegs's final clamp.
  let maxHours = capHours
  if (maxHours == null || maxHours <= 0) maxHours = 6
  const capSec       = maxHours * 3600
  const graceSec     = LEG_GRACE_HOURS * 3600
  const minUsefulSec = LEG_MIN_USEFUL_HOURS * 3600
  const tolSec       = LEG_DRIFT_TOLERANCE_MIN * 60
  const maxInserts   = MAX_TRANSIT_INSERTS_PER_LEG

  const inserts: TransitInsert[] = []

  // Walk SEGMENTS between consecutive REAL (non-OVERNIGHT_ONLY) stops. A segment
  // that already has an overnight between its endpoints is answered → skipped; an
  // empty adjacent segment is measured once. See the idempotency note above.
  const realIdx: number[] = []
  for (let i = 0; i < stops.length; i++) {
    if ((stops[i] as any).type !== 'OVERNIGHT_ONLY') realIdx.push(i)
  }

  for (let k = 1; k < realIdx.length; k++) {
    const a = realIdx[k - 1]
    const b = realIdx[k]
    // Already-answered: one or more OVERNIGHT_ONLY stops sit between the two real
    // stops (b is not directly after a). Skip — no Google calls, no double-insert.
    if (b > a + 1) continue

    // ACKNOWLEDGED long leg: the user explicitly opted into this as one drive
    // ("keep the long drive"). Do NOT measure or re-insert — the confirm IS the
    // acknowledgment. Keyed by the two real endpoint stop ids; planning stops have
    // no id, so this never matches on the planning path.
    if (ackKeys.has(`${(stops[a] as any).id}|${(stops[b] as any).id}`)) continue

    const from: any = stops[a]
    const to:   any = stops[b]
    const fromTown: TransitTown = { locationName: from.locationName, locationState: from.locationState, latitude: from.latitude, longitude: from.longitude }
    const toTown:   TransitTown = { locationName: to.locationName,   locationState: to.locationState,   latitude: to.latitude,   longitude: to.longitude }

    const legPlan = await planLegSplits(fromTown, toTown, apiKey, capSec, graceSec, minUsefulSec, tolSec, maxInserts)

    // Per-leg log: original leg + the resulting sub-leg durations (with any
    // still-over markers and warnings) so over-cap tails are never hidden.
    // (Template literals — Node's console.log does NOT support %.1f.)
    // Always log the measured leg (even a clean under-cap pass) so a "why no
    // overnight?" question is answerable from the log: it shows the REAL measured
    // hours vs the cap (a leg ≤ cap + LEG_GRACE_HOURS stays one day). Warnings
    // (over-cap tails, routing failures) still print separately.
    const subLegStr = legPlan.subLegs
      .map(sl => `${sl.from}→${sl.to} ${sl.hours.toFixed(1)}h${sl.over ? ' [OVER CAP]' : ''}`)
      .join(' | ')
    console.log(
      `[planTransitInserts] leg ${from.locationName}→${to.locationName} ` +
      `(cap ${maxHours.toFixed(1)}h +${LEG_GRACE_HOURS}h grace): ${legPlan.towns.length} transit stop(s) → ` +
      `${subLegStr || '(no split — within cap+grace)'}`,
    )
    for (const w of legPlan.warnings) console.warn('[planTransitInserts] %s', w)

    if (legPlan.towns.length > 0) {
      // Measured drive time of the leg = sum of the placed sub-legs (they
      // partition the real route through the transit towns).
      const legHours = legPlan.subLegs.reduce((h, sl) => h + sl.hours, 0)
      inserts.push({
        afterIndex: a,
        afterOrder: typeof from.order === 'number' ? from.order : null,
        towns: legPlan.towns,
        legHours,
      })
    }
  }

  // Build a NEW spliced stop array with the transit towns inserted and `order`
  // renumbered 1..N. The input array is never mutated.
  const townsByAfterIndex = new Map<number, TransitTown[]>()
  for (const ins of inserts) townsByAfterIndex.set(ins.afterIndex, ins.towns)

  const splicedStops: PlannableStop[] = []
  for (let i = 0; i < stops.length; i++) {
    splicedStops.push({ ...stops[i] })
    const towns = townsByAfterIndex.get(i)
    if (towns) {
      for (const t of towns) {
        splicedStops.push({
          type: 'OVERNIGHT_ONLY',
          locationName: t.locationName,
          locationState: t.locationState,
          latitude: t.latitude,
          longitude: t.longitude,
          nights: 1,
        })
      }
    }
  }
  splicedStops.forEach((s, idx) => { s.order = idx + 1 })

  return { stops: splicedStops, inserts }
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

// JournalEntry is now a one-to-many on Stop (freeform diary, step 1 of the
// rebuild). The trip/stop API contract still exposes a singular `journalEntry`
// (the live per-stop journal feature is still one-entry-per-stop), so collapse
// the relation list to its first element when shaping responses. The full diary
// UI consumes the list directly via GET /journal.
//
// IMPORTANT: callers MUST include journalEntries with `orderBy: { createdAt:
// 'asc' }` so this [0] pick is DETERMINISTIC — the oldest entry (the original
// per-stop entry written via the upsert path) is the one the trip UI edits.
// Without an explicit order Prisma returns rows in arbitrary order, which would
// make the singular pick non-deterministic if a stop ever holds >1 entry.
function collapseJournal<S extends { journalEntries?: unknown[] }>(
  stop: S,
): Omit<S, 'journalEntries'> & { journalEntry: unknown } {
  const { journalEntries, ...rest } = stop
  return { ...rest, journalEntry: journalEntries?.[0] ?? null }
}

export async function getTrip(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: {
        stops: { orderBy: { order: 'asc' }, include: { journalEntries: { orderBy: { createdAt: 'asc' } } } },
        // Trip-scoped party for the packing "Made for X" subtitle + staleness.
        party: { include: { people: true, pets: true } },
      },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    // Packing staleness context — only when a list exists (skips the extra
    // default-party lookup for trips without one). Resolution mirrors the
    // generator exactly: trip.party ?? user-default. Legacy lists (meta null)
    // come back stale=false via computeStaleness — no false alarm.
    let packingContext = null
    if (trip.packingList) {
      let party: any = trip.party
      if (!party) {
        const user = await prisma.user.findUnique({
          where: { id: req.user!.id },
          include: { parties: { where: { isDefault: true }, include: { people: true, pets: true }, take: 1 } },
        })
        party = user?.parties?.[0] ?? null
      }
      const current = resolvePackingCounts(party, trip)
      const meta = (trip.packingListMeta as any) ?? null
      packingContext = { packingListMeta: meta, current, ...computeStaleness(meta, current) }
    }

    res.json({ ...trip, stops: trip.stops.map(collapseJournal), packingContext })
  } catch (err) { next(err) }
}

// ─── RIG-CHANGE (Phase 1) — shared rig resolution + guarded swap core ─────────

/**
 * Resolve the rig a trip is planned against: the explicitly-assigned `rigId` if
 * set, else the user's default rig (isDefault=true). BOTH lookups are scoped to
 * userId so a forged/foreign id can never lift another user's rig — a miss falls
 * through to the default, and if there's no default either, returns null. Callers
 * treat null as "rig not recorded" and never fabricate. Mirrors the inline
 * two-step resolution in getTripFuelEstimate (the live FK lookup).
 */
async function resolveTripRig(rigId: string | null, userId: string) {
  if (rigId) {
    const assigned = await prisma.rig.findFirst({ where: { id: rigId, userId } })
    if (assigned) return assigned
  }
  return prisma.rig.findFirst({ where: { userId, isDefault: true } })
}

/** Human label for a rig — "[year] [make] [model]", falling back to the
 *  vehicleType enum when none of those are set. Mirrors the client's rig-chip
 *  derivation (SessionPage.tsx) so the stamp reads the same as the UI. */
function rigDisplayName(rig: { year: number | null; make: string | null; model: string | null; vehicleType: string }): string {
  const ymm = [rig.year, rig.make, rig.model].filter(Boolean).join(' ').trim()
  return ymm || rig.vehicleType
}

/** Booking states that represent a real reservation — never auto-altered by a
 *  rig swap. NOT_BOOKED stops are re-filterable; CANCELLED is left alone. */
const BOOKED_STATES: string[] = ['CONFIRMED', 'PENDING', 'WAITLISTED']

export interface RigSwapResult {
  isLarger: boolean
  deltas: { length: number; height: number; weight: number }
  bookedStopsNeedingReverify: Array<{ stopId: string; name: string; bookedForRigName: string | null }>
  refilteredStopIds: string[]
}

/**
 * Guarded rig swap for an existing trip. Repoints Trip.rigId, then:
 *   - decides isLarger using LENGTH/HEIGHT/WEIGHT (towed EXCLUDED — both a toad
 *     and a tow vehicle detach at camp; the rig's own length is the footprint);
 *   - for NOT_BOOKED stops, when the new rig is larger, clears the now-stale fit
 *     REASONS (computed against the old rig) and reports them as re-filtered —
 *     it does NOT fabricate a new isCompatible; the precise re-check happens on
 *     TripBookingPage open, as it does today;
 *   - for CONFIRMED/PENDING/WAITLISTED stops, NEVER touches the stop, its
 *     booking, or its bookedForRig* stamp — only collects them (when larger) as
 *     needing manual re-verification with the campground.
 * Fuel self-heals on the next getTripFuelEstimate read (live rig lookup), so no
 * fuel action here. Returns a payload Phase 2's UI renders the warning from.
 *
 * Both rigs are resolved scoped to userId (defense-in-depth), independent of
 * what's currently persisted, so the delta is correct regardless of call order.
 */
async function applyRigChange(
  tripId: string,
  oldRigId: string | null,
  newRigId: string,
  userId: string,
): Promise<RigSwapResult> {
  const [oldRig, newRig] = await Promise.all([
    resolveTripRig(oldRigId, userId),
    resolveTripRig(newRigId, userId),
  ])

  const oldLen = oldRig?.length ?? 0, oldH = oldRig?.height ?? 0, oldW = oldRig?.gvwr ?? 0
  const newLen = newRig?.length ?? 0, newH = newRig?.height ?? 0, newW = newRig?.gvwr ?? 0
  // LENGTH-only footprint: towed length is intentionally NOT compared — the toad
  // / tow vehicle detaches at the site, so only the rig's own length matters.
  const isLarger = newLen > oldLen || newH > oldH || newW > oldW
  const deltas = { length: newLen - oldLen, height: newH - oldH, weight: newW - oldW }

  const stops = await prisma.stop.findMany({
    where: { tripId },
    orderBy: { order: 'asc' },
    select: { id: true, locationName: true, bookingStatus: true, bookedForRigName: true },
  })

  const bookedStopsNeedingReverify: RigSwapResult['bookedStopsNeedingReverify'] = []
  const refilteredStopIds: string[] = []

  // Always repoint the rig (the actual swap). Stop-fit writes only when larger.
  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.trip.update({ where: { id: tripId }, data: { rigId: newRigId } }),
  ]

  if (isLarger) {
    for (const s of stops) {
      if (BOOKED_STATES.includes(s.bookingStatus)) {
        // Real reservation — never altered; flagged for manual re-verify.
        bookedStopsNeedingReverify.push({
          stopId: s.id,
          name: s.locationName,
          bookedForRigName: s.bookedForRigName,
        })
      } else if (s.bookingStatus === 'NOT_BOOKED') {
        // Stale fit reasons referenced the OLD rig's dimensions — clear them and
        // report for re-check. isCompatible is left as-is (not fabricated).
        writes.push(prisma.stop.update({
          where: { id: s.id },
          data: { incompatibilityReasons: Prisma.DbNull },
        }))
        refilteredStopIds.push(s.id)
      }
      // CANCELLED (or any other state): left untouched.
    }
  }

  await prisma.$transaction(writes)

  console.log(
    '[applyRigChange] tripId=%s old=%s new=%s isLarger=%s deltas=%j reverify=%d refiltered=%d',
    tripId, oldRigId ?? 'default', newRigId, isLarger, deltas,
    bookedStopsNeedingReverify.length, refilteredStopIds.length,
  )

  return { isLarger, deltas, bookedStopsNeedingReverify, refilteredStopIds }
}

export async function updateTrip(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Defense-in-depth: ownership check stays even though validateBody has already
    // stripped any client-supplied userId/sharedToken/packingList/etc. from the payload.
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)

    // req.body is guaranteed to be a parsed TripUpdateInput by validateBody on the route.
    // modifyActionId (RIG-CHANGE Phase 3) is AI-MESA-10 apply-stamp plumbing, not a
    // Trip column — pulled out so it never reaches prisma.trip.update.
    const { modifyActionId, ...data } = req.body as TripUpdateInput
    // RIG-CHANGE (Phase 1): capture the pre-update rigId before the write so the
    // swap delta is computed against the genuine OLD rig. A swap is when the body
    // sets a non-empty rigId that differs from the current one. (rigId → null, i.e.
    // unassign-to-default, is not treated as a larger-rig swap.)
    const oldRigId = trip.rigId
    const newRigId = typeof data.rigId === 'string' && data.rigId.length > 0 ? data.rigId : null
    const rigChanging = newRigId !== null && newRigId !== oldRigId
    // See sessions.ts:145 for the rationale on the adHocVehicle cast — Zod
    // typed it as Record<string, unknown> which TS can't prove satisfies
    // Prisma.InputJsonValue; the cast bridges the two type systems without
    // changing runtime behavior (null still nulls, undefined still skips).
    const updated = await prisma.trip.update({
      where: { id: req.params.id },
      data: { ...data, adHocVehicle: data.adHocVehicle as Prisma.InputJsonValue | undefined },
    })
    // When the rig actually changed, run the guarded swap (re-point is idempotent
    // with the write above; the value matches). The swap recomputes/flags fit and
    // returns the warning payload for Phase 2's UI. Booked reservations are never
    // altered. Failure here must not 500 a successful trip update, so it's guarded.
    let rigSwap: RigSwapResult | null = null
    if (rigChanging) {
      try {
        rigSwap = await applyRigChange(req.params.id, oldRigId, newRigId!, req.user!.id)
      } catch (e: any) {
        console.warn('[applyRigChange] updateTrip tripId=%s failed: %s', req.params.id, e?.message)
      }
    }
    // AI-MESA-10 — when this update applied an AI-proposed change_rig action (the
    // Modify panel threads modifyActionId), stamp the persisted proposal
    // applied=true now that the mutation executed. Never throws; no-ops if absent.
    await stampModifyActionApplied(req.params.id, modifyActionId)
    res.json(rigSwap ? { ...updated, rigSwap } : updated)
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

    const { newStartDate, modifyActionId }: TripShiftDatesInput = req.body
    // .find() above asserts arrivalDate is non-null, but TS doesn't narrow
    // through .find predicates — the ! is the minimal cast.
    const currentStartMs = anchorStop.arrivalDate!.getTime()
    const deltaMs = newStartDate.getTime() - currentStartMs

    // No-op shortcut: same date in, same trip out. Mirror getTrip's return
    // shape so the client can hot-swap state either way. Still counts as an
    // executed apply for AI-MESA-10 stamping — the user clicked Apply and the
    // trip now (trivially) matches the proposal.
    if (deltaMs === 0) {
      await stampModifyActionApplied(trip.id, modifyActionId)
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
        include: { stops: { orderBy: { order: 'asc' }, include: { journalEntries: { orderBy: { createdAt: 'asc' } } } } },
      })
    })

    console.log(
      '[shiftTripDates] tripId=%s deltaDays=%d stopsShifted=%d',
      trip.id,
      Math.round(deltaMs / 86400000),
      trip.stops.filter(s => s.arrivalDate != null || s.departureDate != null).length,
    )

    // AI-MESA-10 — verified apply stamp (transaction committed above). Never throws.
    await stampModifyActionApplied(trip.id, modifyActionId)
    res.json(updated ? { ...updated, stops: updated.stops.map(collapseJournal) } : updated)
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
      include: { journalEntries: { orderBy: { createdAt: 'asc' } } },
    })
    res.json(stops.map(collapseJournal))
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
      // Only pin to exact home coords when the parsed city IS the user's home city.
      // If the trip departs from elsewhere (e.g. "San Jose to Shenandoah"), store
      // null coords so the client geocoder resolves the real start location.
      // Same city-match logic as looksLikeHome below — reuse normalizeCity.
      const prepNameMatchesHome =
        !!homeOwner?.homeCity &&
        !!homeName &&
        normalizeCity(homeName) === homeOwner.homeCity.toLowerCase().trim()
      const prepLat = prepNameMatchesHome ? exactHomeLat : null
      const prepLng = prepNameMatchesHome ? exactHomeLng : null
      console.log('[createStop] First stop is not HOME — auto-creating HOME stop for startLocation=%s cityMatch=%s prepLat=%s prepLng=%s',
        raw, prepNameMatchesHome, prepLat, prepLng)
      await prisma.stop.create({
        data: {
          type: 'HOME',
          locationName: homeName,
          locationState: homeState,
          latitude: prepLat,
          longitude: prepLng,
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

    // Use exact home coordinates only when the stop's city matches the owner's homeCity.
    // This covers two cases:
    //   • HOME-typed start stop on a trip departing FROM home (Mesa→Flagstaff):
    //     type=HOME, city=Mesa → looksLikeHome true → home coords used ✓
    //   • DESTINATION-typed return-home stop on round trips (the AI must emit the
    //     final stop as DESTINATION, but its city matches homeCity) → home coords used ✓
    // When the city does NOT match — e.g. a trip starting from San Jose, which the AI
    // correctly labels type=HOME but whose city ≠ homeCity — home coords are NOT used.
    // resolvedLat/Lng fall through to the incoming AI value (null), which the client
    // geocoder then resolves to the actual start city's coordinates.
    const looksLikeHome =
      !!homeOwner?.homeCity &&
      !!locationName &&
      normalizeCity(locationName) === homeOwner.homeCity.toLowerCase().trim()
    const useHomeCoords = looksLikeHome && exactHomeLat != null && exactHomeLng != null
    const resolvedLat = useHomeCoords ? exactHomeLat : (latitude ?? null)
    const resolvedLng = useHomeCoords ? exactHomeLng : (longitude ?? null)
    if (looksLikeHome && type !== 'HOME' && useHomeCoords) {
      console.log(`[createStop:homeCoords] backfill via city match — locationName="${locationName}" (type=${type}) matches homeCity="${homeOwner!.homeCity}" → using home coords (${exactHomeLat}, ${exactHomeLng})`)
    }
    if (type === 'HOME' && !looksLikeHome) {
      console.log(`[createStop:homeCoords] HOME stop city mismatch — locationName="${locationName}" ≠ homeCity="${homeOwner?.homeCity ?? 'none'}" → null coords (will be geocoded by client)`)
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

    // ADDSTOP-RESLOT Phase B — for a MODIFY add_stop (modifyActionId present) of a
    // non-HOME stop, re-slot the new stop into its geographically-correct position
    // BEFORE syncTripEndpoints + recomputeStopDates run, so both operate on the final
    // order. Guarded — a geocode/reslot failure never blocks the successful insert.
    const isModifyAdd = typeof req.body.modifyActionId === 'string'
    if (isModifyAdd && type !== 'HOME') {
      try {
        await geoReslotModifyStop(req.params.id, stop.id, locationName, locationState)
      } catch (e: any) {
        console.warn('[geoReslot] createStop tripId=%s failed: %s', req.params.id, e?.message)
      }
    }

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
    // PLAN-IS-TRUTH (Part 2, step 3) — a new stop can create an over-cap leg.
    // Re-check now, AFTER the insert + reslot + resequence + recompute, so we
    // measure the SETTLED list (the new stop is already in its correct position —
    // manual-add passes `order`, modify-add reslots above — never a transient end
    // leg). OPT-OUT direction: the build loop sets skipLongLegCheck because the
    // approved plan already carries its transit stops (Part 2 step 2) and a
    // per-stop re-check during bulk assembly would be wasteful; every other caller
    // (manual add, modify add) re-checks by default, so a forgotten flag is a
    // harmless redundant idempotent check, never a missed insert. Fail-soft.
    let createTransitNote: string | null = null
    if (req.body.skipLongLegCheck !== true) {
      createTransitNote = (await recheckLongLegs(req.params.id, req.user!.id)).note
    }
    // Refetch the stop so the response reflects the post-recompute
    // arrivalDate/departureDate. The caller (ModifyTripPanel) does its
    // own GET-trip refetch afterward, but returning fresh dates here
    // keeps the contract honest for any future caller that consumes
    // the create response directly.
    // AI-MESA-10 — verified apply stamp: when the Modify panel applied an
    // AI-proposed action via this endpoint, mark the persisted proposal
    // applied=true now that the mutation actually executed. (createStop has
    // no Zod schema; the field-whitelist destructure above keeps the id off
    // the Stop row.) Never throws.
    if (typeof req.body.modifyActionId === 'string') {
      await stampModifyActionApplied(req.params.id, req.body.modifyActionId)
    }

    // ADDSTOP-RESLOT Phase B — after re-slot + date recompute, surface any BOOKED
    // stop whose itinerary arrivalDate now differs from the originalBookedDate
    // stamped at booking (Phase A). The reservation is NOT altered — only the trip's
    // date moved (decision 2c: allow + warn). Returned in the response so the modify
    // Apply flow can show the heads-up; the per-stop note is data-derived client-side.
    let shiftedBookedStops: Array<{ stopId: string; name: string; originalBookedDate: string; newArrivalDate: string }> = []
    if (isModifyAdd) {
      const post = await prisma.stop.findMany({
        where: { tripId: req.params.id },
        select: { id: true, locationName: true, bookingStatus: true, arrivalDate: true, originalBookedDate: true },
      })
      shiftedBookedStops = post
        .filter(s =>
          BOOKED_STATES.includes(s.bookingStatus) &&
          s.originalBookedDate != null && s.arrivalDate != null &&
          s.arrivalDate.getTime() !== s.originalBookedDate.getTime(),
        )
        .map(s => ({
          stopId: s.id,
          name: s.locationName,
          originalBookedDate: s.originalBookedDate!.toISOString(),
          newArrivalDate: s.arrivalDate!.toISOString(),
        }))
      if (shiftedBookedStops.length) {
        console.log('[createStop] %d booked stop(s) date-shifted by insert on trip %s',
          shiftedBookedStops.length, req.params.id)
      }
    }

    const finalStop = await prisma.stop.findUnique({ where: { id: stop.id } })
    const createResponse: any = { ...(finalStop ?? stop) }
    if (shiftedBookedStops.length) createResponse.shiftedBookedStops = shiftedBookedStops
    if (createTransitNote) createResponse.transitNote = createTransitNote
    res.status(201).json(createResponse)
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
    // modifyActionId is AI-MESA-10 apply-stamp plumbing, not a Stop column —
    // pulled out alongside routeHighlights so it never reaches prisma.update.
    const { routeHighlights, modifyActionId, ...data } = body

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

    // RIG-CHANGE (Phase 1) — accountability stamp. On a transition INTO a booked
    // state (CONFIRMED/PENDING/WAITLISTED) from a non-booked one, record the rig
    // this site was booked against. Server-injected — StopUpdateSchema is .strict()
    // so the client cannot send bookedForRig*. We do NOT clear the stamp on a later
    // un-book (CONFIRMED → NOT_BOOKED): the record of what a site was booked against
    // has historical value, and a re-book re-stamps the then-current rig. If no rig
    // resolves (no rigId and no default), the stamp stays null — honest "not
    // recorded", never fabricated.
    const stampPatch: Prisma.StopUpdateInput = {}
    const wasBooked = BOOKED_STATES.includes(stop.bookingStatus)
    const nowBooked = !!data.bookingStatus && BOOKED_STATES.includes(data.bookingStatus)
    if (!wasBooked && nowBooked) {
      const rig = await resolveTripRig(trip.rigId, req.user!.id)
      if (rig) {
        stampPatch.bookedForRigName = rigDisplayName(rig)
        stampPatch.bookedForRigType = rig.vehicleType
        stampPatch.bookedForRigLength = rig.length
        stampPatch.bookedForRigTowedLength = rig.towedLength
        stampPatch.bookedForRigHeight = rig.height
        stampPatch.bookedForRigWeight = rig.gvwr
        stampPatch.bookedForRigAt = new Date()
        console.log('[updateStop] booked-transition stamp stopId=%s status=%s rig="%s"',
          req.params.stopId, data.bookingStatus, stampPatch.bookedForRigName)
      } else {
        console.log('[updateStop] booked-transition but no rig resolved — stamp left null stopId=%s', req.params.stopId)
      }

      // ADDSTOP-RESLOT Phase A — reservation-truth stamp. Capture the arrivalDate
      // this stop is booked FOR at the booked transition, so a later itinerary
      // shift (inserting a stop ahead of it) can surface "originally booked for
      // [date]". Stamped OUTSIDE the rig branch above — a booking has a date
      // whether or not a rig is on file. Uses the effective arrival being persisted
      // (data.arrivalDate) else the stored arrival; if neither exists, leave it null
      // (no date to record — and don't overwrite a prior record with null on a
      // dateless re-book). recomputeStopDates never touches this column, so it
      // survives a later shift. Re-stamped on each re-book; never cleared on un-book
      // (historical record, like bookedForRig*). Server-injected — StopUpdateSchema
      // is .strict(), so the client cannot send originalBookedDate.
      const bookedArrival = data.arrivalDate ?? stop.arrivalDate
      if (bookedArrival) {
        stampPatch.originalBookedDate = bookedArrival
        console.log('[updateStop] originalBookedDate stamp stopId=%s date=%s',
          req.params.stopId, bookedArrival instanceof Date ? bookedArrival.toISOString() : bookedArrival)
      }
    }

    const updated = await prisma.stop.update({
      where: { id: req.params.stopId },
      data: { ...data, ...stampPatch },
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
    // PLAN-IS-TRUTH (Part 2, step 3) — re-check the drive cap ONLY when this edit
    // actually changed a leg: a type toggle (DESTINATION↔OVERNIGHT_ONLY changes
    // which segments are "answered") or a relocation (locationName/state/lat/lng
    // move a stop). A pure nights/booking/notes edit leaves the geometry untouched,
    // so it skips the check (no wasted Directions calls). Runs on the settled,
    // already-resequenced list above. Idempotent + fail-soft. `order` is
    // deliberately NOT a trigger — there is no drag-reorder, and the only
    // order-writing client paths were dropped (see createStop/deleteStop notes).
    const legAffectingChanged =
      (data.type !== undefined && data.type !== stop.type) ||
      (data.locationName !== undefined && data.locationName !== stop.locationName) ||
      (data.locationState !== undefined && data.locationState !== stop.locationState) ||
      (data.latitude !== undefined && data.latitude !== stop.latitude) ||
      (data.longitude !== undefined && data.longitude !== stop.longitude)
    let updateTransitNote: string | null = null
    if (legAffectingChanged) {
      updateTransitNote = (await recheckLongLegs(req.params.id, req.user!.id)).note
    }
    // AI-MESA-10 — verified apply stamp (mutation succeeded above). Never throws.
    await stampModifyActionApplied(req.params.id, modifyActionId)
    res.json(updateTransitNote ? { ...updated, transitNote: updateTransitNote } : updated)
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

    // "Keep the long drive" (Part 2) — the user confirmed deleting this overnight
    // and keeping the merged leg as one drive. Capture the merged-leg endpoints
    // BEFORE the delete so we can mark the leg acknowledged afterward; the recheck
    // below (and every future one) then skips it instead of re-inserting.
    let ackLegKey: string | null = null
    if (req.query.acknowledgeLongLeg === 'true' && stop.type === 'OVERNIGHT_ONLY') {
      const ordered = await prisma.stop.findMany({ where: { tripId: req.params.id }, orderBy: { order: 'asc' } })
      const ep = overnightMergeEndpoints(ordered as any[], stop.id)
      if (ep) ackLegKey = `${ep.a.id}|${ep.b.id}`
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
    // Record the acknowledgment (if "keep the long drive") so the recheck below —
    // and every future recheck — skips this leg instead of re-inserting an overnight.
    if (ackLegKey) {
      const cur = await getAckLegKeys(req.params.id)
      cur.add(ackLegKey)
      await setAckLegKeys(req.params.id, [...cur])
    }
    // PLAN-IS-TRUTH (Part 2, step 3) — a delete MERGES two legs into one, which
    // can now exceed the drive cap. Re-check on the SETTLED, already-resequenced
    // list so the merged leg gets a transit stop if needed (unless acknowledged
    // above). Idempotent + fail-soft.
    const { note: deleteTransitNote } = await recheckLongLegs(req.params.id, req.user!.id)
    // AI-MESA-10 — verified apply stamp. DELETE has no body, so the Modify
    // panel threads the action id as a query param. Never throws.
    if (typeof req.query.modifyActionId === 'string') {
      await stampModifyActionApplied(req.params.id, req.query.modifyActionId)
    }
    // transitNote (Part 2, step 3 — modify parity): if the merged leg needed an
    // overnight, return the grounded note so the client (ModifyTripPanel) can tell
    // the user why a transit stop appeared. Omitted when nothing was inserted.
    res.json({ message: 'Stop deleted', ...(deleteTransitNote ? { transitNote: deleteTransitNote } : {}) })
  } catch (err) { next(err) }
}

/**
 * Long-leg delete PREVIEW (Part 2 "keep the long drive"). Before the client
 * finalizes deleting an OVERNIGHT_ONLY transit stop, it asks whether removing it
 * would create an over-cap leg that the recheck would otherwise re-insert on, and
 * returns the REAL measured drive time of the merged leg so the confirm modal can
 * show it. Read-only — no mutation. Mirrors planLegSplits' split trigger
 * (legHours > cap + grace), so the modal only appears when a delete would actually
 * be undone by a re-insert.
 */
export async function longLegPreview(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)
    const stops = trip.stops as any[]
    const target = stops.find(s => s.id === req.params.stopId)
    if (!target || target.type !== 'OVERNIGHT_ONLY') return res.json({ exceeds: false })

    const ep = overnightMergeEndpoints(stops, target.id)
    // No real neighbors, or another overnight remains between them → removing this
    // one won't create an empty over-cap leg, so there's nothing to confirm.
    if (!ep || ep.otherOvernightBetween) return res.json({ exceeds: false })

    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) return res.json({ exceeds: false })
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, include: { travelProfile: true } })
    const cap = deriveCapHours(user?.travelProfile)
    const detail = await fetchLegDetail(ep.a, ep.b, apiKey)
    if (!detail) return res.json({ exceeds: false })
    const legHours = detail.durationSec / 3600
    const exceeds = legHours > cap + LEG_GRACE_HOURS
    res.json({
      exceeds,
      legHours: Math.round(legHours * 10) / 10,
      cap,
      fromName: ep.a.locationName,
      toName: ep.b.locationName,
    })
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
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) throw new AppError('Google Maps API key not configured', 500)

    const stops = trip.stops as any[]
    if (!stops.length) return res.json({ base64: null })

    const params = new URLSearchParams()
    // Landscape image (640×583) matched to the cover box ratio (532×485pt ≈ 1.0969:1).
    // 640÷583 = 1.0978:1 → only 0.08% wider than the box, so objectFit:'contain'
    // fills the full width with a <0.5pt invisible top/bottom strip — no side-strips,
    // no distortion, no crop. Both dimensions are ≤640 (free-tier cap). scale=2
    // doubles output to 1280×1166px for sharp print/screen rendering.
    // center and zoom intentionally omitted — API auto-fits all markers + path.
    params.set('size', '640x583')
    params.set('scale', '2')
    params.set('maptype', 'roadmap')
    params.set('key', apiKey)

    // Build markers and path.
    //
    // BUG-MAP-PDF — on a ROUND_TRIP the origin and the final stop share the same
    // coordinates, so emitting both a Start and a Finish marker stacks two pins
    // at one point and the printed map misreads as one-way (the on-screen map
    // already solved this with the combinedSH merge + FINISH-ORIGIN-1). When
    // computeTripShape says ROUND_TRIP we emit ONE combined start/finish pin at
    // the origin — in the home/origin color #F97316 (matching the on-screen
    // combinedSH marker, MC.home; deliberately NOT the green used for the stop
    // pins) — and SKIP the final stop's marker. The path still includes the
    // closing leg back to the origin, so the loop itself is drawn (no hosted
    // arrow asset: Static Maps has no arrowhead and marker labels are a single
    // alphanumeric char, so the combined pin + closed-loop path is the signal).
    //
    // ONE-WAY is unchanged: separate green S and F pins, no combined marker.
    // FINISH-ORIGIN-1 alignment: round trips now collapse to the combined pin,
    // so the only remaining last-stop case is a one-way finish → 'F'. That makes
    // the endpoint rule origin-based (via computeTripShape) and retires the old
    // profile-home 'H'/'F' match that predated FINISH-ORIGIN-1.
    const isRoundTrip = computeTripShape(stops) === 'ROUND_TRIP'
    const firstStop = stops[0]
    const pathPoints: string[] = []
    const lastStop = stops[stops.length - 1]
    let stopNum = 1

    // BUG-MAP-PDF — the combined round-trip origin pin can read as the on-screen
    // "S/F" teardrop by pointing Static Maps at our own hosted icon
    // (client/public/sf-pin.png → <origin>/sf-pin.png). Google fetches that URL
    // SERVER-SIDE from its own servers, so it only works when our public origin
    // is reachable — i.e. a prod https host. On localhost Google can't reach the
    // dev box, so we gate the icon on a public https origin and otherwise fall
    // back to the single-char color:0xF97316|label:S pin. getClientOrigin returns
    // CLIENT_URL in prod, so dev (localhost / unset CLIENT_URL) auto-falls-back
    // with zero config. The PDF legend (TripPDF.tsx) names the pin either way.
    const base = getClientOrigin(req)
    const canUseIconPin =
      base.startsWith('https://') &&
      !/\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)
    const sfIconUrl = `${base}/sf-pin.png`

    for (const stop of stops) {
      if (!stop.latitude || !stop.longitude) continue
      const coord = `${stop.latitude},${stop.longitude}`
      pathPoints.push(coord)

      // Round-trip closing stop coincides with the origin — skip its marker so
      // it doesn't stack under the combined origin pin (which carries S/F duty).
      if (isRoundTrip && stop.id === lastStop.id && stop.id !== firstStop.id) continue

      // Combined start+finish pin on a round trip. Prefer the hosted S/F icon
      // when our public origin is reachable; otherwise the single-char fallback.
      // (icon: ignores color/label; anchor:bottom seats the teardrop tip on the
      // coord. URLSearchParams URL-encodes the icon URL, which Static Maps wants.)
      if (isRoundTrip && stop.id === firstStop.id) {
        if (canUseIconPin) {
          params.append('markers', `icon:${sfIconUrl}|anchor:bottom|${coord}`)
        } else {
          params.append('markers', `color:0xF97316|label:S|${coord}`)
        }
        continue
      }

      let label: string
      const markerColor = 'green'
      if (stop.id === firstStop.id) {
        label = 'S' // one-way start (round-trip start handled above)
      } else if (stop.id === lastStop.id) {
        label = 'F' // one-way finish (round trips skip this stop above)
      } else {
        label = String(stopNum++)
      }
      params.append('markers', `color:${markerColor}|label:${label}|${coord}`)
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

/**
 * Deterministic enforcement of the per-leg max-drive-time rule. The AI is told
 * (HARD RULE in the planner prompt) to insert transit stops so no leg exceeds
 * the user's maxDriveHours, but it routinely ignores it (e.g. an 872mi/13.5h
 * Mesa→Rawlins leg against a 6h cap). This guard walks each consecutive stop
 * pair using REAL Google Directions drive times, and breaks any over-long leg
 * into OVERNIGHT_ONLY transit stops at real towns sampled ~maxDriveHours apart.
 *
 * Runs server-side (the client only has straight-line Haversine, which
 * underestimates road time 20-40% — unsafe for a hard cap) and must run BEFORE
 * generateItinerary so the day-by-day narration sees the corrected stop set.
 * Only INSERTS transit stops between existing stops — never touches the HOME
 * stop, the final DESTINATION, or any existing stop's nights. Fails soft: any
 * per-leg routing/geocoding error leaves that leg as-is and is logged, never
 * aborting the build.
 */
/**
 * Grounded drive-time note, shared by the planning splice (controllers/ai.ts) and
 * recheckLongLegs below so both phrase it identically. Built ONLY from inserts
 * MADE THIS TURN, using the REAL measured legHours — no fabrication. Returns null
 * when nothing was inserted (a re-check that adds nothing announces nothing).
 * afterIndex+1 is the segment's far real stop (only empty adjacent real→real
 * segments ever yield an insert).
 */
export function buildTransitNote(
  inserts: TransitInsert[],
  preInsertStops: PlannableStop[],
  capHours: number,
): string | null {
  if (!inserts.length) return null
  const capLabel = Number.isInteger(capHours) ? `${capHours}-hour` : `${capHours.toFixed(1)}-hour`
  const sentences = inserts.map(ins => {
    const from = (preInsertStops[ins.afterIndex] as any)?.locationName ?? 'your previous stop'
    const to = (preInsertStops[ins.afterIndex + 1] as any)?.locationName ?? 'the next stop'
    const townPhrase = ins.towns
      .map(t => (t.locationState ? `${t.locationName}, ${t.locationState}` : t.locationName))
      .join(' and ')
    const added = ins.towns.length > 1 ? `overnight stops in ${townPhrase}` : `an overnight in ${townPhrase}`
    return `The ${from} → ${to} drive is about ${ins.legHours.toFixed(1)} hours, over your ${capLabel} limit, so I added ${added}.`
  })
  return sentences.join(' ')
}

/**
 * Acknowledged-long-leg store ("keep the long drive"). Persisted on the TRIP
 * (Trip.acknowledgedLongLegs, JSONB) so it works for EVERY trip — including manual
 * trips with no planning session, which previously couldn't store an ack and so
 * silently re-inserted the overnight. Each entry is "fromStopId|toStopId" — the two
 * adjacent REAL stops of a leg the user opted to keep as one drive. Null/absent =
 * none. (Pre-migration acks that lived in PlanningSession.partialTripData are not
 * migrated — harmless: the leg re-inserts once and the user can re-acknowledge.)
 */
async function getAckLegKeys(tripId: string): Promise<Set<string>> {
  try {
    const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { acknowledgedLongLegs: true } })
    const arr = Array.isArray(trip?.acknowledgedLongLegs) ? trip.acknowledgedLongLegs : []
    return new Set((arr as any[]).filter((x: any): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

async function setAckLegKeys(tripId: string, keys: string[]): Promise<void> {
  try {
    await prisma.trip.update({ where: { id: tripId }, data: { acknowledgedLongLegs: keys } })
  } catch (e: any) {
    console.warn('[recheckLongLegs] ack-leg persist failed tripId=%s: %s', tripId, e?.message)
  }
}

/** Adjacent-real-pair keys ("fromId|toId") for the current order — the only ack
 *  keys still valid. An ack whose endpoints are no longer consecutive real stops
 *  (a stop added/removed between them, or an endpoint deleted) is stale → pruned. */
function adjacentRealKeys(stops: any[]): Set<string> {
  const reals = stops.filter(s => s.type !== 'OVERNIGHT_ONLY')
  const set = new Set<string>()
  for (let i = 1; i < reals.length; i++) set.add(`${reals[i - 1].id}|${reals[i].id}`)
  return set
}

/** Real predecessor + successor of an OVERNIGHT_ONLY stop (its merged-leg endpoints
 *  once removed), plus whether ANOTHER overnight remains between them (in which case
 *  removing this one leaves the segment answered — no re-insert, no merge to confirm). */
function overnightMergeEndpoints(stops: any[], overnightId: string): { a: any; b: any; otherOvernightBetween: boolean } | null {
  const idx = stops.findIndex(s => s.id === overnightId)
  if (idx < 0) return null
  let a: any = null, b: any = null
  for (let i = idx - 1; i >= 0; i--) if (stops[i].type !== 'OVERNIGHT_ONLY') { a = stops[i]; break }
  for (let i = idx + 1; i < stops.length; i++) if (stops[i].type !== 'OVERNIGHT_ONLY') { b = stops[i]; break }
  if (!a || !b) return null
  const aIdx = stops.indexOf(a), bIdx = stops.indexOf(b)
  let otherOvernightBetween = false
  for (let i = aIdx + 1; i < bIdx; i++) if (stops[i].id !== overnightId && stops[i].type === 'OVERNIGHT_ONLY') otherOvernightBetween = true
  return { a, b, otherOvernightBetween }
}

/**
 * THE SINGLE DRIVE-TIME RE-CHECK CHOKE POINT (Part 2, step 3).
 *
 * Every server path that mutates a trip's stop set funnels through this one
 * function so the over-cap rule is enforced in exactly one place — never N
 * copies of the splice. It is the persist half of the old expandLongLegs:
 * measure with the shared pure core (planTransitInserts), then translate its
 * idempotent `inserts` into DB writes.
 *
 * Callers: deleteStop (always), createStop (unless the build loop opts out),
 * updateStop (only on a leg-affecting field change), and the HTTP wrapper
 * expandLongLegs below. Idempotent — re-running on a settled itinerary inserts
 * nothing (planTransitInserts skips real→real segments that already carry an
 * overnight), so a double-insert is impossible by construction.
 *
 * MUST run on a SETTLED, correctly-ordered stop list (callers invoke it AFTER
 * their own resequence), never on a transient half-reordered state — otherwise
 * it could measure a leg that won't exist and leave an orphan overnight.
 *
 * Fail-soft: ANY error (routing, geocode, DB) is swallowed and logged; the trip
 * is left as-is and the caller's response is never blocked.
 */
export async function recheckLongLegs(tripId: string, userId: string): Promise<{ inserted: number; note: string | null }> {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) {
      console.warn('[recheckLongLegs] tripId=%s SKIPPED — GOOGLE_MAPS_API_KEY not set (no transit stop this run)', tripId)
      return { inserted: 0, note: null }
    }

    const trip = await prisma.trip.findFirst({
      where: { id: tripId, userId },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) {
      console.warn('[recheckLongLegs] tripId=%s SKIPPED — trip not found', tripId)
      return { inserted: 0, note: null }
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { travelProfile: true },
    })
    // Shared single source of truth for the per-leg cap (see deriveCapHours).
    const maxHours = deriveCapHours(user?.travelProfile)

    const stops = trip.stops as any[]
    if (stops.length < 2) {
      console.log('[recheckLongLegs] tripId=%s stops=%d cap=%sh — too few stops, nothing to check', tripId, stops.length, maxHours)
      return { inserted: 0, note: null }
    }

    // Measurement + splitting is the shared pure core (planTransitInserts); here
    // we only translate its idempotent `inserts` into DB writes. Same check the
    // planning path runs, so build, planning, and post-build edits never disagree.
    // Always log entry AND outcome so this path is observable even when it inserts
    // 0 — a leg within cap+grace is a legitimate no-op, NOT a skipped call. (The
    // per-leg measured hours are logged by planTransitInserts.)
    // Acknowledged long legs the user opted to keep as one drive — never re-insert
    // on them. Prune any no longer adjacent real pairs (reset rule: endpoints
    // changed / a stop added or removed on the leg), persisting the prune.
    const storedAcks = await getAckLegKeys(tripId)
    const validAdj = adjacentRealKeys(stops)
    const effectiveAcks = new Set([...storedAcks].filter(k => validAdj.has(k)))
    if (effectiveAcks.size !== storedAcks.size) await setAckLegKeys(tripId, [...effectiveAcks])

    console.log('[recheckLongLegs] tripId=%s checking %d stop(s) against cap=%sh (%d acknowledged leg(s))', tripId, stops.length, maxHours, effectiveAcks.size)
    const { inserts } = await planTransitInserts(stops, maxHours, apiKey, effectiveAcks)
    if (inserts.length === 0) {
      console.log('[recheckLongLegs] tripId=%s no over-cap leg found — inserted 0', tripId)
      return { inserted: 0, note: null }
    }
    const note = buildTransitNote(inserts, stops, maxHours)

    // Apply insertions. Process gaps from HIGHEST afterOrder to LOWEST so each
    // order-shift only touches stops above an already-processed gap, leaving the
    // lower gaps' captured afterOrder values valid. (afterOrder is the DB `order`
    // of the stop the towns go after — always present on persisted rows.)
    const plans = inserts
      .map(ins => ({ afterOrder: (ins.afterOrder ?? stops[ins.afterIndex].order) as number, towns: ins.towns }))
      .sort((a, b) => b.afterOrder - a.afterOrder)

    let inserted = 0
    for (const plan of plans) {
      const k = plan.towns.length
      // Shift everything after the gap up by k to make room.
      await prisma.stop.updateMany({
        where: { tripId: trip.id, order: { gt: plan.afterOrder } },
        data: { order: { increment: k } },
      })
      for (let j = 0; j < k; j++) {
        const t = plan.towns[j]
        await prisma.stop.create({
          data: {
            tripId: trip.id,
            order: plan.afterOrder + 1 + j,
            type: 'OVERNIGHT_ONLY',
            locationName: t.locationName,
            locationState: t.locationState,
            latitude: t.latitude,
            longitude: t.longitude,
            nights: 1,
            bookingStatus: 'NOT_BOOKED',
            isCompatible: true,
          },
        })
        inserted++
      }
    }

    // Normalize orders to contiguous 1..N and refresh trip endpoints.
    await resequenceStops(trip.id)
    try {
      await syncTripEndpoints(trip.id)
    } catch (e: any) {
      console.warn('[recheckLongLegs] syncTripEndpoints failed (non-fatal):', e?.message)
    }
    // Inserted transit nights shift the schedule downstream — re-stamp dates so
    // the new OVERNIGHT_ONLY stops and every following stop get arrival/departure.
    try {
      await recomputeStopDates(trip.id)
    } catch (e: any) {
      console.warn('[recheckLongLegs] recomputeStopDates failed (non-fatal):', e?.message)
    }

    console.log('[recheckLongLegs] tripId=%s inserted %d transit stop(s) across %d leg(s)', trip.id, inserted, plans.length)
    return { inserted, note }
  } catch (err: any) {
    // Fail soft — a re-check failure must never block the mutation that triggered it.
    console.error('[recheckLongLegs] FAILED tripId=%s (left as-is): %s', tripId, err?.message ?? err)
    return { inserted: 0, note: null }
  }
}

export async function generateItinerary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    console.log('[generateItinerary] endpoint hit — tripId=%s userId=%s', req.params.id, req.user?.id)
    if (await enforcePerUserDailyCap(req, res)) return
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      // Party plumbed in so the day-by-day prompt reflects who's traveling —
      // accessibilityNeeds, kids, pet behavior. trip.party is the trip-scoped
      // clone (authoritative; created at createTrip with accessibilityNeeds);
      // generateTripItineraryAI falls back to user.parties[0] for legacy trips
      // created before the clone existed.
      include: { stops: true, party: { include: { people: true, pets: true } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        rigs: { where: { isDefault: true } },
        travelProfile: true,
        parties: { where: { isDefault: true }, include: { people: true, pets: true }, take: 1 },
      },
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
    if (await enforcePerUserDailyCap(req, res)) return
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
    if (await enforcePerUserDailyCap(req, res)) return
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      // Party plumbed in so the packing list reflects traveling people —
      // accessibility gear, dietary items, pet supplies. Same trip.party >
      // user.parties[0] resolution as generatePackingListAI.
      include: { stops: true, party: { include: { people: true, pets: true } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        rigs: { where: { isDefault: true } },
        travelProfile: true,
        parties: { where: { isDefault: true }, include: { people: true, pets: true }, take: 1 },
      },
    })

    const packingList = await generatePackingListAI(trip, user, { userId: req.user!.id, tripId: trip.id })

    // EMPTY-GENERATION GUARD — generatePackingListAI returns [] when the
    // model's output fails to parse (e.g. truncated JSON at the token cap).
    // Persisting that would blank a fresh trip's first list or WIPE an
    // existing one, while still 200ing. Fail loudly instead and leave the
    // stored list untouched.
    if (!Array.isArray(packingList) || packingList.length === 0) {
      throw new AppError('Packing list generation came back empty — please try again.', 502)
    }

    // Regenerate carry-over: maps over the NEW list and re-checks items whose
    // names match a previously-checked item (case-insensitive). Fresh trips
    // (nothing previously checked) get the generated list back untouched.
    // Pure logic in utils/packingMerge.ts; regression-checked by
    // server/scripts/check-packing-merge.ts.
    const merged = mergePackedState(trip.packingList, packingList as any[])

    // Snapshot what this list was generated FOR, using the SAME resolved party
    // the prompt used (trip.party ?? user-default) and the same nights source.
    // Powers the "Made for X" subtitle and the staleness banner on next load.
    const resolvedParty = trip.party ?? user?.parties?.[0] ?? null
    const packingListMeta = {
      ...resolvePackingCounts(resolvedParty, trip),
      generatedAt: new Date().toISOString(),
    }

    await prisma.trip.update({
      where: { id: trip.id },
      data: { packingList: merged, packingListMeta: packingListMeta as any },
    })

    res.json(merged)
  } catch (err) { next(err) }
}

/** Persist the user's curated packing list (checked toggles + item removals).
 *  Body validated by TripPackingListSchema — the dedicated write path that
 *  keeps packingList off the generic trip update (anti-tamper). */
export async function updatePackingList(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)
    const { packingList } = req.body
    await prisma.trip.update({ where: { id: trip.id }, data: { packingList } })
    res.json(packingList)
  } catch (err) { next(err) }
}

// ─── FR-SAVED-PACKING ────────────────────────────────────────────────────────
// Two ways to SEED a trip's packing list from existing data, both ending in the
// SAME mergePackedState + staleness-snapshot path the generate flow uses
// (generatePackingList above) — so checked-state + custom items carry over and
// the "Made for X"/staleness banner stays correct. Factored here so both share
// one persist routine.
//
//   seedPackingListFromTemplate — Pro. Seed from a saved PackingTemplate.
//   copyPackingListFromTrip     — FREE. Merge another owned trip's list in.

// Persist a seeded/merged list onto a trip with the same packingListMeta snapshot
// the generate flow writes (resolvePackingCounts(trip.party ?? user-default) +
// generatedAt). `incoming` is merged onto the trip's existing list via
// mergePackedState (trip's checked-state + custom items preserved). Returns the
// merged list to the caller.
async function persistSeededPackingList(req: AuthRequest, trip: any, incoming: any[]) {
  const merged = mergePackedState(trip.packingList, incoming)

  // Default party for the nights/people snapshot — same resolution as generate.
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: { parties: { where: { isDefault: true }, include: { people: true, pets: true }, take: 1 } },
  })
  const resolvedParty = trip.party ?? user?.parties?.[0] ?? null
  const packingListMeta = {
    ...resolvePackingCounts(resolvedParty, trip),
    generatedAt: new Date().toISOString(),
  }

  await prisma.trip.update({
    where: { id: trip.id },
    data: { packingList: merged, packingListMeta: packingListMeta as any },
  })
  return merged
}

/** POST /trips/:id/packing-list/from-template — seed from a saved template (Pro).
 *  Body { templateId }. Ownership-checks BOTH the trip and the template. */
export async function seedPackingListFromTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { templateId } = req.body as { templateId: string }
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: true, party: { include: { people: true, pets: true } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const template = await prisma.packingTemplate.findFirst({
      where: { id: templateId, userId: req.user!.id },
    })
    if (!template) throw new AppError('Template not found', 404)

    // Reset checked:false on the seeded items — a template is a starting point,
    // not a packed state (belt-and-suspenders; they're already stored unchecked).
    const seed = resetCheckedState(template.items)
    const merged = await persistSeededPackingList(req, trip, seed)
    res.json(merged)
  } catch (err) { next(err) }
}

/** POST /trips/:id/packing-list/copy-from — merge another owned trip's list (FREE).
 *  Body { sourceTripId }. MERGE (not overwrite): adds onto the target list,
 *  preserving its custom/checked items. Ownership-checks BOTH trips. */
export async function copyPackingListFromTrip(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { sourceTripId } = req.body as { sourceTripId: string }
    if (sourceTripId === req.params.id) throw new AppError('Source and target trip must be different', 400)

    const [targetTrip, sourceTrip] = await Promise.all([
      prisma.trip.findFirst({
        where: { id: req.params.id, userId: req.user!.id },
        include: { stops: true, party: { include: { people: true, pets: true } } },
      }),
      prisma.trip.findFirst({
        where: { id: sourceTripId, userId: req.user!.id },
      }),
    ])
    if (!targetTrip) throw new AppError('Trip not found', 404)
    if (!sourceTrip) throw new AppError('Source trip not found', 404)

    const sourceList = sourceTrip.packingList
    if (!Array.isArray(sourceList) || sourceList.length === 0) {
      throw new AppError('Source trip has no packing list to copy', 400)
    }

    const merged = await persistSeededPackingList(req, targetTrip, sourceList as any[])
    res.json(merged)
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

    // LS-AI-USAGE-CAP — cap AFTER the cached-return short-circuit: a cached read
    // makes no Anthropic call and must never be gated. Only an actual generate
    // (the AI call below) counts against the per-user daily cap.
    if (await enforcePerUserDailyCap(req, res)) return

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
// Open-Meteo's /v1/forecast endpoint accepts start_date / end_date inside
// roughly [today − 93, today + 15] inclusive — confirmed via direct probe:
// today+15 returns 200, today+16 returns HTTP 400 "Parameter 'end_date' is
// out of allowed range from <today-93> to <today+15>". Stops whose date
// range straddles the upper bound fall back to historical averages so the
// user sees something instead of a blank card.
const LIVE_WINDOW_END_DAYS = 15

export async function getTripWeather(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    const today      = new Date()
    // Canonical trip-anchor probe — mirrors recomputeStopDates (L97-105) and
    // shiftTripDates (L587), the convention this codebase has settled on:
    // Trip.startDate is unreliable (the promote flow doesn't write it and
    // there's no UI to set it directly), so most rows have startDate=null
    // even when their stops have real dates. The first stop with a non-null
    // arrivalDate is the canonical source of truth. Reading Trip.startDate
    // raw — as this controller did before — made every null-startDate trip
    // fall to historical regardless of how near-term its first stop was.
    const firstDatedStop = trip.stops.find(s => s.arrivalDate != null)
    // parseTripDate anchors each stored Date to local NOON on its UTC
    // calendar day, so downstream `.getDate()` / `isoDate(...)` calls read
    // the day the user actually picked instead of the previous local day
    // (which is what raw `new Date(stop.arrivalDate)` would surface in
    // negative-offset deploy zones). Same pattern the client uses for
    // every date display. See server/src/utils/dates.ts for the rationale.
    const tripAnchor =
      parseTripDate(trip.startDate) ??
      parseTripDate(firstDatedStop?.arrivalDate)
    const daysUntil  = tripAnchor
      ? Math.ceil((tripAnchor.getTime() - today.getTime()) / 86_400_000)
      : null
    // Trip-wide hint, NOT the final per-stop decision. A trip with no
    // anchor at all (no startDate AND no dated stop) can't qualify for
    // live — there's nothing to project days against — so it falls to
    // historical. Trips starting more than 10 days out short-circuit
    // straight to historical even if their first stop would technically
    // fit Open-Meteo's window. Per-stop fitness inside the loop tightens
    // this further — a long trip can be useLiveHint=true with late stops
    // still falling outside the API window, in which case those stops
    // fall back to historical here.
    const useLiveHint = daysUntil !== null && daysUntil <= 10
    const liveWindowEnd = new Date(today)
    liveWindowEnd.setDate(liveWindowEnd.getDate() + LIVE_WINDOW_END_DAYS)

    const results: Record<string, any> = {}

    await Promise.all(
      (trip.stops as any[])
        .filter(s => s.latitude && s.longitude)
        .map(async (stop) => {
          // Compute base / endBase ONCE per stop so the cache mode check,
          // the live-fit test, and the eventual fetch all agree on the same
          // window. Prisma returns DateTime columns as Date instances —
          // `new Date(<Date>)` copies cleanly. .setDate(.getDate() + nights)
          // is local-time arithmetic; going through `new Date(startDateStr)`
          // would re-parse YYYY-MM-DD as UTC midnight and lose a day in
          // UTC-N zones, which used to give endDate === startDate for a
          // 1-night stop.
          // parseTripDate(stop.arrivalDate) anchors the stored Date to
          // local noon on its UTC calendar day, so endBase = base + nights
          // (via local-time .setDate) and isoDate(base/endBase) all read
          // the correct day. tripAnchor is already locally-anchored via
          // the trip-level parseTripDate above; today is `new Date()` (the
          // live present moment, no parsing needed).
          const base = parseTripDate(stop.arrivalDate) ?? tripAnchor ?? today
          const endBase = new Date(base)
          endBase.setDate(endBase.getDate() + (stop.nights || 1))

          // Per-stop live fitness: BOTH endpoints must sit inside
          // [today, today + LIVE_WINDOW_END_DAYS]. Stop arriving day 14 with
          // 3 nights ends day 17 — out of window, falls back to historical
          // even though useLiveHint is true.
          const stopFitsLive =
            useLiveHint &&
            base.getTime()    <= liveWindowEnd.getTime() &&
            endBase.getTime() <= liveWindowEnd.getTime()

          const cached    = stop.weatherForecast as any
          const cachedAt  = cached?.cachedAt ? new Date(cached.cachedAt).getTime() : 0
          const isFresh   = Date.now() - cachedAt < SIX_HOURS_MS
          // Per-stop mode match (not trip-wide). The prior trip-wide check
          // thrashed mixed-mode trips: a correctly-cached historical late-
          // stop would read as stale under trip-wide useLive=true and
          // re-fetch every 6 hours. Comparing to the per-stop stopFitsLive
          // keeps both modes cache-hittable inside one trip.
          const modeMatch = cached?.mode && (
            (stopFitsLive  && cached.mode === 'live') ||
            (!stopFitsLive && cached.mode === 'historical')
          )

          if (isFresh && modeMatch) {
            // Strip internal cachedAt before sending to client
            const { cachedAt: _c, ...clean } = cached
            results[stop.id] = clean
            return
          }

          try {
            let data: any = null

            if (stopFitsLive) {
              // Live mode: use the base / endBase computed above. The
              // earlier `(stop.arrivalDate as string).split('T')[0]` form
              // threw TypeError on a Prisma Date and silently nulled every
              // live-mode trip's weather — keep `new Date(stop.arrivalDate)`
              // (the historical branch's long-standing tolerant pattern).
              const startDate = isoDate(base)
              const endDate   = isoDate(endBase)
              data = await fetchLiveForecast(stop.latitude, stop.longitude, startDate, endDate)
            } else {
              // Historical mode: 3-year averages from Open-Meteo Archive.
              // Reuses the same `base` so a stop falling out of the live
              // window without ever changing its arrivalDate gets averages
              // for the right calendar day.
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
