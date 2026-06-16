import axios from 'axios'

/**
 * Structured home-address fields backfilled from a geocoded address string.
 * Shape matches the User home columns the app reads (homeCity / homeLat / etc.)
 * and what ProfilePage's dropdown-select path writes — so a geocoded free-typed
 * address ends up identical to a dropdown-selected one.
 */
export interface GeocodedHome {
  homeStreet: string | null
  homeCity: string | null
  homeState: string | null
  homeZip: string | null
  homeLat: number
  homeLng: number
  homeAddress: string
  homeLocation: string
}

/**
 * Forward-geocode a free-text home address into structured fields. Single source
 * of truth for the address → {city, coords, …} backfill used by BOTH
 * users.ts getMe (lazy auto-heal of already-saved text) and updateMe
 * (geocode-on-save). Previously this logic lived inline in getMe only — extracted
 * so the save path and the read path can't drift.
 *
 * Returns null (never throws) when: no API key, the geocoder errors, or no result
 * is found. Callers treat null as "leave the text as-is" — geocode failure must
 * never block a profile save (rung 2's pin-drop fallback handles failures later).
 *
 * Sets homeLocation AND homeCity from the result, which is what hasHomeOnFile
 * (services/ai.ts, reads homeCity || homeLocation) needs to stop reporting
 * "no home" for a free-typed/autofilled address.
 */
export async function geocodeHomeAddress(addressText: string): Promise<GeocodedHome | null> {
  const text = addressText?.trim()
  if (!text) return null
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) return null

  try {
    const geoRes = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: text, key: apiKey },
    })
    const result = geoRes.data?.results?.[0]
    if (!result) {
      console.warn('[geocodeHomeAddress] no result (status=%s) for "%s"', geoRes.data?.status, text)
      return null
    }

    // QUALITY GATE — reject low-confidence "guesses" so gibberish doesn't earn
    // bogus coords (which would silently suppress the rung-2 pin-drop fallback).
    // Accept only when BOTH hold:
    //   • partial_match !== true  — Google flags inexact/typo matches as partial.
    //   • the result is a real address or place, judged by its `types`: a street
    //     address (street_address / premise / subpremise) OR a real locality /
    //     postal place (locality / sublocality / postal_town / postal_code).
    // This passes a full street address ("582 Continental Dr, San Jose, CA")
    // AND a bare city ("Mesa, AZ" → types includes `locality`), but rejects
    // junk that either returns ZERO_RESULTS (already null above), comes back
    // partial_match, or resolves only to a coarse region (country /
    // administrative_area_level_1) — none of which carry an accepted type.
    const ACCEPTED_TYPES = [
      'street_address', 'premise', 'subpremise',
      'locality', 'sublocality', 'postal_town', 'postal_code',
    ]
    const resultTypes: string[] = result.types || []
    const isConfident =
      result.partial_match !== true && resultTypes.some(t => ACCEPTED_TYPES.includes(t))
    if (!isConfident) {
      console.warn(
        '[geocodeHomeAddress] low-confidence rejected for "%s" (partial_match=%s types=%j)',
        text, result.partial_match, resultTypes,
      )
      return null
    }

    const { lat, lng } = result.geometry.location
    const components: any[] = result.address_components || []
    const get = (type: string, short = false) =>
      components.find((c: any) => c.types.includes(type))?.[short ? 'short_name' : 'long_name'] ?? null
    const homeCity   = get('locality') || get('sublocality') || null
    const homeState  = get('administrative_area_level_1', true)
    const homeZip    = get('postal_code')
    const homeStreet = [get('street_number'), get('route')].filter(Boolean).join(' ') || null
    const homeAddress = result.formatted_address || text

    return {
      homeStreet,
      homeCity,
      homeState,
      homeZip,
      homeLat: lat,
      homeLng: lng,
      homeAddress,
      // Canonical formatted address — also populates homeLocation so the legacy
      // "homeCity || homeLocation" home-on-file check passes.
      homeLocation: homeAddress,
    }
  } catch (geoErr) {
    console.warn('[geocodeHomeAddress] geocode failed for "%s":', text, geoErr)
    return null
  }
}
