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

// One endpoint → "lat,lng" when BOTH coords are present (most precise), else the
// URL-encoded "City, State" (readable fallback for a stop without coords).
function point(p: DirectionsPoint): string {
  if (p.latitude != null && p.longitude != null) return `${p.latitude},${p.longitude}`
  return encodeURIComponent(`${p.locationName}${p.locationState ? `, ${p.locationState}` : ''}`)
}

/** Google Maps driving-directions URL from one stop to the next. Open in a new
 *  tab (target="_blank" rel="noreferrer"). Coords-preferred, name-fallback, per
 *  endpoint independently. */
export function directionsUrl(from: DirectionsPoint, to: DirectionsPoint): string {
  return `https://www.google.com/maps/dir/?api=1&origin=${point(from)}&destination=${point(to)}&travelmode=driving`
}
