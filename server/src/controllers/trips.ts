import { Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { randomBytes } from 'crypto'
import axios from 'axios'
import { Prisma } from '@prisma/client'
import { decodeFlexiblePolyline } from '../utils/flexiblePolyline'
import { sampleCorridorWaypoints, type LatLng } from '../utils/polylineSample'
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
import { parseTripDate, rollDateForwardIfPast } from '../utils/dates'
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
/**
 * Ordered route signature — the (type:locationName) of every stop in trip order.
 * This is the authoritative "did the route change" key for the RV-safety ack: it
 * changes on a genuine route mutation (add/remove/reorder/rename, destination swap,
 * one-way↔round-trip, AND an intermediate add/remove that leaves the endpoints
 * unchanged) but does NOT change on a metadata-only stop write (highwayRoute /
 * driveDuration / driveDistanceMiles / coord / geocode backfill). Captured into
 * acknowledgedRvSafety when the ack is recorded (acknowledgeRvSafety) and diffed in
 * syncTripEndpoints, so a valid ack survives the map page's route-metadata backfills
 * yet still resets the moment the route actually changes.
 */
function routeSignature(stops: Array<{ locationName: string; type: string }>): string {
  return stops.map(s => `${s.type}:${s.locationName}`).join('|')
}

async function syncTripEndpoints(tripId: string): Promise<void> {
  const stops = await prisma.stop.findMany({
    where: { tripId },
    orderBy: { order: 'asc' },
    select: { locationName: true, type: true },
  })
  if (stops.length === 0) return

  // RV-SAFETY-ACK reset — CONDITIONAL on a genuine route change. syncTripEndpoints is
  // the single choke point every stop write funnels through (create/update/delete stop,
  // makeOneWay, recheckLongLegs), but MOST of those writes are NOT route changes — the
  // map page persists per-leg highwayRoute/driveDuration/driveDistanceMiles and backfills
  // coords via updateStop on load, and an unconditional reset here wiped a just-built ack
  // within ~1s. So we only NULL the ack when the ORDERED (type:locationName) signature
  // differs from the one captured when the ack was recorded (stored inside
  // acknowledgedRvSafety). Endpoints alone are insufficient — an intermediate stop
  // add/remove changes the route without moving start/end — hence the full signature.
  // A non-null ack always carries routeSig (written by acknowledgeRvSafety); a mismatch
  // (incl. a missing routeSig from any pre-fix ack) counts as a route change → reset.
  const existing = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { acknowledgedRvSafety: true },
  })
  const ack = existing?.acknowledgedRvSafety as { acknowledgedAt?: string; routeSig?: string } | null
  const routeChanged = !!ack && ack.routeSig !== routeSignature(stops)

  await prisma.trip.update({
    where: { id: tripId },
    data: {
      // Endpoints + shape stay UNCONDITIONAL — they must track the current stops on
      // every write, route change or not.
      startLocation: stops[0].locationName,
      endLocation: stops[stops.length - 1].locationName,
      tripType: computeTripShape(stops),
      // Only touch the ack on a real route change; omit the key entirely otherwise so
      // metadata-only writes leave a valid acknowledgment in place.
      ...(routeChanged ? { acknowledgedRvSafety: null } : {}),
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
  /** HERE-only: restriction notices for this leg (e.g. a violated height/weight
   *  limit on the returned route). Absent/empty on the Google path and on a clean
   *  HERE route. Surfaced so a caller can flag a route that HERE could only
   *  satisfy by violating a restriction — never silently treated as clean. */
  violationNotes?: string[]
}

// ─── HERE truck/RV routing (FEAT-HERE-ROUTING) ───────────────────────────────
// Optional rig dimensions threaded into the drive-time measurement so the
// approved plan is built on the real RV-safe path. Off by default behind
// USE_HERE_ROUTING; when off, the Google path below runs byte-identical.

/** Rig dimensions in HERE's native units, ready to drop into vehicle[*] params.
 *  Built by rigDimsFromRig from the US-unit Rig record. Any field omitted when
 *  the rig lacks it — we never send a fabricated/zero dimension. */
export interface RigDims {
  /** vehicle[height] — centimeters */
  heightCm?: number
  /** vehicle[length] — centimeters */
  lengthCm?: number
  /** vehicle[grossWeight] — kilograms */
  grossWeightKg?: number
}

// UNIT CONVERSION (safety-critical). Rig dims are stored in US units:
//   · Rig.length / Rig.height — FEET (client constants/rigOptions.ts: LENGTHS
//     10–65 ft, HEIGHTS 8–14 ft, "Feet, 0.5-ft steps").
//   · Rig.gvwr — POUNDS (UI shows weight deltas as "lb"; bookedForRigWeight =
//     rig.gvwr in pounds).
// HERE Routing API v8 wants vehicle[height]/[length]/[width] in CENTIMETERS and
// vehicle[grossWeight] in KILOGRAMS (confirmed against HERE's v8 OpenAPI spec).
// NOTE: this deviates from the build ticket, which said "meters" — HERE actually
// uses centimeters. Sending meters would be 100× too small (an 11 ft RV → 3.35
// "cm"), so HERE would treat the rig as tiny and skip every height/weight
// restriction — the exact opposite of this feature's safety purpose. Centimeters
// is correct and is what's used here.
const FEET_TO_CM = 30.48
const POUNDS_TO_KG = 0.453592

/** Convert a Rig (US units) to HERE-native RigDims. Returns null when the rig
 *  carries no usable dimension (so callers can omit vehicle[*] entirely and let
 *  HERE route as a generic truck rather than a fabricated 0-size vehicle). */
export function rigDimsFromRig(
  rig:
    | {
        length?: number | null
        height?: number | null
        gvwr?: number | null
        isTowing?: boolean | null
        towedWeight?: number | null
      }
    | null
    | undefined,
): RigDims | null {
  if (!rig) return null
  const dims: RigDims = {}
  if (rig.height != null && rig.height > 0) dims.heightCm = rig.height * FEET_TO_CM
  if (rig.length != null && rig.length > 0) dims.lengthCm = rig.length * FEET_TO_CM

  // Gross weight HERE routes on = coach GVWR PLUS the toad's weight WHEN towing —
  // the rig + toad cross weight-limited bridges/roads as one combined mass
  // (mirrors the towing-aware MPG pattern). towedWeight is MIGRATION-GATED: the
  // Rig.towedWeight column does NOT exist yet, so until that migration runs this
  // term is always undefined and we send coach GVWR alone — byte-identical to
  // today. Once the column + form input land, combined weight activates here
  // automatically with no further change. lb→kg conversion unchanged.
  const coachLbs = rig.gvwr != null && rig.gvwr > 0 ? rig.gvwr : 0
  const towedLbs = rig.isTowing && rig.towedWeight != null && rig.towedWeight > 0 ? rig.towedWeight : 0
  const totalLbs = coachLbs + towedLbs
  if (totalLbs > 0) dims.grossWeightKg = totalLbs * POUNDS_TO_KG

  return dims.heightCm || dims.lengthCm || dims.grossWeightKg ? dims : null
}

/** True only when the HERE routing engine is explicitly enabled. Default FALSE —
 *  any value other than the literal 'true' keeps the Google path. Read at call
 *  time so a restart picks up a flipped flag without a code change. */
function useHereRouting(): boolean {
  return process.env.USE_HERE_ROUTING === 'true'
}

/** Resolve an endpoint to coordinates. HERE v8 requires lat,lng origins; plan-
 *  time stops are frequently name-only (the AI emits city names), so a missing
 *  coord is forward-geocoded via Google (geocoding stays Google by design). A
 *  miss returns null → caller falls back to the Google routing path. */
async function resolveCoords(
  p: any,
  googleKey: string,
): Promise<{ lat: number; lng: number } | null> {
  if (p?.latitude != null && p?.longitude != null) {
    return { lat: p.latitude, lng: p.longitude }
  }
  const q = `${p?.locationName ?? ''}${p?.locationState ? ', ' + p.locationState : ''}`.trim()
  if (!q) return null
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: q, key: googleKey },
      timeout: 10000,
    })
    const loc = res.data?.results?.[0]?.geometry?.location
    if (res.data?.status === 'OK' && loc) return { lat: loc.lat, lng: loc.lng }
    return null
  } catch {
    return null
  }
}

