import { z } from 'zod'

/**
 * Stop update payload — the request body for PUT /api/bookings/:id
 * (and reusable by future stop-update endpoints).
 *
 * Fields here are exhaustively listed and all .optional() so partial updates
 * work; .strict() at the root rejects unknown keys outright (rather than
 * silently stripping) so a typo or malicious payload surfaces as a 400.
 *
 * OMITTED server-managed fields (will be rejected if the client sends them):
 *   - id, createdAt, updatedAt — never client-writable
 *   - tripId — would let a user re-parent the stop into another trip
 *
 * `type` is allowlisted to DESTINATION | OVERNIGHT_ONLY only — the EditStopModal
 * lets users toggle between those two. HOME is intentionally excluded: it's the
 * trip's home anchor and any HOME conversions should go through a dedicated
 * narrower route, not this general-purpose update endpoint.
 */
export const StopUpdateSchema = z
  .object({
    type: z.enum(['DESTINATION', 'OVERNIGHT_ONLY']).optional(),
    locationName: z.string().min(1).max(200).optional(),
    locationState: z.string().max(50).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    arrivalDate: z.coerce.date().nullable().optional(),
    departureDate: z.coerce.date().nullable().optional(),
    nights: z.number().int().min(0).optional(),
    campgroundName: z.string().max(200).nullable().optional(),
    campgroundId: z.string().nullable().optional(),
    bookingStatus: z
      .enum(['NOT_BOOKED', 'PENDING', 'CONFIRMED', 'CANCELLED', 'WAITLISTED'])
      .optional(),
    confirmationNum: z.string().max(100).nullable().optional(),
    siteRate: z.number().min(0).nullable().optional(),
    estimatedFuel: z.number().min(0).nullable().optional(),
    checkInTime: z.string().max(20).nullable().optional(),
    checkOutTime: z.string().max(20).nullable().optional(),
    siteNumber: z.string().max(50).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    hookupType: z.string().max(50).nullable().optional(),
    isPetFriendly: z.boolean().nullable().optional(),
    isMilitaryOnly: z.boolean().optional(),
    isCompatible: z.boolean().optional(),
    incompatibilityReasons: z.any().optional(),
    alternates: z.any().optional(),
    weatherForecast: z.any().optional(),
    highwayRoute: z.string().nullable().optional(),
    driveDuration: z.string().nullable().optional(),
    driveDistanceMiles: z.number().min(0).nullable().optional(),
    routeHighlights: z.string().nullable().optional(),
    pointsOfInterest: z.array(z.any()).optional(),
    order: z.number().int().min(0).optional(),
  })
  .strict()

export type StopUpdateInput = z.infer<typeof StopUpdateSchema>
