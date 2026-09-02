import { prisma } from '../utils/prisma'

// FEAT-PET-CAPTURE — persist a pet the user mentions in planning/modify chat.
//
// The packing-list and planning prompts are already pet-aware (they serialise
// party.pets), but nothing ever CREATED a Pet from what the user said, so
// "we're bringing Callie, our golden" produced a dog-free packing list. The
// model emits <pet>TYPE|Name|Breed</pet> when the user states their OWN pet
// is coming; this writes it to the user's default party (creating the party
// if needed) and, when a trip already has its own party, to that party too —
// skipping any party that already has a pet with the same name.

export type PetType = 'DOG' | 'CAT' | 'OTHER'

export interface CapturedPet {
  type: PetType
  name: string | null
  breed: string | null
}

const PET_TYPES: readonly PetType[] = ['DOG', 'CAT', 'OTHER']

/** Parse one tag body "DOG|Callie|Golden Retriever" (breed optional). */
export function parsePetTag(raw: string): CapturedPet | null {
  const parts = raw.split('|').map(s => s.trim())
  const type = (parts[0] ?? '').toUpperCase() as PetType
  if (!PET_TYPES.includes(type)) return null
  const name = parts[1] ? parts[1].slice(0, 100) : null
  const breed = parts[2] ? parts[2].slice(0, 100) : null
  return { type, name, breed }
}

function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

async function addPetToParty(partyId: string, pet: CapturedPet): Promise<boolean> {
  const existing = await prisma.pet.findMany({ where: { partyId }, select: { name: true, type: true } })
  // Same name → already there. A nameless pet only dedups against another
  // nameless pet of the same type (so "a dog" isn't re-added every turn).
  const dup = existing.some(p =>
    pet.name ? sameName(p.name, pet.name) : (!p.name && p.type === pet.type),
  )
  if (dup) return false
  await prisma.pet.create({
    data: { partyId, type: pet.type, name: pet.name, breed: pet.breed },
  })
  return true
}

/**
 * Persist captured pets. Returns the number of Pet rows created across the
 * default party and (if present) the trip's own party. Never throws — a
 * capture failure must not break the chat reply.
 */
export async function persistCapturedPets(
  userId: string,
  tripId: string | null,
  pets: CapturedPet[],
): Promise<number> {
  let created = 0
  try {
    if (!pets.length) return 0
    // Default party — create it if the user has none yet.
    let party = await prisma.travelParty.findFirst({ where: { userId, isDefault: true }, select: { id: true } })
    if (!party) {
      party = await prisma.travelParty.create({ data: { userId, isDefault: true }, select: { id: true } })
    }
    for (const pet of pets) if (await addPetToParty(party.id, pet)) created++

    // Trip party — only when the trip already has one (createTrip clones the
    // default party onto the trip, so a trip planned BEFORE the pet was
    // mentioned would otherwise never see it).
    if (tripId) {
      const tripParty = await prisma.travelParty.findFirst({ where: { tripId }, select: { id: true } })
      if (tripParty) {
        for (const pet of pets) if (await addPetToParty(tripParty.id, pet)) created++
      }
    }
  } catch (e: any) {
    console.error('[pet-capture] persist failed userId=%s tripId=%s: %s', userId, tripId ?? '(none)', e?.message)
  }
  return created
}
