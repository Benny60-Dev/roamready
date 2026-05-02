import { z } from 'zod'

/**
 * PlanningSession schemas — request bodies for /api/v1/sessions.
 *
 * All three are .strict() so unknown keys surface as 400 instead of being
 * silently stripped — same posture as TripUpdateSchema / MembershipUpdateSchema.
 */

/**
 * Create payload — POST /api/v1/sessions.
 * Only `title` is client-settable at create time. Everything else
 * (id, userId, messages, partialTripData, tripId, status, timestamps)
 * is server-managed.
 */
export const PlanningSessionCreateSchema = z
  .object({
    title: z.string().min(1).max(200).nullable().optional(),
  })
  .strict()

/**
 * Update payload — PUT /api/v1/sessions/:id.
 *
 * OMITTED server-managed fields (rejected if sent):
 *   - id, userId, createdAt, updatedAt — never client-writable.
 *   - tripId — set exclusively by the promote endpoint inside a transaction.
 *     Allowing the client to set it would let a user link their session to
 *     someone else's trip (or break the @unique invariant on the column).
 *
 * `status` is allowlisted so users can ARCHIVE their own sessions, but
 * promotion to a real trip happens via POST /:id/promote, not by setting
 * status to COMPLETED here.
 */
export const PlanningSessionUpdateSchema = z
  .object({
    title: z.string().min(1).max(200).nullable().optional(),
    messages: z.array(z.any()).optional(),
    partialTripData: z.any().optional(),
    status: z.enum(['PLANNING', 'COMPLETED', 'ARCHIVED']).optional(),
  })
  .strict()

/**
 * Promote payload — POST /api/v1/sessions/:id/promote.
 *
 * Mirrors the client-settable allowlist for trip creation: only fields a user
 * legitimately sets when finalising a plan into a real Trip. Server-managed
 * trip fields (userId, sharedToken, packingList, aiConversation, modify-
 * Conversation, itinerary) are intentionally omitted — those flow through
 * dedicated endpoints, never through promote.
 *
 * `name`, `startLocation`, `endLocation` are required because Prisma demands
 * them when creating a Trip row; everything else is optional and may be left
 * null/undefined for a partial promote.
 */
export const PlanningSessionPromoteSchema = z
  .object({
    rigId: z.string().nullable().optional(),
    name: z.string().min(1).max(200),
    startLocation: z.string().min(1).max(500),
    endLocation: z.string().min(1).max(500),
    startDate: z.coerce.date().nullable().optional(),
    endDate: z.coerce.date().nullable().optional(),
    totalMiles: z.number().min(0).nullable().optional(),
    totalNights: z.number().int().min(0).nullable().optional(),
    estimatedFuel: z.number().min(0).nullable().optional(),
    estimatedCamp: z.number().min(0).nullable().optional(),
    fuelPrice: z.number().min(0).nullable().optional(),
  })
  .strict()

export type PlanningSessionCreateInput = z.infer<typeof PlanningSessionCreateSchema>
export type PlanningSessionUpdateInput = z.infer<typeof PlanningSessionUpdateSchema>
export type PlanningSessionPromoteInput = z.infer<typeof PlanningSessionPromoteSchema>
