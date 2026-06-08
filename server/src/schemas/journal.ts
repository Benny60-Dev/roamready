import { z } from 'zod'

/**
 * JournalEntry — freeform travel-diary Zod schemas (Tier-1 hardened).
 *
 * Convention follows travelParty.ts / maintenance.ts:
 *   - Separate Create vs Update (Update is fully partial)
 *   - .strict() at the root rejects unknown keys with a 400
 *   - Server-managed fields are NEVER here — the controller injects them:
 *       userId               — injected from req.user!.id
 *       id / createdAt / updatedAt — never client-writable
 *       photos               — managed by the S3 upload path, not generic CRUD
 *       state (auto-resolve) — when stopId is set and state is omitted, the
 *                              controller resolves it from Stop.locationState.
 *                              `state` stays writable here for standalone
 *                              entries (no stopId) and explicit overrides.
 *
 * tripId / stopId are accepted (optional links) but the controller verifies
 * they belong to req.user before persisting, so an entry can't be attached to
 * another user's trip/stop.
 */

// Shared field definitions so Create/Update stay in lockstep.
const title = z.string().max(200).nullable().optional()
const rating = z.number().int().min(1).max(5).nullable().optional()
const tags = z.array(z.string().max(50)).max(50).optional()
const entryDate = z.coerce.date().optional()
const tripId = z.string().nullable().optional()
const stopId = z.string().nullable().optional()
const placeName = z.string().max(200).nullable().optional()
const lat = z.number().min(-90).max(90).nullable().optional()
const lng = z.number().min(-180).max(180).nullable().optional()
const state = z.string().max(100).nullable().optional()

export const JournalCreateSchema = z
  .object({
    title,
    // body is the diary text — required on create (an entry with no body is
    // meaningless). Optional on update so partial edits don't force a resend.
    body: z.string().min(1).max(20000),
    rating,
    tags,
    entryDate,
    tripId,
    stopId,
    placeName,
    lat,
    lng,
    state,
  })
  .strict()

export const JournalUpdateSchema = z
  .object({
    title,
    body: z.string().min(1).max(20000).nullable().optional(),
    rating,
    tags,
    entryDate,
    tripId,
    stopId,
    placeName,
    lat,
    lng,
    state,
  })
  .strict()

export type JournalCreateInput = z.infer<typeof JournalCreateSchema>
export type JournalUpdateInput = z.infer<typeof JournalUpdateSchema>
