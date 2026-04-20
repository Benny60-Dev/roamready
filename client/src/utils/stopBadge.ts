import { Stop, User } from '../types'

// Multi-word state names must come before single-word to avoid partial matches
const STATE_NAMES = [
  'north carolina', 'north dakota', 'south carolina', 'south dakota',
  'west virginia', 'new hampshire', 'new jersey', 'new mexico', 'new york',
  'rhode island', 'district of columbia',
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'tennessee', 'texas',
  'utah', 'vermont', 'virginia', 'washington', 'wisconsin', 'wyoming',
]

/**
 * Strips state names, abbreviations, zip codes, and country suffixes so two
 * location strings referring to the same city compare equal regardless of
 * formatting.  Examples that all normalize to "mesa":
 *   "Mesa"  /  "Mesa, AZ"  /  "Mesa, Arizona"  /  "Mesa Arizona"  /  "MESA"
 */
function normalizeLocation(s: string): string {
  let r = s.toLowerCase().trim()
  // Zip codes
  r = r.replace(/,?\s*\d{5}(-\d{4})?$/, '').trim()
  // Country suffixes
  r = r.replace(/,?\s*(usa|united states)$/, '').trim()
  // Full state names (longest multi-word names checked first)
  for (const state of STATE_NAMES) {
    const pat = new RegExp(`,?\\s*${state.replace(/ /g, '\\s+')}$`)
    if (pat.test(r)) {
      r = r.replace(pat, '').trim()
      break
    }
  }
  // 2-letter state abbreviation as a trailing standalone token (e.g. ", AZ" or " AZ")
  r = r.replace(/,?\s+[a-z]{2}$/, '').trim()
  return r
}

/**
 * Returns the display badge value for a single stop:
 *   'S'      — first stop (departure point)
 *   'H'      — last stop whose city matches the user's homeLocation
 *   'F'      — last stop that is NOT the user's home (finish elsewhere)
 *   number   — sequential 1-based index for every middle stop
 *
 * sortedStops must already be sorted by stop.order ascending.
 * Pass the full user object so structured homeCity/homeState fields are preferred
 * over the legacy homeLocation free-text string.  Pass undefined (public/shared
 * views) and the last stop defaults to 'F'.
 */
export function getStopBadge(
  stop: Stop,
  sortedStops: Stop[],
  user?: Pick<User, 'homeCity' | 'homeState' | 'homeLocation'>,
): 'S' | 'H' | 'F' | number {
  if (sortedStops.length === 0) return 1
  const firstId = sortedStops[0].id
  const lastId  = sortedStops[sortedStops.length - 1].id

  if (stop.id === firstId) return 'S'

  if (stop.id === lastId) {
    if (!user) return 'F'

    // Prefer structured homeCity when available — direct city (+ optional state) comparison
    if (user.homeCity) {
      const homeCity  = user.homeCity.toLowerCase().trim()
      const homeState = user.homeState?.toLowerCase().trim()
      const stopCity  = normalizeLocation(stop.locationName)
      const stopState = stop.locationState ? normalizeLocation(stop.locationState) : undefined
      // City must match; state is a secondary guard only when both sides supply it
      const cityMatch  = stopCity === homeCity
      const stateMatch = !homeState || !stopState || stopState === homeState
      return cityMatch && stateMatch ? 'H' : 'F'
    }

    // Fall back to legacy free-text comparison for users who haven't re-entered their address
    if (!user.homeLocation) return 'F'
    const stopStr = stop.locationName + (stop.locationState ? `, ${stop.locationState}` : '')
    return normalizeLocation(stopStr) === normalizeLocation(user.homeLocation) ? 'H' : 'F'
  }

  // Middle stop: count position among non-endpoint stops (1-indexed)
  let n = 1
  for (const s of sortedStops) {
    if (s.id === firstId || s.id === lastId) continue
    if (s.id === stop.id) return n
    n++
  }
  return n
}

/**
 * Builds a badge map for every stop in one pass — avoids repeated iteration
 * when rendering a list of stops.
 */
export function buildStopBadges(
  sortedStops: Stop[],
  user?: Pick<User, 'homeCity' | 'homeState' | 'homeLocation'>,
): Record<string, 'S' | 'H' | 'F' | number> {
  const result: Record<string, 'S' | 'H' | 'F' | number> = {}
  sortedStops.forEach(s => { result[s.id] = getStopBadge(s, sortedStops, user) })
  return result
}
