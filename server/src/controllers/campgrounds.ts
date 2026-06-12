import { Response, NextFunction } from 'express'
import axios from 'axios'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { getCache, setCache } from '../utils/redis'
import { verifyCampground, verifyCampgroundBatch, searchCampgroundsByArea } from '../services/googlePlaces'

interface CampgroundResult {
  id: string
  name: string
  latitude?: number | null
  longitude?: number | null
  description?: string
  reservationUrl?: string | null
  website?: string | null
  address?: string | null
  phone?: string | null
  attributes?: any
  maxRigLength?: number | null
  maxRigHeight?: number | null
  rvProhibited?: boolean
  isPetFriendly?: boolean
  isMilitaryOnly?: boolean
  hookupTypes?: string[]
  amenities?: string[]
  reservable?: boolean
  activities?: string[]
  // True when the facility offers overnight stays (Campground type, has
  // campsites, or lists a CAMPING activity). Drives the OHV page's
  // "Camping available" vs "Day-use" badge. Computed during mapping.
  campingAvailable?: boolean
  // Distance from the caller's GPS origin in miles — attached by getOhv after
  // the haversine pass; null when origin or facility coords are unavailable.
  distanceMiles?: number | null
  source?: string
  isCompatible?: boolean
  incompatibilityReasons?: string[]
  rating?: number | null
  userRatingCount?: number | null
  siteRate?: number
  isPrimary?: boolean
}

