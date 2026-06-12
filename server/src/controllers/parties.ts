import { Response, NextFunction } from 'express'
import { prisma } from '../utils/prisma'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import type {
  PartyCreateInput,
  PartyUpdateInput,
  PersonCreateInput,
  PersonUpdateInput,
  PetCreateInput,
  PetUpdateInput,
} from '../schemas'

/**
 * Travel Party Phase B controllers.
 *
 * All `/users/me/parties` endpoints are scoped to the authenticated user:
 * - Party-level handlers verify `party.userId === req.user!.id`.
 * - Person/Pet handlers verify the parent party belongs to the user, then
 *   match the row by (id, partyId). The dual-key match prevents a request
 *   like `PUT /me/parties/A/people/B` from updating a Person whose
 *   partyId !== A even if the caller happens to own party A.
 *
 * Trip-scoped parties (userId: null, tripId: set) are NOT exposed by these
 * endpoints. They're created exclusively by trips.ts:createTrip as a clone
 * of the user's default party. No client write path can ever set a tripId
 * here — the schemas reject `tripId` as unknown via .strict().
 */

const PARTY_INCLUDE = { people: true, pets: true } as const

// ─── TravelParty CRUD ─────────────────────────────────────────────────────

export async function getParties(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const parties = await prisma.travelParty.findMany({
      where: { userId: req.user!.id },
      include: PARTY_INCLUDE,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })
    res.json(parties)
  } catch (err) { next(err) }
}

export async function getDefaultParty(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const party = await prisma.travelParty.findFirst({
      where: { userId: req.user!.id, isDefault: true },
      include: PARTY_INCLUDE,
    })
    // Null is a valid response — a user may not have a party yet (the
    // backfill only ran for users with a TravelProfile). Client decides
    // whether to prompt "Create your travel party" or just hide the section.
    res.json(party)
  } catch (err) { next(err) }
}

export async function createParty(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body: PartyCreateInput = req.body
    const userId = req.user!.id

    // Auto-default: first party becomes the default unless the client
    // explicitly sent isDefault. Matches the createRig pattern.
    const count = await prisma.travelParty.count({ where: { userId } })
    const isDefault = body.isDefault ?? (count === 0)

    // If the client is creating a non-first party AND explicitly setting
    // isDefault: true, we must demote the existing default first to satisfy
    // the @@unique([userId, isDefault]) constraint. Same tx pattern as
    // updateParty below — extracted into a helper would be marginal.
    const party = await prisma.$transaction(async (tx) => {
      if (isDefault && count > 0) {
        await tx.travelParty.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        })
      }
      return tx.travelParty.create({
        data: {
          userId,
          isDefault,
          notes: body.notes ?? null,
        },
        include: PARTY_INCLUDE,
      })
    })

    res.status(201).json(party)
  } catch (err) { next(err) }
}

export async function updateParty(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body: PartyUpdateInput = req.body
    const userId = req.user!.id
    const partyId = req.params.partyId

    const existing = await prisma.travelParty.findFirst({
      where: { id: partyId, userId },
    })
    if (!existing) throw new AppError('Party not found', 404)

    // Default-toggle is special: @@unique([userId, isDefault]) means at most
    // ONE row per user can have isDefault=true. If the client is promoting
    // this party to default, we must demote the current default in the
    // SAME transaction. If they're demoting this party (already default →
    // false) we just write the update — no second row needs to change.
    //
    // No "set default" toggle in the v1 UI; this code path is reserved for
    // future multi-party flows. Kept correct now so the API doesn't grow
    // a footgun later.
    const promoting = body.isDefault === true && existing.isDefault === false

    const updated = await prisma.$transaction(async (tx) => {
      if (promoting) {
        await tx.travelParty.updateMany({
          where: { userId, isDefault: true, NOT: { id: partyId } },
          data: { isDefault: false },
        })
      }
      return tx.travelParty.update({
        where: { id: partyId },
        data: body,
        include: PARTY_INCLUDE,
      })
    })

    res.json(updated)
  } catch (err) { next(err) }
}

