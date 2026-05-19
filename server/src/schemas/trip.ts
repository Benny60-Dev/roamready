import { z } from 'zod'

/**
 * Trip update payload — request body for PUT /api/v1/trips/:id.
 *
 * Fields here are exhaustively listed and all .optional() so partial updates
 * work; .strict() at the root rejects unknown keys outright (rather than
 * silently stripping) so a typo or malicious payload surfaces as a 400.
 *
 * OMITTED server-managed / dedicated-endpoint fields (will be rejected if the
 * client sends them):
 *   - userId — PRIMARY RISK. Mass-assigning userId would re-parent the trip
 *     onto another user's account, dragging the entire stops / journal /
 *     itinerary subtree with it via the cascading relations on Trip → Stop.
 *   - sharedToken — @unique on the Prisma model. A malicious client could
 *     attempt to set it to another user's existing share token; the unique
 *     constraint would reject the write, but blocking it at the schema layer
 *     prevents probing for token existence and keeps all share-token issuance
 *     funneled through the dedicated share endpoint.
 *   - packingList — server-generated only (POST /trips/:id/packing-list).
 *     Letting the client overwrite it would allow tampering with packing data
 *     and bypasses the AI generation pipeline.
 *   - aiConversation, modifyConversation — written exclusively by the AI chat
 *     controller (server/src/controllers/ai.ts). Not client-writable here.
 *   - itinerary — owned by the dedicated PUT /trips/:id/itinerary route
 *     (saveItinerary controller). Not client-writable here.
 *   - estimatedFuel, estimatedCamp — set at trip creation; no live caller
 *     updates them. Closed off until a real use case appears.
 *   - id, createdAt, updatedAt — never client-writable.
 */
export const TripUpdateSchema = z
  .object({
    rigId: z.string().nullable().optional(),
    name: z.string().min(1).max(200).optional(),
    status: z.enum(['PLANNING', 'ACTIVE', 'COMPLETED', 'DRAFT']).optional(),
    startLocation: z.string().min(1).max(500).optional(),
    endLocation: z.string().min(1).max(500).optional(),
    startDate: z.coerce.date().nullable().optional(),
    endDate: z.coerce.date().nullable().optional(),
    totalMiles: z.number().min(0).nullable().optional(),
    totalNights: z.number().int().min(0).nullable().optional(),
    actualFuel: z.number().min(0).nullable().optional(),
    actualCamp: z.number().min(0).nullable().optional(),
    fuelPrice: z.number().min(0).nullable().optional(),
  })
  .strict()

export type TripUpdateInput = z.infer<typeof TripUpdateSchema>

/**
 * Trip-date shift payload — request body for POST /api/v1/trips/:id/shift-dates.
 *
 * Used by the Modify-with-AI flow's shift_trip_dates action to move an entire
 * trip forward or backward in time. The server computes the delta between the
 * trip's current startDate and newStartDate, then applies that delta to:
 *   - Trip.startDate, Trip.endDate
 *   - Every Stop's arrivalDate and departureDate (where non-null)
 * Trip duration and per-stop nights are preserved.
 *
 * No past-date guard at the schema layer — backdating is a legitimate use
 * case for COMPLETED trips (record-keeping after the fact). The AI is
 * instructed in the modify-mode prompt to avoid past dates unless the user
 * explicitly asks for one.
 *
 * `z.coerce.date()` accepts both Date instances and ISO strings ("2026-08-09")
 * — the Modify panel sends a YYYY-MM-DD string per the prompt spec.
 */
export const TripShiftDatesSchema = z
  .object({
    newStartDate: z.coerce.date(),
  })
  .strict()

export type TripShiftDatesInput = z.infer<typeof TripShiftDatesSchema>
