import { Response, NextFunction } from 'express'
import axios from 'axios'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import type { MembershipCreateInput, MembershipUpdateInput } from '../schemas'

const DEFAULT_RV_MAINTENANCE = [
  { name: 'Engine oil & filter', intervalMiles: 5000 },
  { name: 'Engine air filter', intervalMiles: 7500 },
  { name: 'Transmission fluid', intervalMiles: 15000 },
  { name: 'Tire rotation & inspection', intervalMiles: 6000 },
  { name: 'Generator service', intervalMonths: 6 },
  { name: 'Roof inspection & reseal', intervalMonths: 12 },
  { name: 'Slide-out seal inspection', intervalMonths: 12 },
  { name: 'Battery check & service', intervalMonths: 6 },
  { name: 'LP system inspection', intervalMonths: 12 },
  { name: 'Brake inspection', intervalMiles: 12000 },
  { name: 'Wheel bearing service', intervalMiles: 10000 },
  { name: 'Awning inspection', intervalMonths: 12 },
]

export async function getMe(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    console.log('[getMe] called for user', req.user!.id)
    let user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { rigs: true, travelProfile: true, memberships: true, parties: { include: { people: true, pets: true } } },
    })

    console.log('[getMe] backfill check — homeLat is', user?.homeLat, 'homeLocation is', user?.homeLocation)

    // One-time backfill: if the user has a legacy homeLocation string but no structured
    // lat/lng yet, geocode it now and persist the result so downstream features work correctly.
    if (user && user.homeLocation && user.homeLat == null) {
      const apiKey = process.env.GOOGLE_MAPS_API_KEY
      console.log('[getMe] backfill running — calling geocoder for', user.homeLocation, '| apiKey present:', !!apiKey)
      if (apiKey) {
        try {
          const geoRes = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: { address: user.homeLocation, key: apiKey },
          })
          const result = geoRes.data?.results?.[0]
          console.log('[getMe] geocoder returned status=%s result=%s', geoRes.data?.status, result ? result.formatted_address : 'null')
          if (result) {
            const { lat, lng } = result.geometry.location
            const components: any[] = result.address_components || []
            const get = (type: string, short = false) =>
              components.find((c: any) => c.types.includes(type))?.[short ? 'short_name' : 'long_name'] ?? null
            const homeCity    = get('locality') || get('sublocality') || null
            const homeState   = get('administrative_area_level_1', true)
            const homeZip     = get('postal_code')
            const homeStreet  = [get('street_number'), get('route')].filter(Boolean).join(' ') || null
            const homeAddress = result.formatted_address || user.homeLocation

            user = await prisma.user.update({
              where: { id: req.user!.id },
              data: { homeLat: lat, homeLng: lng, homeCity, homeState, homeZip, homeStreet, homeAddress },
              include: { rigs: true, travelProfile: true, memberships: true, parties: { include: { people: true, pets: true } } },
            }) as typeof user
            console.log('[getMe] backfill complete — saved', { homeLat: lat, homeLng: lng, homeCity, homeState, homeZip, homeStreet, homeAddress })
          }
        } catch (geoErr) {
          console.warn('[getMe:backfill] geocode failed for user %s:', req.user!.id, geoErr)
        }
      }
    }

    // Strip sensitive / server-only fields before responding. See
    // auth.ts:getMe for the full rationale on each field. Mirror any
    // future strips in this file's updateMe + the auth.ts getMe.
    if (!user) return res.json(null)
    const {
      passwordHash: _ph,
      emailVerificationToken: _evt,
      emailVerificationSentAt: _evsa,
      ...safe
    } = user as any
    res.json(safe)
  } catch (err) { next(err) }
}

export async function updateMe(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // emergencyContact + emergencyPhone removed from the payload (Block 6).
    // The Prisma columns remain on the User model (orphaned) so the one-time
    // backfillTravelParty script still compiles + runs if the DB is re-seeded,
    // but the application layer no longer writes them. Prisma treats absent
    // keys in data{} as "don't update this column", so any existing values
    // in the DB are preserved untouched.
    const {
      firstName, lastName, phone, avatarUrl,
      homeLocation, homeAddress, homeStreet, homeCity, homeState, homeZip, homeLat, homeLng,
    } = req.body
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        firstName, lastName, phone, avatarUrl,
        homeLocation, homeAddress, homeStreet, homeCity, homeState, homeZip, homeLat, homeLng,
      },
    })
    // Strip sensitive / server-only fields before responding — see
    // auth.ts:getMe for the full rationale.
    const {
      passwordHash: _ph,
      emailVerificationToken: _evt,
      emailVerificationSentAt: _evsa,
      ...safe
    } = user as any
    res.json(safe)
  } catch (err) { next(err) }
}

export async function deleteMe(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await prisma.user.delete({ where: { id: req.user!.id } })
    res.clearCookie('refreshToken')
    res.json({ message: 'Account deleted' })
  } catch (err) { next(err) }
}

export async function getRigs(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rigs = await prisma.rig.findMany({ where: { userId: req.user!.id } })
    res.json(rigs)
  } catch (err) { next(err) }
}