export async function deleteParty(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id
    const partyId = req.params.partyId

    const party = await prisma.travelParty.findFirst({
      where: { id: partyId, userId },
    })
    if (!party) throw new AppError('Party not found', 404)

    // Default party is the AI's primary data source for traveler context —
    // deleting it silently would degrade trip planning. Force the user to
    // promote another party first.
    if (party.isDefault) {
      throw new AppError(
        'Cannot delete the default travel party. Set another party as default first.',
        400,
      )
    }

    // Cascade to people + pets via Prisma onDelete: Cascade (see schema).
    await prisma.travelParty.delete({ where: { id: partyId } })
    res.json({ message: 'Party deleted' })
  } catch (err) { next(err) }
}

// ─── Person CRUD ──────────────────────────────────────────────────────────

/** Verifies the party exists AND belongs to req.user. Throws 404 otherwise.
 *  Used by every Person/Pet handler to assert the ownership chain before
 *  touching child rows. */
async function assertPartyOwned(userId: string, partyId: string) {
  const party = await prisma.travelParty.findFirst({
    where: { id: partyId, userId },
    select: { id: true },
  })
  if (!party) throw new AppError('Party not found', 404)
}

export async function createPerson(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const partyId = req.params.partyId
    await assertPartyOwned(req.user!.id, partyId)

    const body: PersonCreateInput = req.body
    const person = await prisma.person.create({
      data: {
        partyId,
        // Spread the validated body — every key is already either a real
        // schema field or absent (.strict() rejected unknowns at validate).
        ...(body as any),
      },
    })
    res.status(201).json(person)
  } catch (err) { next(err) }
}

export async function updatePerson(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id
    const partyId = req.params.partyId
    const personId = req.params.id
    await assertPartyOwned(userId, partyId)

    const existing = await prisma.person.findFirst({
      where: { id: personId, partyId },
      select: { id: true },
    })
    if (!existing) throw new AppError('Person not found', 404)

    const body: PersonUpdateInput = req.body
    const person = await prisma.person.update({
      where: { id: personId },
      data: body as any,
    })
    res.json(person)
  } catch (err) { next(err) }
}

export async function deletePerson(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id
    const partyId = req.params.partyId
    const personId = req.params.id
    await assertPartyOwned(userId, partyId)

    const existing = await prisma.person.findFirst({
      where: { id: personId, partyId },
      select: { id: true },
    })
    if (!existing) throw new AppError('Person not found', 404)

    await prisma.person.delete({ where: { id: personId } })
    res.json({ message: 'Person deleted' })
  } catch (err) { next(err) }
}

// ─── Pet CRUD ─────────────────────────────────────────────────────────────

export async function createPet(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const partyId = req.params.partyId
    await assertPartyOwned(req.user!.id, partyId)

    const body: PetCreateInput = req.body
    const pet = await prisma.pet.create({
      data: {
        partyId,
        ...(body as any),
      },
    })
    res.status(201).json(pet)
  } catch (err) { next(err) }
}

export async function updatePet(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id
    const partyId = req.params.partyId
    const petId = req.params.id
    await assertPartyOwned(userId, partyId)

    const existing = await prisma.pet.findFirst({
      where: { id: petId, partyId },
      select: { id: true },
    })
    if (!existing) throw new AppError('Pet not found', 404)

    const body: PetUpdateInput = req.body
    const pet = await prisma.pet.update({
      where: { id: petId },
      data: body as any,
    })
    res.json(pet)
  } catch (err) { next(err) }
}

export async function deletePet(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id
    const partyId = req.params.partyId
    const petId = req.params.id
    await assertPartyOwned(userId, partyId)

    const existing = await prisma.pet.findFirst({
      where: { id: petId, partyId },
      select: { id: true },
    })
    if (!existing) throw new AppError('Pet not found', 404)

    await prisma.pet.delete({ where: { id: petId } })
    res.json({ message: 'Pet deleted' })
  } catch (err) { next(err) }
}
