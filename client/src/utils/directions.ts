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

/** Google Maps driving-directions URL. `from === null` OMITS the origin param so
 *  Maps uses the device's current location; otherwise routes from that point.
 *  Open in a new tab (target="_blank" rel="noreferrer"). Coords-preferred,
 *  name-fallback, per endpoint independently. */
export function directionsUrl(from: DirectionsPoint | null, to: DirectionsPoint): string {
  const originParam = from ? `&origin=${point(from)}` : ''
  return `https://www.google.com/maps/dir/?api=1${originParam}&destination=${point(to)}&travelmode=driving`
}