function haversineMeters(
  lat1?: number | null,
  lng1?: number | null,
  lat2?: number | null,
  lng2?: number | null,
): number {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return Infinity
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function checkCompatibility(campground: CampgroundResult, rig: any) {
  const issues: string[] = []

  if (campground.maxRigLength && rig.length && rig.length > campground.maxRigLength) {
    issues.push(`Site max ${campground.maxRigLength}ft — your rig is ${rig.length}ft`)
  }
  if (campground.maxRigHeight && rig.height && rig.height > campground.maxRigHeight) {
    issues.push(`Height restriction ${campground.maxRigHeight}ft — your rig is ${rig.height}ft`)
  }
  if (campground.rvProhibited && rig.vehicleType !== 'CAR_CAMPING' && rig.vehicleType !== 'VAN') {
    issues.push('RVs and trailers not permitted at this location')
  }

  return {
    isCompatible: issues.length === 0,
    reasons: issues,
  }
}

// `options.filter` overrides the default camping-relevance filter for callers
// with a different inclusion rule (the OHV page filters on the OFF HIGHWAY
// VEHICLE activity instead). `options.limit` raises the RIDB result cap for
// that caller WITHOUT changing it for everyone else. Both default to the prior
// behavior, so van/car/military/search are unaffected.
async function fetchRecGovCampgrounds(
  query: string,
  lat?: number,
  lng?: number,
  radius = 25,
  options?: { limit?: number; filter?: (f: any) => boolean; coarseGeoCacheKey?: boolean },
): Promise<CampgroundResult[]> {
  const limit = options?.limit ?? 20
  // OHV opts into a coarser geo cache key (lat/lng rounded to 2 decimals, ~1km)
  // so the jittered full-precision GPS coords from repeat page loads still hit
  // the same Redis entry. Other callers keep the original full-precision key, so
  // their caching is byte-for-byte unchanged. Rounding affects ONLY the cache
  // key — the upstream RIDB request below still uses the real lat/lng.
  const keyLat = options?.coarseGeoCacheKey && lat != null ? lat.toFixed(2) : lat
  const keyLng = options?.coarseGeoCacheKey && lng != null ? lng.toFixed(2) : lng
  const cacheKey = `recgov:${query}:${keyLat}:${keyLng}:${radius}:${limit}`
  const cached = await getCache<any[]>(cacheKey)
  if (cached) return cached

  if (!process.env.RECGOV_API_KEY) {
    console.warn('[campgrounds] RECGOV_API_KEY not set — returning empty campground list. Set this in .env to enable real RIDB data.')
    return []
  }

  try {
    // Only send the text `query` when non-empty. RIDB ANDs the full-text query
    // with the geo filter, which cripples recall for a location-aware search
    // (live probe: "OHV…" + 50-mi radius returned ~1 result near Moab vs ~50
    // geo-only). Callers doing a geo + post-filter search (OHV) pass query=''.
    const params: any = { limit, full: 'true' }
    if (query) params.query = query
    if (lat && lng) { params.latitude = lat; params.longitude = lng; params.radius = radius }

    const res = await axios.get('https://ridb.recreation.gov/api/v1/facilities', {
      params,
      headers: { apikey: process.env.RECGOV_API_KEY || '' },
      timeout: 8000,
    })

    const recdata = res.data.RECDATA || []
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[RIDB] Returned ${recdata.length} facilities for query=${query}`)
      console.log('[RIDB] First 2 results raw shape:', JSON.stringify(recdata.slice(0, 2), null, 2))
    }

    // Default inclusion: RIDB returns lookout towers, picnic areas, day-use
    // sites, ranger stations, etc. — keep only facilities that are a campground,
    // list CAMPING, or have a campsite. Callers can override (the OHV page
    // filters on the OFF HIGHWAY VEHICLE activity to include day-use riding
    // spots that this default would drop).
    const defaultFilter = (f: any): boolean => {
      if (f.FacilityTypeDescription === 'Campground') return true
      const activities: { ActivityName?: string }[] = f.ACTIVITY || []
      if (activities.some(a => a.ActivityName === 'CAMPING')) return true
      const campsites: any[] = f.CAMPSITE || []
      if (campsites.length > 0) return true
      return false
    }
    const keep = options?.filter ?? defaultFilter
    const campingRelevant = recdata.filter(keep)
    const dropped = recdata.length - campingRelevant.length
    console.log(`[RIDB] Filtered ${dropped} non-matching facilities, kept ${campingRelevant.length} for query="${query}"`)

    const campgrounds = campingRelevant.map((f: any) => {
      const addr = f.FACILITYADDRESS?.[0]
      const addressParts = addr
        ? [addr.AddressLine1, addr.City, addr.AddressStateCode, addr.PostalCode].filter(Boolean)
        : []

      // Parse FACILITYATTRIBUTE array for hookups, pet policy, rig limits
      const attrs: { AttributeName: string; AttributeValue: string }[] = f.FACILITYATTRIBUTE || []
      const attrMap: Record<string, string> = {}
      for (const a of attrs) {
        attrMap[a.AttributeName?.toLowerCase() || ''] = a.AttributeValue || ''
      }

      const hookupTypes: string[] = []
      if (attrMap['electric hookup'] || attrMap['electricity hookup']) hookupTypes.push('Electric')
      if (attrMap['water hookup']) hookupTypes.push('Water')
      if (attrMap['sewer hookup']) hookupTypes.push('Sewer')

      const maxRigLength = attrMap['max vehicle length']
        ? parseFloat(attrMap['max vehicle length']) || null
        : null
      const maxRigHeight = attrMap['max vehicle height']
        ? parseFloat(attrMap['max vehicle height']) || null
        : null

      const petsValue = attrMap['pets allowed'] || attrMap['pets allowed in site']
      const isPetFriendly = petsValue
        ? petsValue.toLowerCase() === 'yes' || petsValue.toLowerCase() === 'true'
        : undefined

      // Prefer the facility's map/brochure URL; fall back to its Recreation.gov page
      const website =
        f.FacilityMapURL ||
        (f.FacilityID ? `https://www.recreation.gov/camping/campgrounds/${f.FacilityID}` : null)

      // Phase 1B URL-bug fix: only emit a reservationUrl when the facility is actually
      // reservable AND we have a real URL to send the user to. Many RIDB facilities are
      // marked Reservable=false (no online booking) — constructing the canonical
      // /camping/campgrounds/{id} URL for them lands on the dancing-bear 404 page.
      // When unreservable or URL-less, leave it null and let the frontend render the
      // "Search Google Maps" fallback instead.
      const isReservable = f.Reservable === true || f.Reservable === 'true'
      const reservationUrl = (isReservable && f.FacilityReservationURL) ? f.FacilityReservationURL : null

      const lat_ = parseFloat(String(f.FacilityLatitude))
      const lng_ = parseFloat(String(f.FacilityLongitude))

      // Real activity names from the RIDB record (already present; previously
      // used only for the camping filter above). Title-cased + de-duped so the
      // OHV page can show genuine activities ("Off Highway Vehicle", "Camping")
      // instead of hardcoded terrain tags. e.g. "OFF HIGHWAY VEHICLE" → "Off
      // Highway Vehicle".
      const rawActivityNames: string[] = ((f.ACTIVITY as { ActivityName?: string }[]) || [])
        .map(a => a.ActivityName)
        .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      const activityNames: string[] = Array.from(new Set(
        rawActivityNames.map(n => n.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())),
      ))

      // Overnight-stay signal for the OHV "Camping available" vs "Day-use"
      // badge: a campground, any campsites, or a CAMPING activity tag.
      const campingAvailable =
        f.FacilityTypeDescription === 'Campground' ||
        ((f.CAMPSITE as any[]) || []).length > 0 ||
        rawActivityNames.includes('CAMPING')

      return {
        id: `recgov-${f.FacilityID}`,
        name: f.FacilityName,
        latitude: isNaN(lat_) ? undefined : lat_,
        longitude: isNaN(lng_) ? undefined : lng_,
        description: f.FacilityDescription,
        reservationUrl,
        website,
        address: addressParts.length > 0 ? addressParts.join(', ') : null,
        phone: f.FacilityPhone || null,
        isPetFriendly,
        source: 'recreation.gov',
        reservable: isReservable,
        hookupTypes: hookupTypes.length > 0 ? hookupTypes : undefined,
        activities: activityNames.length > 0 ? activityNames : undefined,
        campingAvailable,
        maxRigLength,
        maxRigHeight,
        rvProhibited: false,
      }
    })

    await setCache(cacheKey, campgrounds, 3600)
    return campgrounds
  } catch (e: any) {
    const status = e?.response?.status
    if (status === 401 || status === 403) {
      console.error('[RecGov] API key invalid or unauthorized (HTTP %d) — returning empty list', status)
      return []
    }
    console.error('RecGov API error:', e)
    return []
  }
}