// ─── Rig write-allowlist ─────────────────────────────────────────────────────
// Explicit field allowlist for createRig / updateRig. Replaces the previous
// req.body passthrough. Anything not listed here is silently dropped — that
// includes id / userId / createdAt / updatedAt (managed by Prisma) and the
// legacy free-form `towVehicle` / `towingSetup` columns (deprecated since the
// rig-towing-and-plate change; structured fields below are the source of truth).
function pickRigInput(body: any) {
  const {
    vehicleType,
    year, make, model,
    length, height,
    fuelType, mpg, tankSize,
    slideouts, electricalAmps,
    isToyHauler, garageLength, gvwr, toys, terrainTypes,
    isVan, vanLength,
    powerSetup, waterCapacity,
    hasStarlink, isRemoteWorker,
    isCamper, sleepSetup, isOffRoad,
    isDefault, currentMiles,
    // Plate + structured towing
    licensePlate,
    isTowing, towedType,
    towedYear, towedMake, towedModel, towedLength, towedLicensePlate,
  } = body ?? {}
  return {
    vehicleType,
    year, make, model,
    length, height,
    fuelType, mpg, tankSize,
    slideouts, electricalAmps,
    isToyHauler, garageLength, gvwr, toys, terrainTypes,
    isVan, vanLength,
    powerSetup, waterCapacity,
    hasStarlink, isRemoteWorker,
    isCamper, sleepSetup, isOffRoad,
    isDefault, currentMiles,
    licensePlate,
    isTowing, towedType,
    towedYear, towedMake, towedModel, towedLength, towedLicensePlate,
  }
}

export async function createRig(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id
    const picked = pickRigInput(req.body)
    const data: any = { ...picked, userId }

    // If first rig, set as default. Honors caller's isDefault if explicitly true,
    // otherwise auto-sets when count is zero. Same behavior as before the allowlist.
    const count = await prisma.rig.count({ where: { userId } })
    if (count === 0) data.isDefault = true

    const rig = await prisma.rig.create({ data })

    // Create default maintenance items for RV types
    const isRV = ['RV_CLASS_A', 'RV_CLASS_B', 'RV_CLASS_C', 'FIFTH_WHEEL', 'TRAVEL_TRAILER', 'TOY_HAULER', 'POP_UP'].includes(rig.vehicleType)
    if (isRV) {
      await prisma.maintenanceItem.createMany({
        data: DEFAULT_RV_MAINTENANCE.map(item => ({ ...item, rigId: rig.id })),
      })
    }

    res.status(201).json(rig)
  } catch (err) { next(err) }
}

export async function updateRig(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rig = await prisma.rig.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!rig) throw new AppError('Rig not found', 404)

    const data: any = pickRigInput(req.body)
    const updated = await prisma.rig.update({ where: { id: req.params.id }, data })
    res.json(updated)
  } catch (err) { next(err) }
}

export async function deleteRig(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const rig = await prisma.rig.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!rig) throw new AppError('Rig not found', 404)
    await prisma.rig.delete({ where: { id: req.params.id } })
    res.json({ message: 'Rig deleted' })
  } catch (err) { next(err) }
}

export async function getTravelProfile(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const profile = await prisma.travelProfile.findUnique({ where: { userId: req.user!.id } })
    res.json(profile)
  } catch (err) { next(err) }
}

export async function upsertTravelProfile(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Body validated via TravelProfileUpsertSchema in routes/users.ts.
    // Strip server-managed fields the client may have round-tripped — Prisma
    // would error or write stale values if they reached the upsert. The
    // schema accepts these four keys (so .strict() doesn't 400 the request)
    // but they're discarded here. userId on create is set from req.user!.id.
    const { id, userId, createdAt, updatedAt, ...data } = req.body
    const profile = await prisma.travelProfile.upsert({
      where: { userId: req.user!.id },
      update: data,
      create: { ...data, userId: req.user!.id },
    })
    res.json(profile)
  } catch (err) { next(err) }
}

export async function getMemberships(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const memberships = await prisma.membership.findMany({ where: { userId: req.user!.id } })
    res.json(memberships)
  } catch (err) { next(err) }
}

export async function createMembership(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // req.body is guaranteed to be a parsed MembershipCreateInput by
    // validateBody on the route. userId comes from req.user (auth
    // middleware), NEVER from the request body — even if a malicious
    // client tried to inject one, .strict() on the schema would have
    // already rejected the request with a 400.
    const data: MembershipCreateInput = req.body
    const membership = await prisma.membership.create({
      data: { ...data, userId: req.user!.id },
    })
    res.status(201).json(membership)
  } catch (err) { next(err) }
}

export async function updateMembership(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Defense-in-depth: ownership check stays even though validateBody has already
    // stripped any client-supplied id/userId/createdAt from the payload.
    const m = await prisma.membership.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!m) throw new AppError('Membership not found', 404)

    // req.body is guaranteed to be a parsed MembershipUpdateInput by validateBody on the route.
    const data: MembershipUpdateInput = req.body
    const updated = await prisma.membership.update({ where: { id: req.params.id }, data })
    res.json(updated)
  } catch (err) { next(err) }
}

export async function deleteMembership(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const m = await prisma.membership.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!m) throw new AppError('Membership not found', 404)
    await prisma.membership.delete({ where: { id: req.params.id } })
    res.json({ message: 'Membership deleted' })
  } catch (err) { next(err) }
}
