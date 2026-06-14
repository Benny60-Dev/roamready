import axios from 'axios'
import { prisma } from '../utils/prisma'

// Google Places (New) Text Search — flat-cost lookup for verifying AI-suggested
// campground names against Google's POI database. Results are cached in
// CampgroundCache for 30 days (positive AND negative caches) so the same name
// near the same stop never costs twice within that window.

export interface VerifiedCampground {
  placeId: string
  name: string
  address: string | null
  phone: string | null
  website: string | null
  googleMapsUrl: string | null
  rating: number | null
  userRatingCount: number | null
  latitude: number | null
  longitude: number | null
  source: 'google_places'
}

// Flat per-call cost in USD. Source: Google Places API (New) Text Search SKU.
// Update this constant if pricing changes — kept as a literal so the
// AIUsageLog cost field stays comparable to the value at write time.
const PLACES_TEXT_SEARCH_COST_USD = 0.017

const CACHE_TTL_DAYS = 30

function buildCacheKey(name: string, location: string): string {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  return `${normalize(name)}|${normalize(location)}`
}

async function logPlacesUsage(userId: string) {
  // Direct AIUsageLog write — Places is a flat-cost (non-token) call, so it
  // doesn't fit the logAIUsage helper in services/ai.ts (that one computes
  // cost from input/output tokens via the Anthropic pricing dict).
  // Fire-and-forget: never break a user's campground search because logging
  // failed.
  try {
    await prisma.aIUsageLog.create({
      data: {
        userId,
        callType: 'PLACES_LOOKUP',
        model: 'google-places-text-search',
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: PLACES_TEXT_SEARCH_COST_USD,
      },
    })
  } catch (err) {
    console.error('[Places] AIUsageLog write failed:', err)
  }
}

// Shared primitive: POST to Places `searchText`. Tri-state return so callers
// can distinguish a transport failure from a genuine empty result:
//   null  → missing API key, axios throw, timeout, non-2xx — DO NOT cache
//   []    → HTTP 2xx with zero hits — safe to negative-cache
//   [...] → HTTP 2xx with hits
// `logPlacesUsage` only fires on HTTP success (the only billable case).
async function placesTextSearch(
  textQuery: string,
  fieldMask: string,
  ctx: { userId: string },
  // Optional extra request-body fields merged into the searchText payload —
  // e.g. { locationBias: { circle: {...} }, maxResultCount: 10 } for the
  // resources-near-me finder. Defaults to {} so existing callers
  // (verifyCampground / searchCampgroundsByArea) are unaffected.
  extraBody: Record<string, any> = {},
): Promise<any[] | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    console.warn(
      '[Places] GOOGLE_MAPS_API_KEY not set — skipping text search, returning null',
    )
    return null
  }

  try {
    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      { textQuery, ...extraBody },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': fieldMask,
        },
        timeout: 8000,
      },
    )
    // Log every billable HTTP-success request, regardless of result count.
    logPlacesUsage(ctx.userId)
    return response.data?.places ?? []
  } catch (err: any) {
    const status = err?.response?.status
    const data = err?.response?.data
    console.error(
      `[Places] Text search failed for "${textQuery}" (HTTP ${status ?? 'unknown'}):`,
      data ?? err?.message,
    )
    return null
  }
}

