import { z } from 'zod'

/**
 * Travel Party Phase B — Zod schemas.
 *
 * Models: TravelParty (the container), Person (people on a party),
 * Pet (pets on a party). See prisma/schema.prisma for the source of truth.
 *
 * Convention follows membership.ts / travelProfile.ts:
 *   - Every field optional on Update (partial updates supported)
 *   - Required-at-create fields explicit on Create
 *   - .strict() at the root rejects unknown keys with a 400 so typos and
 *     malicious payloads surface immediately rather than silently dropping
 *   - Server-managed fields are NEVER in these schemas — they're injected
 *     by the controller from req.user / req.params:
 *       TravelParty.userId   — injected from req.user!.id (POST /me/parties)
 *       TravelParty.tripId   — injected by trips.ts createTrip on clone
 *       Person.partyId       — injected from req.params.partyId
 *       Pet.partyId          — injected from req.params.partyId
 *       id / createdAt / updatedAt — never client-writable
 *
 * "Exactly one of userId / tripId set" invariant: enforced at the controller
 * layer (createParty injects userId; the trip-clone path injects tripId).
 * No client write path can set either, so no schema-level refine is needed.
 *
 * v1 UI scope vs. schema scope: the UI only exposes a subset of fields
 * (Person: name+role; Pet: type+name). All real schema fields remain in
 * Zod so API consumers (future import flows, AI write-backs) can populate
 * them. Dormant fields are documented inline.
 */

// ─── TravelParty ──────────────────────────────────────────────────────────

export const PartyCreateSchema = z
  .object({
    // Default-party uniqueness is enforced at the DB level by
    // @@unique([userId, isDefault]). Toggling default after create
    // goes through updateParty's tx, which demotes the current default
    // first. On create we accept the flag but the controller will
    // typically auto-set this when the user has no party yet.
    isDefault: z.boolean().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()

export const PartyUpdateSchema = z
  .object({
    isDefault: z.boolean().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()

export type PartyCreateInput = z.infer<typeof PartyCreateSchema>
export type PartyUpdateInput = z.infer<typeof PartyUpdateSchema>

// ─── Person ───────────────────────────────────────────────────────────────

// Hardcoded enum values mirror prisma/schema.prisma:PersonRole. If you add
// a value there, mirror it here or writes will start 400'ing.
const PersonRoleEnum = z.enum(['ADULT', 'TEEN', 'CHILD', 'INFANT'])

// v1 UI surfaces: name + role only.
// Dormant fields below stay in Zod so the API can accept them — the AI
// system prompt already reads them, and future import flows / a v2 form
// will write them. Keep tightening in lockstep with the UI.
export const PersonCreateSchema = z
  .object({
    role: PersonRoleEnum.optional(),
    name: z.string().max(100).nullable().optional(),

    // Dormant in v1 UI — writable via API.
    age: z.number().int().min(0).max(120).nullable().optional(),
    isTraveling: z.boolean().optional(),
    isEmergencyContact: z.boolean().optional(),
    // isSelf marks the user's OWN person within their default party — the row
    // the AI planner reads for the account-holder's accessibility needs. It is
    // accepted on CREATE (not update) so the find-or-create-self path in
    // AccessibilityPage can stamp a freshly created self person; it is set
    // exactly once, when no isSelf person exists yet. Deliberately absent from
    // PersonUpdateSchema: there's no DB uniqueness guard on isSelf, so exposing
    // it on the generic person editor would let a save silently create a second
    // "self" and split the planner's source of truth. The original backfill
    // (backfillIsSelf.ts) is the only other writer.
    isSelf: z.boolean().optional(),
    emergencyPhone: z.string().max(50).nullable().optional(),
    // accessibilityNeeds is a JSON object of boolean flags +
    // optional `notes` (see AccessibilityPage.tsx). z.unknown() matches
    // the shape used by TravelProfileUpsertSchema for the same field.
    accessibilityNeeds: z.unknown().nullable().optional(),
    dietaryNotes: z.string().max(500).nullable().optional(),
    militaryStatus: z.string().max(50).nullable().optional(),
    firstResponder: z.string().max(50).nullable().optional(),
  })
  .strict()

export const PersonUpdateSchema = z
  .object({
    role: PersonRoleEnum.optional(),
    name: z.string().max(100).nullable().optional(),
    age: z.number().int().min(0).max(120).nullable().optional(),
    isTraveling: z.boolean().optional(),
    isEmergencyContact: z.boolean().optional(),
    emergencyPhone: z.string().max(50).nullable().optional(),
    accessibilityNeeds: z.unknown().nullable().optional(),
    dietaryNotes: z.string().max(500).nullable().optional(),
    militaryStatus: z.string().max(50).nullable().optional(),
    firstResponder: z.string().max(50).nullable().optional(),
  })
  .strict()

export type PersonCreateInput = z.infer<typeof PersonCreateSchema>
export type PersonUpdateInput = z.infer<typeof PersonUpdateSchema>

// ─── Pet ──────────────────────────────────────────────────────────────────

// Mirrors prisma/schema.prisma:PetType. Required at create — Pet.type has
// no @default on the Prisma model.
const PetTypeEnum = z.enum(['DOG', 'CAT', 'OTHER'])

// v1 UI surfaces: type + name only.
// Dormant fields below (weightLbs, leashTrained, comfortable*, breed, notes)
// stay writable via API so the AI's existing pet-aware logic has somewhere
// to source data from once we expose a fuller form in v2.
export const PetCreateSchema = z
  .object({
    type: PetTypeEnum,
    name: z.string().max(100).nullable().optional(),

    // Dormant in v1 UI — writable via API.
    breed: z.string().max(100).nullable().optional(),
    weightLbs: z.number().int().min(0).max(500).nullable().optional(),
    leashTrained: z.boolean().optional(),
    comfortableInCrowds: z.boolean().optional(),
    comfortableAtNight: z.boolean().optional(),
    notes: z.string().max(1000).nullable().optional(),
  })
  .strict()

export const PetUpdateSchema = z
  .object({
    type: PetTypeEnum.optional(),
    name: z.string().max(100).nullable().optional(),
    breed: z.string().max(100).nullable().optional(),
    weightLbs: z.number().int().min(0).max(500).nullable().optional(),
    leashTrained: z.boolean().optional(),
    comfortableInCrowds: z.boolean().optional(),
    comfortableAtNight: z.boolean().optional(),
    notes: z.string().max(1000).nullable().optional(),
  })
  .strict()

export type PetCreateInput = z.infer<typeof PetCreateSchema>
export type PetUpdateInput = z.infer<typeof PetUpdateSchema>
