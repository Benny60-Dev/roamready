import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import type { MembershipCreateInput, MembershipUpdateInput } from '../schemas'
import { geocodeHomeAddress } from '../utils/geocodeHome'

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
      // Order rigs by isDefault desc then createdAt asc — mirrors getRigs
      // at line 131-134 so [0] is reliably the user's default rig for
      // every consumer of /users/me. Previously unordered, which let
      // Postgres heap order drift the default off index 0 after row
      // updates and broke the SessionPage chip.
      include: { rigs: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }, travelProfile: true, memberships: true, parties: { include: { people: true, pets: true } } },
    })

    console.log('[getMe] backfill check — homeLat is', user?.homeLat, 'homeLocation is', user?.homeLocation, 'homeAddress is', user?.homeAddress)

    // One-time lazy auto-heal: a user with saved home TEXT but no structured
    // lat/lng yet gets geocoded now and persisted, so downstream features
    // (hasHomeOnFile, createStop coords) work. Trigger broadened to also cover
    // homeAddress (HOME-ADDRESS rung 1): a free-typed / browser-autofilled
    // address lands only in homeAddress (homeLocation null), so the old
    // homeLocation-only trigger never healed it. Skip full-timers (no home).
    if (user && !user.isFullTimeRVer && (user.homeLocation || user.homeAddress) && user.homeLat == null) {
      const geo = await geocodeHomeAddress(user.homeLocation || user.homeAddress || '')
      if (geo) {
        user = await prisma.user.update({
          where: { id: req.user!.id },
          data: geo,
          // Order rigs by isDefault desc then createdAt asc — mirrors getRigs
          // at line 131-134 so [0] is reliably the user's default rig for
          // every consumer of /users/me. Previously unordered, which let
          // Postgres heap order drift the default off index 0 after row
          // updates and broke the SessionPage chip.
          include: { rigs: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }, travelProfile: true, memberships: true, parties: { include: { people: true, pets: true } } },
        }) as typeof user
        console.log('[getMe] backfill complete — healed', { homeCity: geo.homeCity, homeLat: geo.homeLat, homeLng: geo.homeLng })
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
      isFullTimeRVer, dismissedHomePrompt,
    } = req.body

    // HOME-ADDRESS rung 1 — geocode-on-save. A free-typed / browser-autofilled
    // address arrives with text in homeAddress (or homeLocation) but no
    // structured data (homeLat null, no homeCity), so hasHomeOnFile would wrongly
    // report "no home". Backfill the structured fields server-side here, making
    // the free-type path identical to the dropdown-select path. Skips full-timers
    // (no home to resolve) and short-circuits when structured data is already
    // present (dropdown-select). Geocode failure leaves the text as-is — never
    // blocks the save (rung 2's pin-drop handles failures later).
    // HOME-ADDRESS defect D — also re-geocode when the address TEXT changed but
    // the incoming structured fields are stale (belt-and-suspenders for any
    // client that sends new text next to old coords). We read the stored text
    // and compare. "Stale structured" = text changed AND the incoming homeCity
    // does NOT appear in the new text — so a dropdown-pick (whose city matches
    // its own formatted address) still skips the redundant re-geocode.
    const existing = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { homeAddress: true, homeLocation: true },
    })
    const storedText = (existing?.homeAddress || existing?.homeLocation || '').trim().toLowerCase()
    const incomingText = (homeAddress || homeLocation || '').trim()
    const textChanged = !!incomingText && incomingText.toLowerCase() !== storedText
    const cityInText = !!homeCity && incomingText.toLowerCase().includes(String(homeCity).toLowerCase())
    const staleStructured = textChanged && !cityInText

    let homeFields = { homeLocation, homeAddress, homeStreet, homeCity, homeState, homeZip, homeLat, homeLng }
    const hasText = !!(homeAddress || homeLocation)
    const missingStructured = homeLat == null || !homeCity
    if (!isFullTimeRVer && hasText && (missingStructured || staleStructured)) {
      const geo = await geocodeHomeAddress(homeAddress || homeLocation)
      if (geo) {
        // Text changed → the incoming structured fields are ignored in favor of
        // the freshly-geocoded ones (geo overrides the stale values).
        homeFields = { ...homeFields, ...geo }
      } else if (staleStructured) {
        // Text changed to something we can't confidently resolve, and the
        // incoming coords belong to the OLD address — drop them so homeLat is
        // null and the client's rung-2 pin-drop fires (keep the typed text).
        homeFields = {
          ...homeFields,
          homeLocation: null, homeStreet: null, homeCity: null,
          homeState: null, homeZip: null, homeLat: null, homeLng: null,
        }
      }
    }

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        firstName, lastName, phone, avatarUrl,
        ...homeFields,
        isFullTimeRVer, dismissedHomePrompt,
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

