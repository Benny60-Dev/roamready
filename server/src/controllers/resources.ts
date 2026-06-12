import { Response, NextFunction } from 'express'
import { AuthRequest } from '../middleware/auth'
import { getCache, setCache } from '../utils/redis'
import { searchResourcesNearby } from '../services/googlePlaces'

const RESOURCE_QUERIES: Record<string, string> = {
  rv_repair: 'RV repair service',
  doggy_daycare: 'dog daycare pet boarding',
  propane: 'propane filling station',
  medical: 'urgent care hospital emergency',
  veterinary: 'veterinarian animal hospital',
  rv_wash: 'RV wash truck wash',
  parts_stores: 'RV parts camping supply store',
  free_overnight: 'free overnight parking camping',
  ohv_fuel: 'ATV fuel off-road gas station',
  ohv_repair: 'ATV UTV repair shop',
  dump_station: 'RV dump station sewer',
}

export async function getResources(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { lat, lng, type, radius = '25' } = req.query

    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' })

    const resourceType = (type as string) || 'rv_repair'
    const query = RESOURCE_QUERIES[resourceType] || resourceType
    const radiusMiles = parseInt(radius as string, 10) || 25

    // Cache key is versioned `:v2:` — the migration from legacy Nearby Search
    // to Places API (New) changed the result SHAPE (added phone/website/
    // googleMapsUrl). Bumping the version namespace guarantees stale legacy-
    // shape blobs from before this change are never served to the new client.
    const cacheKey = `resources:v2:${lat}:${lng}:${resourceType}:${radius}`
    const cached = await getCache(cacheKey)
    if (cached) return res.json(cached)

    // New Places API (New) text search, biased to the caller's GPS point.
    // Returns phone / website / googleMapsUrl in the single billed call —
    // see services/googlePlaces.ts searchResourcesNearby. Missing key, a
    // transport error, or zero hits all yield [] (graceful empty list).
    const results = await searchResourcesNearby(
      query,
      Number(lat),
      Number(lng),
      radiusMiles,
      { userId: req.user!.id },
    )
    const resources = results.map(r => ({ ...r, type: resourceType }))

    // Only cache a non-empty result. searchResourcesNearby collapses transport
    // failures into [], so caching [] for an hour would risk blanking results
    // through a transient Google outage. Genuine-empty categories simply
    // re-query next time (cheap, and safer than serving a stale empty).
    if (resources.length > 0) await setCache(cacheKey, resources, 3600)

    return res.json(resources)
  } catch (err) { next(err) }
}
