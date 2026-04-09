import { Response, NextFunction } from 'express'
import axios from 'axios'
import { AuthRequest } from '../middleware/auth'
import { getCache, setCache } from '../utils/redis'

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

    const cacheKey = `resources:${lat}:${lng}:${resourceType}:${radius}`
    const cached = await getCache(cacheKey)
    if (cached) return res.json(cached)

    // Use Google Places API if key available
    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) {
      return res.json({ resources: [], message: 'Google Maps API key not configured' })
    }

    try {
      const googleRes = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: {
          location: `${lat},${lng}`,
          radius: parseInt(radius as string) * 1609,
          keyword: query,
          key: apiKey,
        },
        timeout: 5000,
      })

      const resources = (googleRes.data.results || []).slice(0, 10).map((place: any) => ({
        id: place.place_id,
        name: place.name,
        address: place.vicinity,
        latitude: place.geometry.location.lat,
        longitude: place.geometry.location.lng,
        rating: place.rating,
        isOpen: place.opening_hours?.open_now,
        type: resourceType,
        phone: place.formatted_phone_number,
      }))

      await setCache(cacheKey, resources, 3600)
      return res.json(resources)
    } catch (e) {
      console.error('Google Places error:', e)
      return res.json([])
    }
  } catch (err) { next(err) }
}