/**
 * FEAT-ORIGIN-RESOLVER — geocode-validate a FREE-FORM trip-origin answer ("I'm
 * starting at the Suncoast Casino", "Summerlin", "Denver") and return a
 * normalized "City, ST" origin string. Used by the planning controller's
 * resolveTripOrigin so ANY origin phrasing the user gives (not just the "X to Y"
 * route form) is accepted. Returns { resolved:false, origin:null } when Google
 * cannot place the text — the caller then asks ONCE more rather than storing
 * garbage. Geocoding stays Google (same endpoint resolveCoords uses).
 */
export async function geocodeOriginText(
  text: string | null | undefined,
  googleKey: string | undefined,
): Promise<{ resolved: boolean; origin: string | null }> {
  const q = (text ?? '').trim()
  if (!q || !googleKey) return { resolved: false, origin: null }
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: q, key: googleKey },
      timeout: 10000,
    })
    const result = res.data?.results?.[0]
    if (res.data?.status !== 'OK' || !result) return { resolved: false, origin: null }
    // Prefer a clean "City, ST" from the components (an origin is a planning city,
    // not a full street address); fall back to the formatted address.
    const comps: any[] = Array.isArray(result.address_components) ? result.address_components : []
    const pick = (type: string, key: 'long_name' | 'short_name') =>
      comps.find(c => Array.isArray(c.types) && c.types.includes(type))?.[key] ?? null
    const city =
      pick('locality', 'long_name') ??
      pick('postal_town', 'long_name') ??
      pick('administrative_area_level_3', 'long_name') ??
      pick('administrative_area_level_2', 'long_name')
    const state = pick('administrative_area_level_1', 'short_name')
    const origin = city
      ? (state ? `${city}, ${state}` : city)
      : (typeof result.formatted_address === 'string' ? result.formatted_address : null)
    return origin ? { resolved: true, origin } : { resolved: false, origin: null }
  } catch {
    return { resolved: false, origin: null }
  }
}

/**
 * HERE v8 sibling of fetchLegDetail — measures a leg with TRUCK routing (rig-
 * aware: height/length/weight), returning the SAME LegDetail shape so the rest
 * of the split engine is unchanged. Returns null on ANY failure (no key, coord
 * resolution miss, HTTP/timeout error, empty route) so the caller transparently
 * falls back to Google — a HERE outage never blocks planning.
 *
 * steps[] is rebuilt from the section's actions[] (each carries duration + an
 * offset into the section polyline) by decoding the flexible polyline and taking
 * the coord at each action's offset as that step's start, the next action's
 * offset as its end. That reproduces the {durationSec, startLat/Lng, endLat/Lng}
 * partition interpolateSplitPoint walks. If actions/polyline are missing, a
 * single whole-leg step is synthesized so split interpolation still has endpoints.
 */
async function fetchLegDetailHERE(
  from: any,
  to: any,
  rigDims: RigDims | null | undefined,
  googleKey: string,
): Promise<LegDetail | null> {
  const hereKey = process.env.HERE_API_KEY
  if (!hereKey) {
    console.warn('[fetchLegDetailHERE] HERE_API_KEY not set — falling back to Google')
    return null
  }

  const o = await resolveCoords(from, googleKey)
  const d = await resolveCoords(to, googleKey)
  if (!o || !d) {
    console.warn('[fetchLegDetailHERE] could not resolve coords for one endpoint — falling back to Google')
    return null
  }

  const params: Record<string, string> = {
    transportMode: 'truck',
    origin: `${o.lat},${o.lng}`,
    destination: `${d.lat},${d.lng}`,
    return: 'summary,polyline,actions',
    apiKey: hereKey,
  }
  // Only include a dimension the rig actually has — never a fabricated 0.
  if (rigDims?.heightCm) params['vehicle[height]'] = String(Math.round(rigDims.heightCm))
  if (rigDims?.lengthCm) params['vehicle[length]'] = String(Math.round(rigDims.lengthCm))
  if (rigDims?.grossWeightKg) params['vehicle[grossWeight]'] = String(Math.round(rigDims.grossWeightKg))

  let res: any
  try {
    res = await axios.get('https://router.hereapi.com/v8/routes', { params, timeout: 10000 })
  } catch (err: any) {
    console.error('[fetchLegDetailHERE] request error for %s → %s — falling back to Google: %s',
      params.origin, params.destination, err?.message)
    return null
  }

  const section = res.data?.routes?.[0]?.sections?.[0]
  if (!section?.summary) {
    console.warn('[fetchLegDetailHERE] no usable route section — falling back to Google')
    return null
  }

  const durationSec = section.summary.duration ?? 0
  const distanceMeters = section.summary.length ?? 0

  // Rebuild steps[] from actions[] + decoded polyline (see doc comment).
  const coords = section.polyline ? decodeFlexiblePolyline(section.polyline) : []
  const actions: any[] = Array.isArray(section.actions) ? section.actions : []
  const steps: LegStep[] = []
  if (coords.length >= 2 && actions.length > 0) {
    for (let i = 0; i < actions.length; i++) {
      const startIdx = Math.min(actions[i].offset ?? 0, coords.length - 1)
      const endIdx = Math.min(
        i + 1 < actions.length ? (actions[i + 1].offset ?? coords.length - 1) : coords.length - 1,
        coords.length - 1,
      )
      const s = coords[startIdx]
      const e = coords[endIdx]
      if (!s || !e) continue
      steps.push({
        durationSec: actions[i].duration ?? 0,
        startLat: s[0], startLng: s[1],
        endLat: e[0], endLng: e[1],
      })
    }
  }
  // Fallback: no per-action steps → one whole-leg step so interpolateSplitPoint
  // still has start/end coords to interpolate between.
  if (steps.length === 0 && coords.length >= 2) {
    const s = coords[0]
    const e = coords[coords.length - 1]
    steps.push({ durationSec, startLat: s[0], startLng: s[1], endLat: e[0], endLng: e[1] })
  }

  // Surface restriction notices honestly — a route HERE could only build by
  // violating a limit must NOT look clean to the caller.
  const violationNotes: string[] = []
  if (Array.isArray(section.notices)) {
    for (const n of section.notices) {
      const label = n?.title ?? n?.code ?? null
      if (label) violationNotes.push(String(label))
    }
    if (violationNotes.length) {
      console.warn('[fetchLegDetailHERE] %d restriction notice(s) on %s → %s: %s',
        violationNotes.length, params.origin, params.destination, violationNotes.join('; '))
    }
  }

  return {
    durationSec, distanceMeters, steps,
    ...(violationNotes.length ? { violationNotes } : {}),
  }
}

/**
 * FEAT-HERE-ROUTING (display) — fetch the FULL decoded HERE route geometry for a
 * leg: the complete [lat,lng] polyline (hundreds of points) AND HERE's measured
 * leg distance. The client draws the map line DIRECTLY from this polyline (no
 * Google via-reconstruction), and shows this distance so the mileage matches the
 * line. Separate from the measurement path (fetchLegDetailHERE) on purpose —
 * display-only, measurement untouched. Returns { points: [], distanceMeters: 0 }
 * on ANY failure so the caller falls back to Google-only display silently.
 */