export async function verifyCampground(
  name: string,
  location: string,
  ctx: { userId: string },
): Promise<VerifiedCampground | null> {
  const cacheKey = buildCacheKey(name, location)
  const now = new Date()

  // 1. Cache lookup — both positive (found=true) and negative (found=false)
  //    rows are honored within their TTL so we don't re-pay for known misses.
  const cached = await prisma.campgroundCache.findFirst({
    where: { cacheKey, expiresAt: { gt: now } },
  })

  if (cached) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[Places] Lookup: "${name}" near "${location}" -> ${cached.found ? 'FOUND' : 'NOT FOUND'} (cache: HIT)`,
      )
    }
    if (!cached.found) return null
    return {
      placeId: cached.placeId!,
      name: cached.name!,
      address: cached.address,
      phone: cached.phone,
      website: cached.website,
      googleMapsUrl: cached.googleMapsUrl,
      rating: cached.rating,
      userRatingCount: cached.userRatingCount,
      latitude: cached.latitude,
      longitude: cached.longitude,
      source: 'google_places',
    }
  }

  // 2. Live Places lookup via the shared text-search primitive.
  //    null = transport failure → bail without caching (don't poison the
  //    30-day negative cache for a transient error).
  //    [] = HTTP 2xx with zero hits → write negative cache below.
  const places = await placesTextSearch(
    `${name} ${location}`,
    'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.rating,places.userRatingCount,places.location',
    ctx,
  )
  if (places === null) return null
  const firstPlace: any = places[0] ?? null

  const expiresAt = new Date(now.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000)

  if (!firstPlace) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[Places] Lookup: "${name}" near "${location}" -> NOT FOUND (cache: MISS)`,
      )
    }
    // Negative cache row — prevents re-querying Google for the same miss
    // until expiresAt. Wrapped so a constraint race (rare, but possible if
    // two parallel requests both miss) doesn't surface to the caller.
    try {
      await prisma.campgroundCache.create({
        data: {
          queryName: name,
          queryLocation: location,
          cacheKey,
          found: false,
          expiresAt,
        },
      })
    } catch (err) {
      console.error('[Places] Negative cache write failed:', err)
    }
    return null
  }

  const verified: VerifiedCampground = {
    placeId: firstPlace.id,
    name: firstPlace.displayName?.text ?? name,
    address: firstPlace.formattedAddress ?? null,
    phone: firstPlace.internationalPhoneNumber ?? null,
    website: firstPlace.websiteUri ?? null,
    googleMapsUrl: firstPlace.googleMapsUri ?? null,
    rating: typeof firstPlace.rating === 'number' ? firstPlace.rating : null,
    userRatingCount:
      typeof firstPlace.userRatingCount === 'number' ? firstPlace.userRatingCount : null,
    latitude: firstPlace.location?.latitude ?? null,
    longitude: firstPlace.location?.longitude ?? null,
    source: 'google_places',
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log(
      `[Places] Lookup: "${name}" near "${location}" -> FOUND "${verified.name}" (cache: MISS)`,
    )
  }

  try {
    await prisma.campgroundCache.create({
      data: {
        queryName: name,
        queryLocation: location,
        cacheKey,
        found: true,
        placeId: verified.placeId,
        name: verified.name,
        address: verified.address,
        phone: verified.phone,
        website: verified.website,
        googleMapsUrl: verified.googleMapsUrl,
        rating: verified.rating,
        userRatingCount: verified.userRatingCount,
        latitude: verified.latitude,
        longitude: verified.longitude,
        expiresAt,
      },
    })
  } catch (err) {
    // Cache miss tolerated — we still return the live result.
    console.error('[Places] Positive cache write failed:', err)
  }

  return verified
}

export async function verifyCampgroundBatch(
  candidates: Array<{ name: string; location: string }>,
  ctx: { userId: string },
): Promise<Array<VerifiedCampground | null>> {
  // Sequential on purpose: Google's free tier rate-limits aggressively and
  // we want predictable per-call cost while we're tuning the prompt + cache
  // hit rate. Switch to a small batched parallel later if cache hit rate
  // climbs and rate limits stop being a concern.
  const results: Array<VerifiedCampground | null> = []
  for (const candidate of candidates) {
    results.push(await verifyCampground(candidate.name, candidate.location, ctx))
  }
  return results
}

// Generic Places area search — fallback for stops without AI-suggested
// candidates (modify-mode adds, manual UI inserts). Filters Google's results
// to actual RV-relevant campgrounds and rejects hotel/parking/gas hits even
// when Google over-tags a place. Capped at 5 results. Does NOT touch
// CampgroundCache (that table is keyed on name+location for candidate lookups
// — area searches are a different shape).
const KEEP_KEYWORDS = [
  'campground',
  'rv park',
  'rv resort',
  'koa',
  'campsite',
  'caravan park',
  'campgrounds',
]
// `lodging` is Google's umbrella category for any place-you-sleep-at, so it
// also covers legitimate campgrounds and RV parks — using it as a reject
// gate excluded everything. The narrower hotel siblings below catch real
// hotels-that-also-take-RVs without false-rejecting actual campgrounds.
const REJECT_TYPES = [
  'hotel',
  'motel',
  'resort_hotel',
  'bed_and_breakfast',
  'parking',
  'gas_station',
  'restaurant',
  'store',
  'supermarket',
]

export async function searchCampgroundsByArea(
  locationName: string,
  locationState: string | null,
  ctx: { userId: string },
): Promise<VerifiedCampground[]> {
  const textQuery = `campgrounds and RV parks near ${locationName}${locationState ? ', ' + locationState : ''}`
  const fieldMask =
    'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.rating,places.userRatingCount,places.location,places.types'

  const places = await placesTextSearch(textQuery, fieldMask, ctx)
  // Coalesce null (transport error) and [] (no hits) — orchestrator just
  // needs an empty array either way. The cache distinction matters in
  // verifyCampground; here we don't cache, so collapse them.
  if (places === null || places.length === 0) return []

  const filtered = places.filter((place: any) => {
    const types: string[] = Array.isArray(place.types) ? place.types.map((t: string) => t.toLowerCase()) : []
    // Reject takes precedence — a place tagged campground AND lodging is a
    // hotel-with-RV-spots; skip it rather than surface a Walmart-style hit.
    if (types.some(t => REJECT_TYPES.includes(t))) return false

    const displayName = String(place.displayName?.text ?? '').toLowerCase()
    const nameMatches = KEEP_KEYWORDS.some(kw => displayName.includes(kw))
    // Google types are snake_case (e.g. `rv_park`); compare against keywords
    // in both space and underscore forms.
    const typeMatches = KEEP_KEYWORDS.some(kw => {
      const underscore = kw.replace(/ /g, '_')
      return types.some(t => t === kw || t === underscore || t.includes(underscore))
    })
    return nameMatches || typeMatches
  })

  return filtered.slice(0, 5).map((place: any) => ({
    placeId: place.id,
    name: place.displayName?.text ?? locationName,
    address: place.formattedAddress ?? null,
    phone: place.internationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    googleMapsUrl: place.googleMapsUri ?? null,
    rating: typeof place.rating === 'number' ? place.rating : null,
    userRatingCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    latitude: place.location?.latitude ?? null,
    longitude: place.location?.longitude ?? null,
    source: 'google_places',
  }))
}

