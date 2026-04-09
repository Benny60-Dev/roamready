import { Response, NextFunction } from 'express'
import axios from 'axios'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { getCache, setCache } from '../utils/redis'

interface CampgroundResult {
  id: string
  name: string
  latitude?: number
  longitude?: number
  description?: string
  reservationUrl?: string
  website?: string
  address?: string
  phone?: string
  attributes?: any
  maxRigLength?: number
  maxRigHeight?: number
  rvProhibited?: boolean
  isPetFriendly?: boolean
  isMilitaryOnly?: boolean
  hookupTypes?: string[]
  amenities?: string[]
  reservable?: boolean
  source?: string
  isCompatible?: boolean
  incompatibilityReasons?: string[]
  rating?: number
  siteRate?: number
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

function getMockCampgrounds(query: string, lat?: number, lng?: number): CampgroundResult[] {
  console.warn('[RecGov] RECGOV_API_KEY not set — returning mock campground data')
  return [
    {
      id: 'mock-1',
      name: `Pine Ridge RV Resort (near ${query})`,
      address: '1234 Forest Road, Sample City, CA 95000',
      phone: '(555) 867-5309',
      website: 'https://www.recreation.gov',
      reservationUrl: 'https://www.recreation.gov',
      latitude: lat ? lat + 0.05 : 37.5,
      longitude: lng ? lng + 0.05 : -119.5,
      hookupTypes: ['Electric', 'Water'],
      isPetFriendly: true,
      isMilitaryOnly: false,
      maxRigLength: 45,
      rating: 4.3,
      siteRate: 42,
      source: 'mock',
      isCompatible: true,
      incompatibilityReasons: [],
    },
    {
      id: 'mock-2',
      name: `Riverside RV Park (near ${query})`,
      address: '5678 River Drive, Sample City, CA 95001',
      phone: '(555) 555-0100',
      website: 'https://www.recreation.gov',
      reservationUrl: 'https://www.recreation.gov',
      latitude: lat ? lat - 0.05 : 37.45,
      longitude: lng ? lng - 0.05 : -119.55,
      hookupTypes: ['Electric', 'Water', 'Sewer'],
      isPetFriendly: true,
      isMilitaryOnly: false,
      maxRigLength: 55,
      rating: 4.7,
      siteRate: 58,
      source: 'mock',
      isCompatible: true,
      incompatibilityReasons: [],
    },
    {
      id: 'mock-3',
      name: `Oak Flat Campground (near ${query})`,
      address: '9012 Mountain View Rd, Sample City, CA 95002',
      phone: undefined,
      website: 'https://www.recreation.gov',
      reservationUrl: undefined,
      latitude: lat ? lat + 0.1 : 37.6,
      longitude: lng ? lng - 0.1 : -119.6,
      hookupTypes: [],
      isPetFriendly: false,
      isMilitaryOnly: false,
      maxRigLength: 20,
      rating: 3.8,
      siteRate: 22,
      source: 'mock',
      isCompatible: true,
      incompatibilityReasons: [],
    },
    {
      id: 'mock-4',
      name: `Ponderosa Pines Campground (near ${query})`,
      address: '3400 Ponderosa Way, Sample City, CA 95003',
      phone: '(555) 444-9876',
      website: 'https://www.recreation.gov',
      reservationUrl: 'https://www.recreation.gov',
      latitude: lat ? lat - 0.08 : 37.42,
      longitude: lng ? lng + 0.08 : -119.42,
      hookupTypes: ['Electric'],
      isPetFriendly: true,
      isMilitaryOnly: false,
      maxRigLength: 40,
      rating: 4.1,
      siteRate: 35,
      source: 'mock',
      isCompatible: true,
      incompatibilityReasons: [],
    },
  ]
}

async function fetchRecGovCampgrounds(query: string, lat?: number, lng?: number, radius = 25) {
  const cacheKey = `recgov:${query}:${lat}:${lng}`
  const cached = await getCache<any[]>(cacheKey)
  if (cached) return cached

  if (!process.env.RECGOV_API_KEY) {
    return getMockCampgrounds(query, lat, lng)
  }

  try {
    const params: any = { query, limit: 20, full: 'true' }
    if (lat && lng) { params.latitude = lat; params.longitude = lng; params.radius = radius }

    const res = await axios.get('https://ridb.recreation.gov/api/v1/facilities', {
      params,
      headers: { apikey: process.env.RECGOV_API_KEY || '' },
      timeout: 8000,
    })

    const campgrounds = (res.data.RECDATA || []).map((f: any) => {
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

      const lat_ = parseFloat(String(f.FacilityLatitude))
      const lng_ = parseFloat(String(f.FacilityLongitude))

      return {
        id: `recgov-${f.FacilityID}`,
        name: f.FacilityName,
        latitude: isNaN(lat_) ? undefined : lat_,
        longitude: isNaN(lng_) ? undefined : lng_,
        description: f.FacilityDescription,
        reservationUrl: f.FacilityReservationURL || null,
        website,
        address: addressParts.length > 0 ? addressParts.join(', ') : null,
        phone: f.FacilityPhone || null,
        isPetFriendly,
        source: 'recreation.gov',
        reservable: f.Reservable,
        hookupTypes: hookupTypes.length > 0 ? hookupTypes : undefined,
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
      console.error('[RecGov] API key invalid or unauthorized (HTTP %d) — falling back to mock data', status)
      return getMockCampgrounds(query, lat, lng)
    }
    console.error('RecGov API error:', e)
    return getMockCampgrounds(query, lat, lng)
  }
}

export async function searchCampgrounds(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { q, lat, lng, radius, military } = req.query

    const campgrounds = await fetchRecGovCampgrounds(
      (q as string) || 'campground',
      lat ? parseFloat(lat as string) : undefined,
      lng ? parseFloat(lng as string) : undefined,
      radius ? parseInt(radius as string) : 25
    )

    // Get user's default rig for compatibility check
    const rig = await prisma.rig.findFirst({ where: { userId: req.user!.id, isDefault: true } })

    const results = campgrounds.map(cg => {
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
    const rig = await prisma.rig.findFirst({ where: { userId: req.user!.id, isDefault: true } })
    const campgrounds = await fetchRecGovCampgrounds('OHV ATV off-highway vehicle')

    const destinations = campgrounds.map(cg => ({
      ...cg,
      season: 'Year-round (check local conditions)',
      terrainTypes: ['Desert trails', 'Mountain trails'],
      matchScore: rig?.isToyHauler ? 95 : 60,
    }))

    res.json(destinations)
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