async function fetchHereLegPolyline(
  from: any,
  to: any,
  rigDims: RigDims | null | undefined,
  googleKey: string,
): Promise<{ points: Array<[number, number]>; distanceMeters: number }> {
  const EMPTY = { points: [] as Array<[number, number]>, distanceMeters: 0 }
  const hereKey = process.env.HERE_API_KEY
  if (!hereKey) return EMPTY
  const o = await resolveCoords(from, googleKey)
  const d = await resolveCoords(to, googleKey)
  if (!o || !d) return EMPTY

  const params: Record<string, string> = {
    transportMode: 'truck',
    origin: `${o.lat},${o.lng}`,
    destination: `${d.lat},${d.lng}`,
    return: 'summary,polyline',
    apiKey: hereKey,
  }
  if (rigDims?.heightCm) params['vehicle[height]'] = String(Math.round(rigDims.heightCm))
  if (rigDims?.lengthCm) params['vehicle[length]'] = String(Math.round(rigDims.lengthCm))
  if (rigDims?.grossWeightKg) params['vehicle[grossWeight]'] = String(Math.round(rigDims.grossWeightKg))

  try {
    const res = await axios.get('https://router.hereapi.com/v8/routes', { params, timeout: 10000 })
    const section = res.data?.routes?.[0]?.sections?.[0]
    if (!section?.polyline) return EMPTY
    return {
      points: decodeFlexiblePolyline(section.polyline),
      distanceMeters: typeof section.summary?.length === 'number' ? section.summary.length : 0,
    }
  } catch (err: any) {
    console.warn('[fetchHereLegPolyline] %s → %s failed (Google-only display): %s',
      params.origin, params.destination, err?.message)
    return EMPTY
  }
}

/**
 * FEAT-HERE-ROUTING (display) — snap the sampled HERE corridor waypoints to the
 * road centerline via Google Roads API (snapToRoads). The raw HERE vertices sit a
 * few metres off Google's roads, so feeding them as via:true waypoints made Google
 * detour "to the point and back" (a visible hook + inflated mileage). Snapping puts
 * each via-point exactly on the centerline so the line stays smooth.
 *
 * Returns the same number of points in the same order. Each input is matched to
 * its snapped result BY originalIndex (snapToRoads can reorder / drop points), and
 * any input with no snapped match keeps its original (unsnapped) coordinate.
 * `interpolate=false` so snapToRoads returns only the snapped inputs (no extra
 * interpolated points to filter out).
 *
 * FAIL-SOFT: any failure — no key, network error, non-200 / 403 block, empty or
 * malformed response, timeout — returns the ORIGINAL unsnapped points so the map
 * line never breaks. `snapped` tells the caller which path was used (for logging).
 * A 200 with a `warningMessage` (e.g. "Input path is too sparse") still carries
 * valid snappedPoints and is treated as success, NOT a failure.
 */
async function snapWaypointsToRoads(
  points: LatLng[],
  apiKey: string,
): Promise<{ waypoints: LatLng[]; snapped: boolean }> {
  if (!apiKey || points.length === 0) return { waypoints: points, snapped: false }
  const path = points.map(p => `${p.lat},${p.lng}`).join('|')
  try {
    const res = await axios.get('https://roads.googleapis.com/v1/snapToRoads', {
      params: { path, interpolate: false, key: apiKey },
      timeout: 10000,
    })
    const snappedPoints: any[] = Array.isArray(res.data?.snappedPoints) ? res.data.snappedPoints : []
    if (snappedPoints.length === 0) return { waypoints: points, snapped: false }

    // Match each snapped result to its INPUT by originalIndex (not array position).
    const byIndex = new Map<number, LatLng>()
    for (const sp of snappedPoints) {
      const idx = sp?.originalIndex
      const loc = sp?.location
      if (typeof idx === 'number' && loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
        if (!byIndex.has(idx)) byIndex.set(idx, { lat: loc.latitude, lng: loc.longitude })
      }
    }
    if (byIndex.size === 0) return { waypoints: points, snapped: false }
    // Snapped where matched, original coordinate where a given index wasn't returned.
    const waypoints = points.map((p, i) => byIndex.get(i) ?? p)
    return { waypoints, snapped: true }
  } catch (err: any) {
    console.warn('[snapWaypointsToRoads] failed (using unsnapped waypoints): %s', err?.message)
    return { waypoints: points, snapped: false }
  }
}

