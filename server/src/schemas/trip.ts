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