export async function searchCampgrounds(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { q, lat, lng, radius, stopId } = req.query

    const userId = req.user!.id

    // Phase 1B: when a stopId is provided, orchestrate three tiers of campground data.
    //   Tier 1 (RIDB)        — federal/state, free, verified
    //   Tier 2 (Places-verified AI suggestions) — verified by Google Places
    //   Tier 3 (AI-only)     — AI suggested but Places couldn't find it; surfaced
    //                          with an "AI suggestion" badge + Google Maps search link
    // Without a stopId we keep the legacy RIDB-only behavior so the destinations
    // pages (military, OHV, van, car-camping) and any other callers don't change.
    let stop: {
      id: string
      locationName: string
      locationState: string | null
      campgroundName: string | null
      campgroundCandidates: any
    } | null = null
    if (stopId && typeof stopId === 'string') {
      stop = await prisma.stop.findFirst({
        where: { id: stopId, trip: { userId } },
        select: { id: true, locationName: true, locationState: true, campgroundName: true, campgroundCandidates: true },
      })
      console.log(
        `[campgrounds] Orchestration triggered for stopId=${stopId}, candidates=${JSON.stringify(stop?.campgroundCandidates ?? null)}`,
      )
    }

    // Tier 1 — RIDB (always runs, with or without stopId)
    const ridbCampgrounds = await fetchRecGovCampgrounds(
      (q as string) || 'campground',
      lat ? parseFloat(lat as string) : undefined,
      lng ? parseFloat(lng as string) : undefined,
      radius ? parseInt(radius as string) : 25
    )

    // Tier 2 + 3 — only when we have a stop with AI candidates
    const placesResults: CampgroundResult[] = []
    const aiOnlyResults: CampgroundResult[] = []

    if (stop && Array.isArray(stop.campgroundCandidates) && stop.campgroundCandidates.length > 0) {
      const candidateNames: string[] = (stop.campgroundCandidates as any[])
        .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      const locationLabel = stop.locationState
        ? `${stop.locationName}, ${stop.locationState}`
        : stop.locationName

      const verifications = await verifyCampgroundBatch(
        candidateNames.map(name => ({ name, location: locationLabel })),
        { userId },
      )

      // Places' text search is fuzzy: different AI-suggested names can resolve to the same
      // canonical place ("Sedona RV Resort" + "Rancho Sedona RV Park" → same placeId).
      // Track placeIds so the merged response only surfaces each verified place once.
      const seenPlaceIds = new Set<string>()

      verifications.forEach((verified, idx) => {
        const originalName = candidateNames[idx]
        if (verified) {
          if (seenPlaceIds.has(verified.placeId)) return
          seenPlaceIds.add(verified.placeId)

          placesResults.push({
            id: `places-${verified.placeId}`,
            name: verified.name,
            address: verified.address,
            phone: verified.phone,
            website: verified.website,
            // Places' googleMapsUri is the user's "Book at" target — opens the listing
            // where they can click through to the real campground site or call directly.
            reservationUrl: verified.website || verified.googleMapsUrl,
            latitude: verified.latitude,
            longitude: verified.longitude,
            rating: verified.rating,
            userRatingCount: verified.userRatingCount,
            source: 'google_places',
          })
        } else {
          // Tier 3 — AI suggested but Places couldn't verify. Surface structurally
          // identical to verified entries: the reservationUrl points at a Google Maps
          // search so the frontend's single "Book at [name]" button still works without
          // branching on a verified flag. Honesty lives in where the URL lands, not in
          // visible UI labels. source stays for backend telemetry/logging.
          aiOnlyResults.push({
            id: `ai-${idx}-${originalName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
            name: originalName,
            address: null,
            phone: null,
            rating: null,
            reservationUrl: `https://www.google.com/maps/search/${encodeURIComponent(originalName + ' ' + locationLabel)}`,
            source: 'ai_only',
          })
        }
      })
    }

    // Tier 2 fallback: stop exists but has no AI candidates (e.g. modified-mode
    // adds, manual UI inserts). Run a generic Places area search so users still
    // get verified campgrounds instead of a "Recreation.gov returned nothing"
    // dead end. Mirror the existing Places branch shape exactly so dedup +
    // ordering downstream don't have to special-case fallback hits.
    if (
      stop &&
      placesResults.length === 0 &&
      aiOnlyResults.length === 0 &&
      (!Array.isArray(stop.campgroundCandidates) || stop.campgroundCandidates.length === 0) &&
      stop.locationName
    ) {
      const areaResults = await searchCampgroundsByArea(
        stop.locationName,
        stop.locationState,
        { userId },
      )
      for (const r of areaResults) {
        if (placesResults.some(p => p.id === `places-${r.placeId}`)) continue
        placesResults.push({
          id: `places-${r.placeId}`,
          name: r.name,
          address: r.address,
          phone: r.phone,
          website: r.website,
          reservationUrl: r.website || r.googleMapsUrl,
          latitude: r.latitude,
          longitude: r.longitude,
          rating: r.rating,
          userRatingCount: r.userRatingCount,
          source: 'google_places',
        })
      }
      console.log(`[campgrounds] Area-fallback ran for stopId=${stopId}, returned=${areaResults.length}`)
    }

    // Drop any RIDB facility that the Places batch already covers — Places has richer
    // data (rating, phone, website) so it's the canonical entry when both find the same
    // campground. Match by name (case-insensitive) OR by ≤100m proximity, since the same
    // campground can show up under different names in the two systems.
    const dedupedRidb = ridbCampgrounds.filter(r => {
      return !placesResults.some(p => {
        if (p.name && r.name && p.name.toLowerCase().trim() === r.name.toLowerCase().trim()) {
          return true
        }
        return haversineMeters(p.latitude, p.longitude, r.latitude, r.longitude) <= 100
      })
    })

    // Tier ordering: Places-verified → RIDB → AI-only.
    // Places-verified are AI-curated, RV-relevant campgrounds (KOAs, RV resorts, real
    // parks) and should headline. RIDB is mostly federal cabin rentals and day-use sites
    // that aren't typically what RVers want, so it sits below the curated picks.
    // First entry across the merged list becomes the "primary" card on the booking page.
    const merged: CampgroundResult[] = [
      ...placesResults,
      ...dedupedRidb,
      ...aiOnlyResults,
    ]

    // User-named primary: when the user has chosen a specific campground for this stop
    // (via Modify-with-AI's suggest_campground or the EditStopModal), that choice MUST
    // win the primary-card slot regardless of what Places/RIDB returned. We try one
    // verifyCampground lookup to hydrate full details (rating/phone/website/lat-lng);
    // on Places miss we synthesize a name-only entry mirroring the Tier 3 AI-only
    // shape so the card still renders cleanly. The synthesized id is deterministic
    // (places-{placeId} on hit, user-named-{stopId} on miss) so the booking-commit
    // flow's `bookedCg = cgs.find(cg => cg.id === stop.campgroundId)` reload-match
    // continues to work across requests.
    if (stop && stop.campgroundName && stop.campgroundName.trim().length > 0) {
      const namedLocationLabel = stop.locationState
        ? `${stop.locationName}, ${stop.locationState}`
        : stop.locationName
      const verifiedNamed = await verifyCampground(
        stop.campgroundName,
        namedLocationLabel,
        { userId },
      )
      let namedEntry: CampgroundResult
      if (verifiedNamed) {
        namedEntry = {
          id: `places-${verifiedNamed.placeId}`,
          name: verifiedNamed.name,
          address: verifiedNamed.address,
          phone: verifiedNamed.phone,
          website: verifiedNamed.website,
          reservationUrl: verifiedNamed.website || verifiedNamed.googleMapsUrl,
          latitude: verifiedNamed.latitude,
          longitude: verifiedNamed.longitude,
          rating: verifiedNamed.rating,
          userRatingCount: verifiedNamed.userRatingCount,
          source: 'google_places',
        }
      } else {
        namedEntry = {
          id: `user-named-${stop.id}`,
          name: stop.campgroundName,
          address: null,
          phone: null,
          rating: null,
          reservationUrl: `https://www.google.com/maps/search/${encodeURIComponent(stop.campgroundName + ' ' + namedLocationLabel)}`,
          source: 'user_named',
        }
      }
      // Dedup by id: if the user-named campground was also surfaced by the AI-candidates
      // Places batch (same placeId), remove the duplicate before prepending so the
      // alternates list (compatible.filter(cg => cg.id !== recommended?.id)) excludes it
      // cleanly and we don't render the same card twice.
      const dupIdx = merged.findIndex(cg => cg.id === namedEntry.id)
      if (dupIdx >= 0) merged.splice(dupIdx, 1)
      merged.unshift(namedEntry)
      console.log(
        `[campgrounds] User-named campground "${stop.campgroundName}" prepended for stopId=${stop.id} (verified=${!!verifiedNamed})`,
      )
    }

    if (merged.length > 0) {
      merged[0].isPrimary = true
    }

    // Get user's default rig for compatibility check
    const rig = await prisma.rig.findFirst({ where: { userId, isDefault: true } })

    const results = merged.map(cg => {
      if (rig) {
        const compat = checkCompatibility(cg, rig)
        return { ...cg, isCompatible: compat.isCompatible, incompatibilityReasons: compat.reasons }
      }
      return { ...cg, isCompatible: true, incompatibilityReasons: [] }
    })

    res.json(results)
  } catch (err) { next(err) }
}

