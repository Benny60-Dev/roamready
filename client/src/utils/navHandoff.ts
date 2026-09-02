// FEAT-NAV-HANDOFF — one place that builds every "open this leg in a maps app"
// URL, so Google Maps and Apple Maps always receive the SAME origin,
// destination and corridor waypoints. Sits beside directions.ts (which owns the
// Google URL + waypoint trimming) and adds the Apple form, the whole-trip
// links, platform detection and the remembered app choice.
//
// Honesty rule (product): neither consumer app has an RV/truck mode, so the
// corridor waypoints are the ONLY way our measured (LVR) road choice reaches
// the phone. Anything that drops them must say so in the UI (NavigateSheet).
import { directionsUrl, destinationForStop, type DirectionsWaypoint } from './directions'

interface NavPoint {
  locationName: string
  locationState?: string | null
  latitude?: number | null
  longitude?: number | null
  bookingStatus?: string | null
  campgroundName?: string | null
}

export type NavApp = 'google' | 'apple'

/** "lat,lng" when both coords exist, else the readable "City, State". Apple's
 *  unified URLs accept either in the same parameter. */
function applePoint(p: NavPoint): string {
  if (p.latitude != null && p.longitude != null) return `${p.latitude},${p.longitude}`
  return encodeURIComponent(`${p.locationName}${p.locationState ? `, ${p.locationState}` : ''}`)
}

/** Apple Maps driving directions (iOS 18.4+ / macOS 15.4+ unified URL; older
 *  devices still open the destination). `from === null` omits `source` so Maps
 *  uses the device's current location. Waypoints repeat the `waypoint` param,
 *  in order — same ≤3 snapped corridor points the Google link uses. */
export function appleDirectionsUrl(
  from: NavPoint | null,
  to: NavPoint,
  waypoints?: DirectionsWaypoint[] | null,
): string {
  const parts = [`destination=${applePoint(destinationForStop(to))}`, 'mode=driving']
  if (from) parts.unshift(`source=${applePoint(from)}`)
  for (const w of waypoints ?? []) parts.push(`waypoint=${w.lat},${w.lng}`)
  return `https://maps.apple.com/directions?${parts.join('&')}`
}

/** Google form of the same leg — thin wrapper so callers use one vocabulary. */
export function googleDirectionsUrl(
  from: NavPoint | null,
  to: NavPoint,
  waypoints?: DirectionsWaypoint[] | null,
): string {
  return directionsUrl(from, destinationForStop(to), waypoints)
}

export function legUrl(app: NavApp, from: NavPoint | null, to: NavPoint, waypoints?: DirectionsWaypoint[] | null): string {
  return app === 'apple' ? appleDirectionsUrl(from, to, waypoints) : googleDirectionsUrl(from, to, waypoints)
}

/** Google Maps' documented ceiling for the maps/dir URL (origin + destination
 *  + this many intermediate stops). Trips with more stops open the first
 *  GOOGLE_MAX_WAYPOINTS + 2 and the sheet says so. Apple documents no cap. */
export const GOOGLE_MAX_WAYPOINTS = 9

/** Whole-trip link: every stop in order, first = origin, last = destination,
 *  the rest as waypoints (no corridor points — the apps re-route between
 *  stops, which is the honest limit of a whole-trip link). Returns the URL
 *  plus how many stops made it in, so the UI can flag truncation. */
export function wholeTripUrl(app: NavApp, stops: NavPoint[]): { url: string; included: number; total: number } | null {
  const pts = stops.filter(s => s.latitude != null && s.longitude != null)
  if (pts.length < 2) return null
  const max = app === 'google' ? GOOGLE_MAX_WAYPOINTS + 2 : pts.length
  const used = pts.slice(0, max)
  const origin = used[0]
  const dest = used[used.length - 1]
  const mids = used.slice(1, -1)
  if (app === 'apple') {
    const parts = [`source=${applePoint(origin)}`, `destination=${applePoint(dest)}`, 'mode=driving']
    for (const m of mids) parts.push(`waypoint=${applePoint(m)}`)
    return { url: `https://maps.apple.com/directions?${parts.join('&')}`, included: used.length, total: pts.length }
  }
  const wp = mids.length ? `&waypoints=${mids.map(m => `${m.latitude},${m.longitude}`).join('|')}` : ''
  return {
    url: `https://www.google.com/maps/dir/?api=1&origin=${applePoint(origin)}&destination=${applePoint(dest)}&travelmode=driving${wp}`,
    included: used.length,
    total: pts.length,
  }
}

/** True on iPhone / iPad / Mac (incl. iPadOS reporting as Mac with touch) —
 *  the only platforms where an Apple Maps link opens something. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const plat = (navigator as any).userAgentData?.platform || navigator.platform || ''
  if (/iPhone|iPad|iPod/i.test(ua) || /iPhone|iPad|iPod/i.test(plat)) return true
  if (/Mac/i.test(plat) || /Macintosh/i.test(ua)) return true
  return false
}

/** Remembered app choice — a per-device convenience, never authority. */
const LAST_APP_KEY = 'rr.nav.lastApp'
export function getLastNavApp(): NavApp | null {
  try {
    const v = localStorage.getItem(LAST_APP_KEY)
    return v === 'google' || v === 'apple' ? v : null
  } catch { return null }
}
export function setLastNavApp(app: NavApp): void {
  try { localStorage.setItem(LAST_APP_KEY, app) } catch { /* private mode etc. */ }
}

/** Great-circle miles between two points. Used to decide whether "my
 *  location" is still at the previous stop (corridor points apply) or already
 *  down the road (they'd route the driver backwards). */
export function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** "Still at the previous stop" radius for the "my location" origin. Stops
 *  are city centroids, and a metro start (home in Mesa, stop = "Phoenix")
 *  reads 20+ mi away while you're really at the start — so the radius is the
 *  larger of 25 mi and 20% of the leg. Inside it the corridor waypoints ride
 *  along; beyond it you're on the leg and the points would pull you back. */
export const NEAR_PREV_STOP_MILES = 25
export function nearPrevStopRadius(legMiles?: number | null): number {
  return Math.max(NEAR_PREV_STOP_MILES, legMiles ? legMiles * 0.2 : 0)
}
