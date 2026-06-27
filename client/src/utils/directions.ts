// Shared Google Maps "directions for a leg" URL builder. One source of truth for
// the FROM→TO driving link used on the trip map and itinerary pages. Mirrors the
// existing directionsUrl pattern in TripBookingPage (modern Maps URLs API,
// /maps/dir/?api=1, coords-preferred with a "City, State" name fallback) — here
// extended with an explicit origin + travelmode=driving for stop→next-stop legs.

// Only the fields we need from a Stop — keeps this util decoupled from the full type.
interface DirectionsPoint {
  locationName: string
  locationState?: string | null
  latitude?: number | null
  longitude?: number | null
}

// A stop as a directions DESTINATION also carries booking data — used to route to
// the booked campground (path A) instead of the city. Structurally satisfied by Stop.
interface DestinationStop extends DirectionsPoint {
  bookingStatus?: string | null
  campgroundName?: string | null
}

// One endpoint → "lat,lng" when BOTH coords are present (most precise), else the
// URL-encoded "City, State" (readable fallback for a stop without coords).
function point(p: DirectionsPoint): string {
  if (p.latitude != null && p.longitude != null) return `${p.latitude},${p.longitude}`
  return encodeURIComponent(`${p.locationName}${p.locationState ? `, ${p.locationState}` : ''}`)
}

/** Directions DESTINATION for a stop. When the stop is BOOKED (CONFIRMED with a
 *  campgroundName), route to the named campground ("<campground>, <city>, <state>")
 *  so Maps lands on the resort, not the city center — using on-stop data, NO fetch.
 *  Otherwise the stop's own coords/name. Nulled coords force the name path in
 *  point() so the campground name is what gets geocoded. */
export function destinationForStop(stop: DestinationStop): DirectionsPoint {
  if (stop.bookingStatus === 'CONFIRMED' && stop.campgroundName) {
    return {
      locationName: `${stop.campgroundName}, ${stop.locationName}`,
      locationState: stop.locationState,
      latitude: null,
      longitude: null,
    }
  }
  return stop
}

/** A corridor waypoint for the directions link (HERE's RV-safe path). */
export interface DirectionsWaypoint {
  lat: number
  lng: number
}

/** Hard ceiling on the full Google Maps directions URL. The maps/dir/?api=1
 *  endpoint truncates/ignores overly long URLs; 2048 is the safe cross-browser
 *  cap. We never emit a URL longer than this — waypoints are dropped until it fits. */
const MAX_DIRECTIONS_URL_LEN = 2048

/** Drop the LEAST significant waypoint (the interior one closest to collinear
 *  with its neighbours) so each removal costs the least corridor fidelity. Falls
 *  back to dropping the middle index when there are too few to rank. */
function dropOneWaypoint(wps: DirectionsWaypoint[]): DirectionsWaypoint[] {
  if (wps.length <= 2) return wps.slice(0, Math.max(0, wps.length - 1))
  let bestIdx = Math.floor(wps.length / 2)
  let minDev = Infinity
  for (let i = 1; i < wps.length - 1; i++) {
    const a = wps[i - 1], b = wps[i], c = wps[i + 1]
    // 2× triangle area = how far b sits off the a→c line; smaller = more redundant.
    const dev = Math.abs((b.lat - a.lat) * (c.lng - a.lng) - (c.lat - a.lat) * (b.lng - a.lng))
    if (dev < minDev) { minDev = dev; bestIdx = i }
  }
  return [...wps.slice(0, bestIdx), ...wps.slice(bestIdx + 1)]
}

/** Google Maps driving-directions URL. `from === null` OMITS the origin param so
 *  Maps uses the device's current location; otherwise routes from that point.
 *  Open in a new tab (target="_blank" rel="noreferrer"). Coords-preferred,
 *  name-fallback, per endpoint independently.
 *
 *  `waypoints` (optional, FEAT-HERE-ROUTING): HERE's RV-safe corridor points,
 *  pipe-separated into `&waypoints=`. Capped at 8, and any URL that would still
 *  exceed MAX_DIRECTIONS_URL_LEN drops its least-significant waypoints until it
 *  fits — so the link follows HERE's path but is never broken/too-long. Absent or
 *  empty → byte-identical to the previous Google-only URL. */
export function directionsUrl(
  from: DirectionsPoint | null,
  to: DirectionsPoint,
  waypoints?: DirectionsWaypoint[] | null,
): string {
  const originParam = from ? `&origin=${point(from)}` : ''
  const base = `https://www.google.com/maps/dir/?api=1${originParam}&destination=${point(to)}&travelmode=driving`
  if (!waypoints || waypoints.length === 0) return base

  let wps = waypoints.slice(0, 8)
  while (wps.length > 0) {
    const wpParam = `&waypoints=${wps.map(w => `${w.lat},${w.lng}`).join('|')}`
    if (base.length + wpParam.length <= MAX_DIRECTIONS_URL_LEN) return base + wpParam
    wps = dropOneWaypoint(wps)
  }
  return base
}