async function fetchLegDetail(
  from: any,
  to: any,
  apiKey: string,
  rigDims?: RigDims | null,
): Promise<LegDetail | null> {
  // FEAT-HERE-ROUTING — single measurement branch point. When the flag is on,
  // measure with HERE truck/RV routing (rig-aware). A null result (HERE down,
  // coord miss, etc.) falls THROUGH to the Google path below — fail-soft, so a
  // HERE outage never blocks planning. When the flag is off this whole block is
  // skipped and the Google path runs byte-identical to before.
  if (useHereRouting()) {
    const here = await fetchLegDetailHERE(from, to, rigDims, apiKey)
    if (here) return here
    console.warn('[fetchLegDetail] HERE returned no route — using Google for this leg')
  }

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
  /** HERE restriction notices observed while measuring this leg (e.g. "Route
   *  goes through a seasonal closure"). Distinct notices kept; identical ones
   *  collapsed to one entry. Empty on the Google path / a clean HERE route. */
  violationNotes: string[]
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
  rigDims?: RigDims | null,
): Promise<LegPlan> {
  const plan: LegPlan = { towns: [], subLegs: [], warnings: [], violationNotes: [] }
  let frontier = from
  let iterations = 0

  // Collect a measured leg's HERE restriction notices, collapsing identical
  // strings (distinct ones are kept). Each iteration's `detail` covers
  // frontier→to (the whole remaining route), so accumulating across iterations
  // captures notices anywhere along the leg without double-counting duplicates.
  const collectNotices = (d: LegDetail | null) => {
    if (!d?.violationNotes) return
    for (const n of d.violationNotes) if (!plan.violationNotes.includes(n)) plan.violationNotes.push(n)
  }

  while (true) {
    if (++iterations > maxInserts + 5) {  // hard backstop against any pathological loop
      plan.warnings.push(`iteration backstop tripped on ${from.locationName}→${to.locationName}`)
      break
    }

    const detail = await fetchLegDetail(frontier, to, apiKey, rigDims)
    if (!detail) {
      plan.warnings.push(`routing failed ${frontier.locationName}→${to.locationName}; leaving leg as-is`)
      // Record nothing for this tail (unknown) — fail soft.
      break
    }
    collectNotices(detail)

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

      const sub = await fetchLegDetail(frontier, town, apiKey, rigDims)
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
/** A measured drive leg that came back from HERE with restriction notice(s).
 *  Indices are into the INPUT (pre-splice) stop array; the notice is attached
 *  to the destination stop (`toIndex`) in the spliced output for per-leg display
 *  (the drive ARRIVING at that stop is the affected leg). */
export interface LegNotice {
  afterIndex: number
  toIndex: number
  fromName: string
  toName: string
  notes: string[]
}
export interface PlanTransitResult {
  stops: PlannableStop[]
  inserts: TransitInsert[]
  /** Per-leg HERE restriction notices (empty on the Google path / clean routes).
   *  The same notes are also attached as `violationNotes` on the affected
   *  destination stop in `stops`, for the itinerary/plan view to render. */
  legNotices: LegNotice[]
}

export async function planTransitInserts(
  stops: PlannableStop[],
  capHours: number,
  apiKey: string,
  rigDims?: RigDims | null,
  ackKeys: Set<string> = new Set(),
): Promise<PlanTransitResult> {
  // No key or fewer than two stops → nothing to measure; return the input
  // unchanged (defensive copy) so callers can treat the result uniformly.
  if (!apiKey || !Array.isArray(stops) || stops.length < 2) {
    return { stops: [...(stops ?? [])], inserts: [], legNotices: [] }
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
  const legNotices: LegNotice[] = []

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

    const legPlan = await planLegSplits(fromTown, toTown, apiKey, capSec, graceSec, minUsefulSec, tolSec, maxInserts, rigDims)

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

    // Carry HERE restriction notices up for honest per-leg display. Independent
    // of whether this leg got a transit insert — an UNDER-cap leg can still
    // cross a seasonal closure and must surface it.
    if (legPlan.violationNotes.length > 0) {
      console.warn('[planTransitInserts] leg %s→%s restriction notice(s): %s',
        from.locationName, to.locationName, legPlan.violationNotes.join('; '))
      legNotices.push({
        afterIndex: a,
        toIndex: b,
        fromName: from.locationName,
        toName: to.locationName,
        notes: legPlan.violationNotes,
      })
    }

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

  // Restriction notes keyed by the affected leg's DESTINATION input index, so we
  // can attach them to that stop's spliced copy below.
  const notesByDestIndex = new Map<number, string[]>()
  for (const ln of legNotices) notesByDestIndex.set(ln.toIndex, ln.notes)

  const splicedStops: PlannableStop[] = []
  for (let i = 0; i < stops.length; i++) {
    const copy: PlannableStop = { ...stops[i] }
    // Attach this leg's HERE restriction notice(s) to its destination stop (the
    // drive arriving here is the affected leg) for the itinerary/plan advisory.
    const notes = notesByDestIndex.get(i)
    if (notes && notes.length) (copy as any).violationNotes = notes
    splicedStops.push(copy)
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

  return { stops: splicedStops, inserts, legNotices }
}

/**
 * BUG-2 — DETERMINISTIC minimal-trip night-budget check. Independent of the AI's
 * per-run elaboration (which destinations it adds, how it allocates nights — the
 * source of the inconsistent refusals). Anchors on the MINIMAL trip the request
 * implies: origin → TURNAROUND → origin (round trip) or origin → turnaround
 * (one-way). Returns { minNeeded, turnaroundName } when the minimal trip can't fit
 * requestedNights, else null.
 *   - turnaround = the destination FARTHEST from origin (Haversine when coords
 *     exist; else road drive-time via fetchLegDetail; a single destination IS the
 *     turnaround, no search).
 *   - minNeeded = 1 night at the turnaround + the mandatory transit overnights for
 *     the core route (one leg measured; ×2 for a round trip — same road reversed).
 * Same inputs (origin, turnaround, cap, requestedNights) → same result. Fail-soft:
 * any measurement failure returns null (no refusal — the trip builds).
 */
export async function minimalTripBudget(
  stops: PlannableStop[],
  capHours: number,
  requestedNights: number,
  apiKey: string,
  rigDims?: RigDims | null,
): Promise<{ minNeeded: number; turnaroundName: string } | null> {
  try {
    if (!apiKey || !Array.isArray(stops) || stops.length < 2) return null
    const norm = (v?: string | null) => (v ?? '').toLowerCase().trim()
    const origin = stops[0] as any
    const homeName = norm(origin?.locationName)
    const realDests = (stops as any[]).filter((s, i) =>
      s.type === 'DESTINATION' &&
      !(i === stops.length - 1 && (s.nights ?? 0) === 0 && norm(s.locationName) === homeName),
    )
    if (!realDests.length) return null

    // Turnaround = farthest destination from origin.
    let turnaround = realDests[0]
    if (realDests.length > 1) {
      const haveCoords =
        origin?.latitude != null && origin?.longitude != null &&
        realDests.every(d => d.latitude != null && d.longitude != null)
      if (haveCoords) {
        turnaround = realDests.reduce((far, d) =>
          haversineMiles(origin.latitude, origin.longitude, d.latitude, d.longitude) >
          haversineMiles(origin.latitude, origin.longitude, far.latitude, far.longitude) ? d : far)
      } else {
        let maxSec = -1
        for (const d of realDests) {
          const detail = await fetchLegDetail(origin, d, apiKey, rigDims)
          if (detail && detail.durationSec > maxSec) { maxSec = detail.durationSec; turnaround = d }
        }
      }
    }

    // Mandatory transit for the CORE route (origin → turnaround, one leg). The return
    // leg is the same road reversed, so ×2 for a round trip.
    const { inserts } = await planTransitInserts([origin, turnaround], capHours, apiKey, rigDims)
    const oneWayTransit = inserts.reduce((n, ins) => n + ins.towns.length, 0)
    const roundTrip = computeTripShape(stops as any[]) === 'ROUND_TRIP'
    const coreTransit = oneWayTransit * (roundTrip ? 2 : 1)
    const minNeeded = 1 + coreTransit

    if (minNeeded > requestedNights) {
      return { minNeeded, turnaroundName: turnaround.locationName }
    }
    return null
  } catch (e: any) {
    console.warn('[minimalTripBudget] failed (no refusal): %s', e?.message ?? e)
    return null
  }
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

/**
 * RV-SAFETY-ACK — persist the build-time RV-safety acknowledgment on a trip.
 *
 * Called by the client AFTER the build's stop-creation loop completes (see
 * SessionPage.buildItinerary), never during it. That ordering is load-bearing:
 * every createStop in the build loop runs syncTripEndpoints, which NULLs this
 * field — so writing the ack here, once the loop is done, is the last write and
 * survives. Stored as { acknowledgedAt: <ISO> }; presence = acknowledged,
 * null/absent = not (the modal re-prompts on the next build). Owner-gated like
 * the other trip endpoints. The reset on later route changes is handled in
 * syncTripEndpoints, not here.
 */
export async function acknowledgeRvSafety(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!trip) throw new AppError('Trip not found', 404)
    // Capture the route signature the user is acknowledging, so syncTripEndpoints can
    // later distinguish a genuine route change (reset the ack) from a metadata-only stop
    // write (preserve it). Same ordered (type:locationName) key syncTripEndpoints diffs.
    const stops = await prisma.stop.findMany({
      where: { tripId: req.params.id },
      orderBy: { order: 'asc' },
      select: { locationName: true, type: true },
    })
    const acknowledgedRvSafety = { acknowledgedAt: new Date().toISOString(), routeSig: routeSignature(stops) }
    await prisma.trip.update({ where: { id: req.params.id }, data: { acknowledgedRvSafety } })
    res.json({ acknowledgedRvSafety })
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

    let { newStartDate }: TripShiftDatesInput = req.body
    const { modifyActionId }: TripShiftDatesInput = req.body

    // PAST-TRAVEL-DATE BACKSTOP (modify path) — if the AI mis-resolved a yearless
    // shift target to a past year, roll it forward to the next future occurrence.
    // GATED to a trip whose CURRENT anchor is itself today-or-future: shifting a
    // future/planning trip into the past is the mis-resolution bug, but a trip
    // already in the past is a COMPLETED trip whose deliberate backdating
    // (trips.ts edge-cases note) must stay possible — so we never touch that case.
    const anchorIsFuture = rollDateForwardIfPast(anchorStop.arrivalDate!).getTime() === anchorStop.arrivalDate!.getTime()
    if (anchorIsFuture) {
      const corrected = rollDateForwardIfPast(newStartDate)
      if (corrected.getTime() !== newStartDate.getTime()) {
        console.info('[shiftTripDates] rolled past newStartDate %s → %s',
          newStartDate.toISOString().slice(0, 10), corrected.toISOString().slice(0, 10))
        newStartDate = corrected
      }
    }

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

    // Guard 3: protect ONLY the DEPARTURE — the first stop by order (the origin),
    // regardless of type. A TRAILING return-home stop (the round-trip closer, which
    // may itself be type HOME) is legitimately removable — e.g. converting a round
    // trip to one-way. Blocking every HOME-typed stop used to make that impossible
    // (BUG-1). Only the first stop is structurally protected.
    const firstStop = await prisma.stop.findFirst({
      where: { tripId: req.params.id },
      orderBy: { order: 'asc' },
      select: { id: true },
    })
    if (firstStop && stop.id === firstStop.id) {
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

    // "Remove it anyway" (over-cap delete) — the user confirmed deleting this stop
    // (overnight OR destination) and keeping the resulting merged leg as one drive.
    // Capture the merged-leg endpoints BEFORE the delete so we can mark the leg
    // acknowledged afterward; the recheck below (and every future one) then skips it
    // instead of inserting an overnight. Applies to ANY stop type now.
    let ackLegKey: string | null = null
    if (req.query.acknowledgeLongLeg === 'true') {
      const ordered = await prisma.stop.findMany({ where: { tripId: req.params.id }, orderBy: { order: 'asc' } })
      const ep = mergedLegEndpoints(ordered as any[], stop.id)
      // Only ack the real→real pair when it will actually be EMPTY after the delete
      // (no surviving overnight between them) — that's the only case recheck would
      // re-insert on. If an overnight remains in the span (e.g. deleting a
      // destination that sat between two transit overnights), recheck skips it
      // anyway, so acking would be a wrong, unrelated leg (the latent over-ack bug).
      if (ep && !ep.otherOvernightBetween) ackLegKey = `${ep.a.id}|${ep.b.id}`
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
 * Long-leg delete PREVIEW (over-cap delete warning). Before the client finalizes
 * deleting ANY stop (overnight OR destination), it asks whether removing it would
 * create a too-long merged drive day, and returns the REAL measured drive time of
 * the merged leg so the confirm modal can show it. Read-only — no mutation. Mirrors
 * planLegSplits' split trigger (legHours > cap + grace), so the modal only appears
 * when the resulting drive would actually exceed the user's daily limit.
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
    if (!target) return res.json({ exceeds: false })

    // The drive day that RESULTS from deleting this stop is between its IMMEDIATE
    // neighbors — the stop directly before and directly after it — regardless of
    // their type. Both overnight and destination stops are sleep points, so a
    // destination sandwiched between two transit overnights (Chambers → Moab →
    // Coalville) merges into the Chambers → Coalville drive when Moab is removed.
    // BUG (fixed): the prior code used the nearest REAL stops (skipping overnights),
    // which measured the wrong far-apart leg (Mesa → Bozeman) and then suppressed
    // the warning via otherOvernightBetween. Immediate neighbors are the truth.
    const idx = stops.findIndex(s => s.id === target.id)
    const prev = idx > 0 ? stops[idx - 1] : null
    const next = idx < stops.length - 1 ? stops[idx + 1] : null
    // First or last stop → nothing merges; no resulting long drive to warn about.
    if (!prev || !next) return res.json({ exceeds: false })

    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) return res.json({ exceeds: false })
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { travelProfile: true, rigs: { where: { isDefault: true } } },
    })
    const cap = deriveCapHours(user?.travelProfile)
    // FEAT-HERE-ROUTING — default-rig dims for the truck-routing measurement;
    // ignored on the Google path (flag off).
    const rigDims = rigDimsFromRig(user?.rigs?.[0])
    const detail = await fetchLegDetail(prev, next, apiKey, rigDims)
    if (!detail) return res.json({ exceeds: false })
    const legHours = detail.durationSec / 3600
    const exceeds = legHours > cap + LEG_GRACE_HOURS
    // Diagnostic: shows exactly what the preview computes for a delete (kept — same
    // observability posture as [recheckLongLegs]/[planTransitInserts]; low-noise,
    // one line per delete-preview).
    console.log(
      '[longLegPreview] tripId=%s deleting "%s" → merged %s → %s = %sh (cap=%sh +%sh grace) exceeds=%s',
      req.params.id, target.locationName, prev.locationName, next.locationName,
      legHours.toFixed(1), cap, LEG_GRACE_HOURS, exceeds,
    )
    res.json({
      exceeds,
      legHours: Math.round(legHours * 10) / 10,
      cap,
      fromName: prev.locationName,
      toName: next.locationName,
    })
  } catch (err) { next(err) }
}

/**
 * BUG-1 — atomic round-trip → one-way conversion. Truncates everything AFTER the
 * turnaround (the farthest stop from the origin): removes the return-leg transit
 * overnights AND the trailing return-home closer in ONE transaction, so it can't
 * half-apply or trip the departure-home guard. No-op when the trip is already
 * one-way. The departure (first stop) is never touched.
 */
export async function makeOneWay(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)
    const stops = trip.stops as any[]
    const stampIfAsked = async () => {
      if (typeof req.query.modifyActionId === 'string') {
        await stampModifyActionApplied(req.params.id, req.query.modifyActionId)
      }
    }

    if (computeTripShape(stops) !== 'ROUND_TRIP') {
      await stampIfAsked()
      return res.json({ removed: 0, alreadyOneWay: true })
    }

    const origin = stops[0]
    const norm = (v?: string | null) => (v ?? '').toLowerCase().trim()
    const homeName = norm(origin?.locationName)

    // Turnaround = farthest stop from the origin. The return-home closer sits at the
    // origin city (~0 mi), so it is never the max. Prefer real Haversine when coords
    // exist; fall back to the last DESTINATION not at the home city.
    let turnaroundIdx = -1
    if (origin?.latitude != null && origin?.longitude != null) {
      let maxD = -1
      for (let i = 1; i < stops.length; i++) {
        const s = stops[i]
        if (s.latitude == null || s.longitude == null) continue
        const d = haversineMiles(origin.latitude, origin.longitude, s.latitude, s.longitude)
        if (d > maxD) { maxD = d; turnaroundIdx = i }
      }
    }
    if (turnaroundIdx < 0) {
      for (let i = stops.length - 1; i >= 1; i--) {
        if (stops[i].type === 'DESTINATION' && norm(stops[i].locationName) !== homeName) { turnaroundIdx = i; break }
      }
    }
    if (turnaroundIdx < 0 || turnaroundIdx >= stops.length - 1) {
      // No turnaround found, or nothing after it — leave as-is.
      await stampIfAsked()
      return res.json({ removed: 0 })
    }

    const turnaround = stops[turnaroundIdx]
    const toRemove = stops.slice(turnaroundIdx + 1)
    await prisma.stop.deleteMany({ where: { tripId: trip.id, id: { in: toRemove.map(s => s.id) } } })
    await resequenceStops(trip.id)
    try { await syncTripEndpoints(trip.id) } catch (e: any) { console.warn('[makeOneWay] syncTripEndpoints failed: %s', e?.message) }
    try { await recomputeStopDates(trip.id) } catch (e: any) { console.warn('[makeOneWay] recomputeStopDates failed: %s', e?.message) }
    await stampIfAsked()
    console.log('[makeOneWay] tripId=%s removed %d stop(s) after turnaround "%s"', trip.id, toRemove.length, turnaround.locationName)
    res.json({ removed: toRemove.length, endpoint: turnaround.locationName })
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
 * Honest, non-alarmist prose advisory for HERE restriction notices, surfaced in
 * the reply ALONGSIDE the drive-time note (same plumbing). Uses HERE's actual
 * notice text — never invents a severity HERE didn't report — and always frames
 * it as "verify yourself," consistent with the ToS / MESA honesty principle.
 * Returns null when there are no notices. One line per affected leg; distinct
 * notices on a leg are joined, identical ones were already collapsed upstream.
 */
export function buildViolationAdvisory(legNotices: LegNotice[]): string | null {
  if (!legNotices.length) return null
  return legNotices
    .map(ln => `Heads up: the ${ln.fromName} → ${ln.toName} drive may cross a routing restriction (${ln.notes.join('; ')}) — verify the road is open for your dates and rig before driving.`)
    .join(' ')
}

// ─── FEAT-HAZARD-WARN — RV hazard detection (DB-driven, NO route geometry) ─────
// Warning-only. A planned leg is tested against known hazards (the Hazard table)
// by a COARSE corridor test (hazard point within a buffer of the straight line
// between the two GEOCODED endpoints) PLUS a stop-name match, then gated by the
// user's rig dimensions. A firing hazard's text is attached to the ARRIVING
// stop's violationNotes — the SAME channel HERE detection used → RouteAdvisory
// banner. Independent of USE_HERE_ROUTING: this uses only the DB + Google
// geocoding (resolveCoords), so it works with the abandoned HERE display off.

/** Corridor half-width (miles) around the straight line between leg endpoints. A
 *  hazard whose point falls within this buffer counts as "on/near the leg".
 *  Generous on purpose — real roads wind far from the straight line, especially
 *  in the mountains where length/grade hazards cluster, so we favor recall and
 *  frame the warning as "verify". Named constant for easy tuning. */
const HAZARD_CORRIDOR_BUFFER_MI = 25

/** Minimal rig shape the gating reads. Works for a real Rig OR an ad-hoc
 *  { length } object (no vehicleType → treated as an RV, per Phase-2 decision). */
interface HazardRig {
  vehicleType?: string | null
  length?: number | null
  height?: number | null
  gvwr?: number | null
  isTowing?: boolean | null
  towedLength?: number | null
  towedHeight?: number | null
}

/** Subset of the Hazard row the matcher needs. */
interface HazardRow {
  name: string
  state: string
  lat: number
  lng: number
  hazardType: string
  maxLengthFt: number | null
  maxHeightFt: number | null
  maxWidthFt: number | null
  maxWeightLbs: number | null
  gradePct: number | null
  propaneBanned: boolean
  roadDesignation: string | null
}

/** Great-circle distance (miles) from point P to the SEGMENT A→B (closest point
 *  on the segment, via a local equirectangular projection — adequate at leg
 *  scale). Reuses haversineMiles for the final point-to-point distance. */
function pointToSegmentMiles(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const latRef = toRad((aLat + bLat) / 2)
  // Local planar coords (x east, y north), A at origin.
  const bx = toRad(bLng - aLng) * Math.cos(latRef), by = toRad(bLat - aLat)
  const px = toRad(pLng - aLng) * Math.cos(latRef), py = toRad(pLat - aLat)
  const segLen2 = bx * bx + by * by
  let t = segLen2 > 0 ? (px * bx + py * by) / segLen2 : 0
  t = Math.max(0, Math.min(1, t)) // clamp to the segment
  const cx = t * bx, cy = t * by
  const cLng = aLng + (cx / Math.cos(latRef)) * (180 / Math.PI)
  const cLat = aLat + cy * (180 / Math.PI)
  return haversineMiles(pLat, pLng, cLat, cLng)
}

/** Combined driving length (rig + towed when towing) — what parkway/pass length
 *  bans actually limit. */
function rigEffectiveLengthFt(rig: HazardRig): number {
  return (rig.length ?? 0) + (rig.isTowing && rig.towedLength ? rig.towedLength : 0)
}
/** Taller of the rig and any towed unit. */
function rigEffectiveHeightFt(rig: HazardRig): number {
  return Math.max(rig.height ?? 0, rig.towedHeight ?? 0)
}
/** Counts as an RV (has propane / subject to blanket RV bans). No rig propane
 *  flag exists yet (P3 follow-on) → assume YES for anything that isn't a tent/
 *  car-camping setup; an ad-hoc rig (no vehicleType) is treated as an RV. */
function rigIsRv(rig: HazardRig): boolean {
  return rig.vehicleType !== 'CAR_CAMPING'
}

/** Rig-gating: does this hazard actually affect THIS rig? Fires ONLY when the
 *  rig's real dimension trips the stored numeric limit — never a generic "big
 *  rig" note. WIDTH_BAN / VEHICLE_BAN / PROPANE_TUNNEL have no measurable rig
 *  field, so they fire for any non-CAR_CAMPING rig (Phase-2 decisions 1/2/3). */
function hazardFiresForRig(h: HazardRow, rig: HazardRig): boolean {
  const rv = rigIsRv(rig)
  switch (h.hazardType) {
    case 'LENGTH_BAN':    return h.maxLengthFt != null && rigEffectiveLengthFt(rig) > h.maxLengthFt
    case 'HEIGHT_BAN':    return h.maxHeightFt != null && rigEffectiveHeightFt(rig) > h.maxHeightFt
    case 'WEIGHT_BAN':    return h.maxWeightLbs != null && (rig.gvwr ?? 0) > h.maxWeightLbs
    case 'WIDTH_BAN':     return rv  // no rig width field — fire for any RV
    case 'VEHICLE_BAN':   return rv  // RVs + trailers
    case 'PROPANE_TUNNEL': return rv && h.propaneBanned // assume propane aboard any RV
    case 'GRADE':
      // Steep passes have no universal legal limit. Fire for a large/heavy RV.
      // If the row carries an exact dimensional limit (some passes post one), use
      // it; otherwise the generic "big rig" threshold (≥30 ft combined OR ≥26k lb).
      if (!rv) return false
      if (h.maxLengthFt != null) return rigEffectiveLengthFt(rig) > h.maxLengthFt
      if (h.maxWeightLbs != null) return (rig.gvwr ?? 0) > h.maxWeightLbs
      return rigEffectiveLengthFt(rig) >= 30 || (rig.gvwr ?? 0) >= 26000
    default:              return false
  }
}

/** Deterministic slug for a hazard — MUST match seedHazards.ts hazardId()
 *  (`${name}-${state}` lowercased, non-alphanumerics → '-', trimmed). Used to look
 *  up a curated verbatim warning message below. */
function hazardSlug(name: string, state: string): string {
  return `${name}-${state}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// Curated VERBATIM warning text per hazard, keyed by hazardSlug. The Hazard model
// has no message column, so per-row wording (alternates, runaway ramps, exact
// phrasing) lives here in code and is preferred by composeHazardNote over the
// generated fallback. Keys MUST match the seed rows' name+state exactly. Currently
// the 11 GRADE rows (GH-W); the legal RESTRICTIONS still use the generated text.
// (Future: a Hazard.message column would move these to the DB — see P3 note.)
const HAZARD_MESSAGES: Record<string, string> = {
  'sonora-pass-ca': "DANGER: Sonora Pass (CA-108) reaches ~26% grade with tight switchbacks. NOT recommended for vehicles over 25 ft. Your rig should avoid this pass — seek an alternate route.",
  'ebbetts-pass-ca': "DANGER: Ebbetts Pass (CA-4) hits ~23-25% grade, is under 2 lanes wide in spots with hairpins. Signs advise vehicles over 28 ft find an alternate route. Avoid in a large rig.",
  'million-dollar-highway-red-mountain-pass-co': "CAUTION: US-550 (Million Dollar Highway / Red Mountain Pass) runs ~8-9% with sheer drop-offs and NO guardrails. Narrow and notoriously dangerous. Drive northbound to stay off the cliff edge; use engine braking.",
  'slumgullion-pass-co': "CAUTION: Slumgullion Pass (CO-149) is ~9.5% — Colorado's steepest paved road. Sustained grade; use low gear and watch brake heat.",
  'us-14-bighorn-granite-pass-wy': "DANGER: US-14 over the Bighorns averages ~10% and peaks near 13.5% — semis avoid it entirely. Severe for a large RV. Strongly consider an alternate route.",
  'teton-pass-wy': "DANGER: Teton Pass (WY-22) is a sustained 10% grade on BOTH sides (eases to 6-7% lower down), peaks 8,429 ft, with a posted 60,000 lb weight limit and runaway ramps that require crossing oncoming traffic. Trailers banned in winter. Demanding/dangerous for a heavy coach — the Hwy 26/89 via Alpine is the safer alternate.",
  'i-84-cabbage-hill-emigrant-hill-or': "CAUTION: I-84 Cabbage Hill gains 2,000 ft in 6 miles at 6%. Manage engine/transmission heat carefully both directions.",
  'ut-143-ut': "DANGER: UT-143 reaches over 13% climbing toward the ski resort; trucks avoid it to keep brakes from catching fire. Not advised for a large motorhome.",
  'moki-dugway-ut': "DANGER: Moki Dugway (UT-261) is a series of steep UNPAVED switchbacks carved into a cliff. Large RVs and trailers should not attempt it — use the paved alternate.",
  'apache-trail-az': "DANGER: AZ-88 (Apache Trail) between Tortilla Flat and Roosevelt Lake is winding gravel/dirt, sometimes a single lane. Do NOT attempt in a big rig.",
  'cajon-pass-ca': "CAUTION: Cajon Pass (I-15 south of Victorville) descends ~6% with a 12-mile downgrade, 45 mph truck limit, and a runaway ramp. Heavy truck traffic. Low gear and engine braking — watch brake temps the whole way down.",
}

/** Compose the user-facing warning from the hazard row + the rig that tripped it.
 *  Prefers a curated VERBATIM message (HAZARD_MESSAGES) when one exists for this
 *  hazard; otherwise generates honest, specific "verify yourself" text. */
function composeHazardNote(h: HazardRow, rig: HazardRig): string {
  const verbatim = HAZARD_MESSAGES[hazardSlug(h.name, h.state)]
  if (verbatim) return verbatim
  const where = h.roadDesignation ? `${h.name} (${h.roadDesignation})` : h.name
  switch (h.hazardType) {
    case 'GRADE':
      return `${where} is a steep${h.gradePct != null ? ` ~${h.gradePct}%` : ''} grade — not recommended for large or heavy rigs. Verify before driving or plan an alternate.`
    case 'LENGTH_BAN':
      return `${where} has a ${h.maxLengthFt}-ft vehicle-length limit and your rig (about ${Math.round(rigEffectiveLengthFt(rig))} ft${rig.isTowing ? ' combined' : ''}) exceeds it — verify before driving or plan an alternate.`
    case 'HEIGHT_BAN':
      return `${where} has a ${h.maxHeightFt}-ft height limit and your rig (about ${rigEffectiveHeightFt(rig)} ft) exceeds it — verify clearance before driving.`
    case 'WIDTH_BAN':
      return `${where} has a ${h.maxWidthFt ?? '8'}-ft width limit that RVs typically exceed — verify before driving or plan an alternate.`
    case 'WEIGHT_BAN':
      return `${where} has a ${h.maxWeightLbs}-lb weight limit your rig exceeds — verify before driving.`
    case 'VEHICLE_BAN':
      return `${where} prohibits RVs/trailers — verify before driving and plan an alternate route.`
    case 'PROPANE_TUNNEL':
      return `${where} restricts vehicles carrying propane/LP, which RVs typically do — verify the crossing's rules or plan an alternate.`
    default:
      return `${where} has a posted restriction for your rig — verify before driving.`
  }
}

/** Normalize for the stop-name match. */
function normHazardStr(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}
/** Stop-name (landmark) match: the user routed TO/FROM the hazard by name. High
 *  precision — hazard names are specific — so a substring hit is safe. */
function stopNamesHazard(stop: any, h: HazardRow): boolean {
  const sn = normHazardStr(stop?.locationName)
  if (!sn) return false
  const hn = normHazardStr(h.name)
  return hn.length >= 4 && sn.includes(hn)
}

/**
 * Per-planning-turn hazard detection. Loads HIGH-confidence hazards once, walks
 * consecutive stop pairs, geocodes endpoints (resolveCoords), runs the corridor
 * test + stop-name match, gates by rig, and MUTATES each firing hazard's text
 * onto the ARRIVING stop's violationNotes (merging with any HERE notes already
 * there). Returns a grounded prose advisory + a hit count for the caller's
 * re-serialize gate. FAIL-SOFT: any DB/geocode error is caught and skipped so
 * itinerary emission is NEVER blocked. DB + Google geocode only — independent of
 * USE_HERE_ROUTING.
 */
export async function detectStopHazards(
  stops: any[],
  rig: HazardRig | null | undefined,
  googleKey: string | undefined,
): Promise<{ advisory: string | null; hitCount: number }> {
  try {
    if (!rig || !Array.isArray(stops) || stops.length < 2) return { advisory: null, hitCount: 0 }
    // Only HIGH-confidence hazards fire live warnings in slice 1 (MED rows are
    // seeded but dormant). Small table → one findMany per turn, not per leg.
    const hazards = (await prisma.hazard.findMany({
      where: { confidence: 'HIGH' },
      select: {
        name: true, state: true, lat: true, lng: true, hazardType: true,
        maxLengthFt: true, maxHeightFt: true, maxWidthFt: true, maxWeightLbs: true,
        gradePct: true, propaneBanned: true, roadDesignation: true,
      },
    })) as HazardRow[]
    if (!hazards.length) return { advisory: null, hitCount: 0 }

    // Geocode cache so a repeated city isn't geocoded twice in one turn.
    const coordCache = new Map<string, { lat: number; lng: number } | null>()
    const geocode = async (s: any) => {
      const key = `${s?.locationName ?? ''}|${s?.locationState ?? ''}`
      if (!coordCache.has(key)) coordCache.set(key, await resolveCoords(s, googleKey ?? ''))
      return coordCache.get(key)!
    }

    const advisories: string[] = []
    let hitCount = 0
    for (let i = 1; i < stops.length; i++) {
      const from = stops[i - 1], to = stops[i]
      // (B) stop-name landmark match — fires regardless of corridor geometry.
      const nameHits = hazards.filter(h => stopNamesHazard(to, h) || stopNamesHazard(from, h))
      // (C) corridor match — geocode both endpoints, point-to-segment distance.
      let corridorHits: HazardRow[] = []
      const a = await geocode(from), b = await geocode(to)
      if (a && b) {
        corridorHits = hazards.filter(h =>
          pointToSegmentMiles(h.lat, h.lng, a.lat, a.lng, b.lat, b.lng) <= HAZARD_CORRIDOR_BUFFER_MI)
      }
      // Dedupe (name+state) and rig-gate.
      const seen = new Set<string>()
      const firing = [...nameHits, ...corridorHits].filter(h => {
        const k = `${h.name}|${h.state}`
        if (seen.has(k)) return false
        seen.add(k)
        return hazardFiresForRig(h, rig)
      })
      if (!firing.length) continue

      const notes = firing.map(h => composeHazardNote(h, rig))
      const existing = Array.isArray((to as any).violationNotes) ? (to as any).violationNotes : []
      ;(to as any).violationNotes = [...existing, ...notes]
      advisories.push(...notes)
      hitCount += firing.length
      console.warn('[detectStopHazards] leg %s→%s: %d hazard(s) fired: %s',
        from?.locationName, to?.locationName, firing.length, firing.map(h => h.name).join('; '))
    }

    return { advisory: advisories.length ? advisories.join(' ') : null, hitCount }
  } catch (err: any) {
    console.warn('[detectStopHazards] failed (skipped, itinerary unaffected): %s', err?.message)
    return { advisory: null, hitCount: 0 }
  }
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

/** Merged-leg endpoints for deleting ANY stop: the nearest REAL (non-OVERNIGHT_ONLY)
 *  stop before and after it — the two stops that become one leg once it's removed —
 *  plus whether ANOTHER overnight survives between them (in which case the span stays
 *  "answered": no auto-overnight, nothing to confirm). Works for overnight AND
 *  destination deletes (a destination's own real neighbors are the merged leg). */
function mergedLegEndpoints(stops: any[], deletedStopId: string): { a: any; b: any; otherOvernightBetween: boolean } | null {
  const idx = stops.findIndex(s => s.id === deletedStopId)
  if (idx < 0) return null
  let a: any = null, b: any = null
  for (let i = idx - 1; i >= 0; i--) if (stops[i].type !== 'OVERNIGHT_ONLY') { a = stops[i]; break }
  for (let i = idx + 1; i < stops.length; i++) if (stops[i].type !== 'OVERNIGHT_ONLY') { b = stops[i]; break }
  if (!a || !b) return null
  const aIdx = stops.indexOf(a), bIdx = stops.indexOf(b)
  let otherOvernightBetween = false
  for (let i = aIdx + 1; i < bIdx; i++) if (stops[i].id !== deletedStopId && stops[i].type === 'OVERNIGHT_ONLY') otherOvernightBetween = true
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
      include: { travelProfile: true, rigs: { where: { isDefault: true } } },
    })
    // Shared single source of truth for the per-leg cap (see deriveCapHours).
    const maxHours = deriveCapHours(user?.travelProfile)

    // FEAT-HERE-ROUTING — rig dims for the truck-routing measurement. Prefer the
    // trip's OWN rig (what it was planned for); fall back to the user's default.
    // Only consumed when USE_HERE_ROUTING is on; ignored on the Google path.
    let rigForRouting:
      | { length?: number | null; height?: number | null; gvwr?: number | null; isTowing?: boolean | null; towedWeight?: number | null }
      | null =
      user?.rigs?.[0] ?? null
    if (trip.rigId) {
      const tripRig = await prisma.rig.findFirst({ where: { id: trip.rigId, userId } })
      if (tripRig) rigForRouting = tripRig
    }
    const rigDims = rigDimsFromRig(rigForRouting)

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
    const { inserts } = await planTransitInserts(stops, maxHours, apiKey, rigDims, effectiveAcks)
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

/** Max HERE corridor waypoints returned per leg for display (map line +
 *  directions link). Kept SMALL (3) on purpose: these are raw HERE polyline
 *  vertices, not road-snapped, so each via:true waypoint Google routes through
 *  sits slightly off the centerline and adds a detour spur ("to the point and
 *  back") plus inflated mileage. Over-sampling a near-straight corridor (8 points
 *  → 8 wobbles, 118mi→143mi on NYC→Montauk) was the jitter cause. 3 pins the
 *  corridor at its most-significant decision points (RDP keeps the biggest bends,
 *  collapses straightaways) — enough to force HERE's road choice, few enough to
 *  stay smooth. Comfortably under the 2048-char directions-URL cap too. */
const HERE_DISPLAY_MAX_WAYPOINTS = 3

export async function generateRoutes(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)
    const routes: Array<{
      segmentIdx: number
      route: string
      toStopId?: string
      hereWaypoints?: LatLng[]          // ≤3 snapped — directions-link URLs only
      herePolyline?: Array<[number, number]>  // FULL HERE geometry — the map line
      hereDistanceMeters?: number       // HERE's measured leg distance (matches the line)
    }> = await fetchAllSegmentRoutes(trip)

    // FEAT-HERE-ROUTING (display) — when the flag is on, attach HERE's RV-safe
    // corridor as ≤N sampled waypoints per leg, KEYED BY DESTINATION STOP ID so
    // the client can align them even if it filtered out coordless stops. Purely
    // additive: the existing `route` highway-name strings are untouched, and any
    // HERE failure leaves a leg with no hereWaypoints → client falls back to
    // Google-only display for that leg. Display-only; measurement is unchanged.
    if (useHereRouting()) {
      const apiKey = process.env.GOOGLE_MAPS_API_KEY
      if (apiKey) {
        const user = await prisma.user.findUnique({
          where: { id: req.user!.id },
          include: { rigs: { where: { isDefault: true } } },
        })
        let rigForRouting: { length?: number | null; height?: number | null; gvwr?: number | null; isTowing?: boolean | null; towedWeight?: number | null } | null =
          user?.rigs?.[0] ?? null
        if (trip.rigId) {
          const tripRig = await prisma.rig.findFirst({ where: { id: trip.rigId, userId: req.user!.id } })
          if (tripRig) rigForRouting = tripRig
        }
        const rigDims = rigDimsFromRig(rigForRouting)

        const ordered = [...trip.stops].sort((a: any, b: any) => a.order - b.order)
        // Segment i-1 is ordered[i-1] → ordered[i]; matches fetchAllSegmentRoutes's
        // segmentIdx so we merge by index, then add toStopId for robust client keying.
        for (let i = 1; i < ordered.length; i++) {
          const seg = routes.find(r => r.segmentIdx === i - 1)
          if (!seg) continue
          seg.toStopId = ordered[i].id
          const { points, distanceMeters } = await fetchHereLegPolyline(ordered[i - 1], ordered[i], rigDims, apiKey)
          if (points.length) {
            // The MAP LINE uses HERE's FULL polyline directly (drawn client-side,
            // no Google via-reconstruction → no hooks) + HERE's measured distance.
            seg.herePolyline = points
            if (distanceMeters > 0) seg.hereDistanceMeters = distanceMeters
            // The ≤3 sampled+snapped waypoints are now ONLY for the directions-link
            // URLs (Google Maps maps/dir needs few points for the 2048-char cap).
            const wp = sampleCorridorWaypoints(points, HERE_DISPLAY_MAX_WAYPOINTS)
            let linkNote = 'no link waypoints'
            if (wp.length) {
              const { waypoints, snapped } = await snapWaypointsToRoads(wp, apiKey)
              seg.hereWaypoints = waypoints
              linkNote = `${waypoints.length} link waypoint(s) [${snapped ? 'snapped' : 'unsnapped-fallback'}]`
            }
            console.log('[generateRoutes] leg %d (%s→%s): %d-pt HERE polyline, %dmi; %s',
              i - 1, ordered[i - 1].locationName, ordered[i].locationName,
              points.length, Math.round((distanceMeters || 0) / 1609.34), linkNote)
          }
        }
      }
    }

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

/**
 * GET /trips/:id/hazards — RV hazard warnings for the BUILT trip, RECOMPUTED on
 * demand (the warning is computed during planning and is NOT persisted on the
 * Stop row, so the map page has nothing to read otherwise). Loads the trip's
 * ordered stops + its rig (trip rig → user default, same resolution as the fuel
 * estimate), runs the shared detectStopHazards (corridor + name match, rig-gated)
 * which mutates each affected stop's violationNotes, and returns them keyed by
 * stopId. Recomputing keeps the result correct if the rig changes. Fail-soft:
 * detectStopHazards swallows its own errors and returns no hits.
 */
export async function getTripHazards(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { stops: { orderBy: { order: 'asc' } } },
    })
    if (!trip) throw new AppError('Trip not found', 404)

    // Rig resolution mirrors getTripFuelEstimate (trip-assigned → user default),
    // both scoped by userId. Full row → structurally satisfies the hazard rig shape.
    let rig = null
    if (trip.rigId) {
      rig = await prisma.rig.findFirst({ where: { id: trip.rigId, userId: req.user!.id } })
    }
    if (!rig) {
      rig = await prisma.rig.findFirst({ where: { userId: req.user!.id, isDefault: true } })
    }

    // Working copy carrying id (to key the result) + the fields detectStopHazards
    // reads (locationName/locationState for geocode + name match; lat/lng to skip
    // geocoding when coords already exist). detectStopHazards mutates violationNotes
    // onto the affected (arriving) stops, which we then read back per stop.
    const working: any[] = trip.stops.map(s => ({
      id: s.id,
      order: s.order,
      type: s.type,
      locationName: s.locationName,
      locationState: s.locationState,
      latitude: s.latitude,
      longitude: s.longitude,
    }))
    await detectStopHazards(working, rig as any, process.env.GOOGLE_MAPS_API_KEY)

    const hazards = working
      .filter(s => Array.isArray(s.violationNotes) && s.violationNotes.length > 0)
      .map(s => ({ stopId: s.id as string, violationNotes: s.violationNotes as string[] }))

    res.json({ hazards })
  } catch (err) { next(err) }
}