// PATCH /users/me/marketing-consent (FR-MARKETING-OPTIN). Records the user's
// explicit marketing-email decision. marketingConsentAt is stamped on EITHER
// answer (opt-in OR "No thanks") so the onboarding modal fires exactly once and
// the in-app toggle can flip the flag later. Body validated by
// MarketingConsentSchema (a single boolean). Returns the safe user so the client
// can update its store with the new flag + timestamp in one round trip.
export async function updateMarketingConsent(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { consent } = req.body as { consent: boolean }
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { marketingConsent: consent, marketingConsentAt: new Date() } as any,
    })
    // Strip sensitive / server-only fields — same set as getMe/updateMe above.
    const {
      passwordHash: _ph,
      emailVerificationToken: _evt,
      emailVerificationSentAt: _evsa,
      ...safe
    } = user as any
    res.json(safe)
  } catch (err) { next(err) }
}

export async function getRigs(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Default rig pinned to the top via `isDefault: 'desc'` (true sorts above
    // false); `createdAt: 'asc'` is the stable tiebreaker for the rest so
    // non-default rigs render in a predictable oldest-first order rather than
    // Postgres's heap-scan / row-visibility default (which can shift after
    // any UPDATE — e.g. the Set-as-default transaction in updateRig). One
    // source of truth so every consumer (RigPage today, trip-create flow,
    // dashboard, etc.) sees the same order without re-implementing it.
    const rigs = await prisma.rig.findMany({
      where: { userId: req.user!.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })
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
    // mpgTowing added in Pass 1 of the towing-aware fuel estimate (May 2026).
    // The fuel service reads it from the rig to pick towing vs solo mileage;
    // it MUST be on this allowlist or it silently won't persist from the
    // rig-profile form. See server/src/services/fuelPrice.ts effectiveMpg.
    fuelType, mpg, mpgTowing, tankSize,
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
    towedHeight, towedFuelType,
  } = body ?? {}
  return {
    vehicleType,
    year, make, model,
    length, height,
    fuelType, mpg, mpgTowing, tankSize,
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
    // Block 7 — tow-vehicle-only fields (truck pulling a trailer/5th wheel).
    // Stay null in the toad direction (form omits the inputs there).
    towedHeight, towedFuelType,
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

    // Single-default-rig invariant. The previous implementation just spread
    // `data` onto the target rig, which meant a user clicking "Set as default"
    // on a second rig left BOTH rigs flagged isDefault=true. Fix: when the
    // caller is promoting a rig to default, do it inside a transaction that
    // first clears isDefault on every OTHER rig the user owns. Prisma's
    // $transaction guarantees rollback if either statement fails, so we
    // can't land in a half-state where the clear ran but the set didn't
    // (or vice versa). For non-default updates the old single-statement
    // path is preserved — no transaction overhead for the common case of
    // editing year/make/model/etc.
    let updated
    if (data.isDefault === true) {
      const [, target] = await prisma.$transaction([
        prisma.rig.updateMany({
          where: { userId: req.user!.id, NOT: { id: req.params.id } },
          data: { isDefault: false },
        }),
        prisma.rig.update({ where: { id: req.params.id }, data }),
      ])
      updated = target
    } else {
      updated = await prisma.rig.update({ where: { id: req.params.id }, data })
    }

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

    // Dedupe guard — endpoint layer. Catches the common case (single
    // sequential POST) with a clean 409 + friendly message. The real
    // integrity guarantee against concurrent inserts is the DB-level
    // @@unique([userId, type]) constraint on the Membership model; the
    // catch block below translates Prisma's P2002 unique-violation to
    // the same 409 contract so callers see one error shape regardless
    // of which layer fired. Mirrors the AppError pattern used in
    // updateMembership above and the P2002 detection in
    // trips.ts:mintUniqueShareToken.
    const existing = await prisma.membership.findFirst({
      where: { userId: req.user!.id, type: data.type },
    })
    if (existing) throw new AppError('You already have this membership saved', 409)

    const membership = await prisma.membership.create({
      data: { ...data, userId: req.user!.id },
    })
    res.status(201).json(membership)
  } catch (err: any) {
    // DB-level unique-constraint race fallback: if two concurrent POSTs
    // slipped past the findFirst above, Prisma rejects the second with
    // P2002. Translate to the same 409 the endpoint guard returns so
    // the client only has to handle one error shape.
    if (err?.code === 'P2002') {
      return next(new AppError('You already have this membership saved', 409))
    }
    next(err)
  }
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
