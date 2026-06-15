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