export async function getCampground(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const cacheKey = `campground:${id}`
    const cached = await getCache(cacheKey)
    if (cached) return res.json(cached)

    if (id.startsWith('recgov-')) {
      const facilityId = id.replace('recgov-', '')
      const response = await axios.get(`https://ridb.recreation.gov/api/v1/facilities/${facilityId}`, {
        headers: { apikey: process.env.RECGOV_API_KEY || '' },
        timeout: 5000,
      })
      const data = response.data
      await setCache(cacheKey, data, 3600)
      return res.json(data)
    }

    res.json({ id, message: 'Campground details' })
  } catch (err) { next(err) }
}

export async function getCompatible(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rig = await prisma.rig.findFirst({ where: { userId: req.user!.id, isDefault: true } })
    if (!rig) return res.json([])

    const { lat, lng, q } = req.query
    const campgrounds = await fetchRecGovCampgrounds(
      (q as string) || 'campground',
      lat ? parseFloat(lat as string) : undefined,
      lng ? parseFloat(lng as string) : undefined
    )

    const compatible = campgrounds.filter(cg => {
      const compat = checkCompatibility(cg, rig)
      return compat.isCompatible
    })

    res.json(compatible)
  } catch (err) { next(err) }
}

export async function getMilitary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const profile = await prisma.travelProfile.findUnique({ where: { userId: req.user!.id } })
    if (!profile?.militaryStatus && !profile?.firstResponder) {
      return res.status(403).json({ error: 'Military/first responder status required' })
    }

    const campgrounds = await fetchRecGovCampgrounds('military famcamp')
    res.json(campgrounds.map(cg => ({ ...cg, isMilitaryOnly: true })))
  } catch (err) { next(err) }
}

