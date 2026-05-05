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

  // 2. Live Places lookup — guarded so a missing key or transport error
  //    falls back to "not found" (caller already treats null as unverified).
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    console.warn(
      '[Places] GOOGLE_MAPS_API_KEY not set — skipping verification, returning null',
    )
    return null
  }

  let firstPlace: any = null
  try {
    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      { textQuery: `${name} ${location}` },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.rating,places.userRatingCount,places.location',
        },
        timeout: 8000,
      },
    )
    const places = response.data?.places ?? []
    firstPlace = places[0] ?? null
  } catch (err: any) {
    const status = err?.response?.status
    const data = err?.response?.data
    console.error(
      `[Places] Text search failed for "${name}" near "${location}" (HTTP ${status ?? 'unknown'}):`,
      data ?? err?.message,
    )
    return null
  }

  // Log the call regardless of result — every billable Places request counts.
  logPlacesUsage(ctx.userId)

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