// ─── Resources "near me" finder ────────────────────────────────────────────
// Powers GET /api/v1/resources (the /resources page's RV-repair/propane/etc.
// chips). Uses the SAME Places API (New) searchText primitive as the
// campground helpers — so phone, website, and a ready-made googleMapsUri come
// back in ONE billed call (the legacy Nearby Search this replaced returned
// none of those). Location is biased to the caller's GPS point within `radius`
// miles. NOT cached here — the controller owns the Redis layer.

export interface ResourceResult {
  id: string
  name: string
  address: string | null
  latitude: number | null
  longitude: number | null
  rating: number | null
  isOpen?: boolean        // undefined when Google omits opening hours for a place
  phone: string | null
  website: string | null
  googleMapsUrl: string | null
  // Straight-line distance from the user's GPS to this resource, in miles.
  // null when the place has no coordinates. Derived from the same haversine
  // used to rank results nearest-first — see searchResourcesNearby.
  distanceMiles?: number | null
}

// Great-circle distance between two lat/lng points. Only the RELATIVE order
// matters for sorting, so the Earth-radius unit (km here) is irrelevant — we
// never surface the value. Returns Infinity for a missing coordinate so such
// results sort to the very end rather than jumping to the top.
function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number | null,
  bLng: number | null,
): number {
  if (bLat == null || bLng == null) return Infinity
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371 // km
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

const KM_TO_MILES = 0.621371

// One decimal under 10 mi ("0.4", "4.2"), whole number at/above ("12") — the
// precision a roadside user actually reads.
function roundMiles(mi: number): number {
  return mi < 10 ? Math.round(mi * 10) / 10 : Math.round(mi)
}

export async function searchResourcesNearby(
  query: string,
  lat: number,
  lng: number,
  radiusMiles: number,
  ctx: { userId: string },
): Promise<ResourceResult[]> {
  const fieldMask =
    'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.rating,places.location,places.currentOpeningHours.openNow,places.types'

  // Places API circle locationBias caps at 50,000 m; clamp so a large radius
  // param can't 400 the request. Floor at 1 mi to avoid a zero-radius circle.
  const radiusMeters = Math.min(Math.max(radiusMiles, 1) * 1609, 50000)

  // Request a wider set (20) than we return (10): searchText ranks by Google
  // relevance, so the 10 closest by real distance aren't necessarily its top
  // 10. We over-fetch, sort by distance to the user, then trim to 10.
  const places = await placesTextSearch(query, fieldMask, ctx, {
    locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters } },
    maxResultCount: 20,
  })
  // null (transport failure / missing key) and [] (no hits) both collapse to an
  // empty list — the controller decides not to cache an empty result.
  if (places === null || places.length === 0) return []

  // Compute the haversine distance ONCE per place (km), used both to surface
  // distanceMiles and to rank — no second pass in the sort comparator.
  const withDist = places.map((place: any) => {
    const latitude = place.location?.latitude ?? null
    const longitude = place.location?.longitude ?? null
    const km = haversineKm(lat, lng, latitude, longitude)
    const result: ResourceResult = {
      id: place.id,
      name: place.displayName?.text ?? '',
      address: place.formattedAddress ?? null,
      latitude,
      longitude,
      rating: typeof place.rating === 'number' ? place.rating : null,
      // currentOpeningHours is omitted by Google for places with no hours data;
      // leave isOpen undefined so the client hides the Open/Closed pill rather
      // than asserting "Closed".
      isOpen: place.currentOpeningHours?.openNow,
      phone: place.internationalPhoneNumber ?? null,
      website: place.websiteUri ?? null,
      googleMapsUrl: place.googleMapsUri ?? null,
      // Infinity (missing coords) → null so the client omits the badge.
      distanceMiles: Number.isFinite(km) ? roundMiles(km * KM_TO_MILES) : null,
    }
    return { result, km }
  })

  // Rank closest-first like Google Maps "near me". searchText returns relevance
  // order, so a 2mi result can sit below a 25mi one — sort by the raw km already
  // computed above (NOT the rounded miles, so ties keep exact order). Results
  // with no coordinate sort last (km → Infinity). Then trim to the closest 10.
  withDist.sort((a, b) => a.km - b.km)

  return withDist.slice(0, 10).map(x => x.result)
}