export async function getOhv(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Location-aware (browser GPS, 50-mi radius). GEO-ONLY query (no keyword):
    // a live RIDB probe showed the full-text keyword AND'd with the radius
    // crippled recall (~1 result near Moab vs ~50 geo-only), so we fetch the
    // nearest facilities and apply the OFF HIGHWAY VEHICLE activity filter
    // ourselves. That INCLUDES day-use riding spots (trailheads/staging areas,
    // type "Facility") the default campground filter drops, and EXCLUDES
    // campgrounds that aren't OHV-tagged. Open to all rig types; camping-vs-
    // day-use is a per-card label, not a gate. (Coverage caveat: RIDB returns
    // at most the ~50 nearest facilities and doesn't index BLM dispersed /
    // forest-road / most state OHV land, so sparse regions yield few or none.)
    const lat = req.query.lat ? parseFloat(req.query.lat as string) : undefined
    const lng = req.query.lng ? parseFloat(req.query.lng as string) : undefined
    const radius = req.query.radius ? parseInt(req.query.radius as string, 10) : 50

    const facilities = await fetchRecGovCampgrounds(
      '', // geo-only — see note above; OHV precision comes from the filter below
      lat, lng, radius,
      {
        limit: 50, // grab the nearest 50, then filter to OHV-tagged + slice to 10
        coarseGeoCacheKey: true, // ~1km cache key so jittered GPS reloads hit cache
        filter: (f: any) =>
          Array.isArray(f.ACTIVITY) &&
          f.ACTIVITY.some((a: any) => a?.ActivityName === 'OFF HIGHWAY VEHICLE'),
      },
    )

    // Distance from the GPS origin (haversine → miles), nearest first. Results
    // without coords (or when no origin was sent) sort last with null distance.
    const withDistance = facilities
      .map(c => {
        const meters = lat != null && lng != null
          ? haversineMeters(lat, lng, c.latitude, c.longitude)
          : Infinity
        const distanceMiles = Number.isFinite(meters)
          ? Math.round((meters / 1609.34) * 10) / 10
          : null
        return { ...c, distanceMiles }
      })
      .sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity))
      .slice(0, 10)

    res.json(withDistance)
  } catch (err) { next(err) }
}

export async function getVan(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const campgrounds = await fetchRecGovCampgrounds('dispersed camping BLM')
    res.json(campgrounds.map(cg => ({
      ...cg,
      type: 'BLM/Dispersed',
      stealthRating: 'High',
      connectivityRating: 'Variable',
    })))
  } catch (err) { next(err) }
}

export async function getCarCamping(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const campgrounds = await fetchRecGovCampgrounds('tent camping backcountry')
    res.json(campgrounds.map(cg => ({
      ...cg,
      siteTypes: ['tent', 'walk-in', 'backcountry'],
    })))
  } catch (err) { next(err) }
}
