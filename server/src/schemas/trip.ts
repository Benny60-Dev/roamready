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
 *   - estimatedCamp — set at trip creation from the AI's planning itinerary;
 *     no live caller updates it. Closed off until a real use case appears.
 *   - estimatedFuel — set at trip creation AND refreshed on every itinerary /
 *     map-page load by the getTripFuelEstimate controller (see
 *     controllers/trips.ts) as a server-side fire-and-forget side effect.
 *     The write goes through Prisma directly, NOT through this client PUT
 *     path, so the field stays closed at the schema layer while the
 *     server's fuel-estimate endpoint owns the refresh.
 *   - startDate, endDate, totalNights — date and duration totals are owned
 *     exclusively by the server cascade. Trip.startDate / endDate /
 *     totalNights are written transactionally by recomputeStopDates
 *     (controllers/trips.ts:90) as a side-effect of every createStop /
 *     updateStop / deleteStop, and also by shiftTripDates when the user
 *     moves the whole trip in time. Letting a client PUT these directly
 *     would desync Trip from its Stops (Trip says one thing, Stop.arrival
 *     / departureDate say another), which is the exact footgun closed
 *     here. To change dates, use the stop-mutation endpoints or
 *     POST /trips/:id/shift-dates — never PUT them on the trip itself.
 *   - id, createdAt, updatedAt — never client-writable.
 */
export const TripUpdateSchema = z
  .object({
    rigId: z.string().nullable().optional(),
    name: z.string().min(1).max(200).optional(),
    status: z.enum(['PLANNING', 'ACTIVE', 'COMPLETED', 'DRAFT']).optional(),
    startLocation: z.string().min(1).max(500).optional(),
    endLocation: z.string().min(1).max(500).optional(),
    totalMiles: z.number().min(0).nullable().optional(),
    actualFuel: z.number().min(0).nullable().optional(),
    actualCamp: z.number().min(0).nullable().optional(),
    fuelPrice: z.number().min(0).nullable().optional(),
    // Block 8 — per-trip vehicle decisions, editable post-promote so users can
    // change their mind about whether to bring the toad after the trip is
    // created. See PlanningSessionPromoteSchema for the field semantics; the
    // same shape applies here.
    bringingTowed: z.boolean().nullable().optional(),
    adHocVehicle: z.record(z.string(), z.unknown()).nullable().optional(),
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
    // AI-MESA-10 — apply-stamp plumbing; see StopUpdateSchema.modifyActionId.
    modifyActionId: z.string().max(100).optional(),
  })
  .strict()

export type TripShiftDatesInput = z.infer<typeof TripShiftDatesSchema>

/**
 * Packing-list save (PUT /trips/:id/packing-list). TripUpdateSchema
 * deliberately excludes packingList from the generic update (anti-tamper);
 * this dedicated schema is the ONE sanctioned client write path — it
 * validates the full category/item shape with caps, so checked-state and
 * item curation (remove) persist without opening the generic endpoint.
 * Fields are plain required booleans/strings plus one plain optional boolean
 * (`custom`) — no preprocessed optionals, so the Zod v4 outer/inner placement
 * gotcha doesn't apply here.
 */
// The category/item shape shared by Trip.packingList AND PackingTemplate.items.
// Extracted so the saved-template endpoints (FR-SAVED-PACKING) validate the
// EXACT same structure as a trip's packing list — keeping mergePackedState fed
// consistent data whether items come from a trip, a regenerate, or a template.
export const PackingCategoriesSchema = z
  .array(
    z
      .object({
        category: z.string().min(1).max(100),
        items: z
          .array(
            z
              .object({
                name: z.string().min(1).max(200),
                required: z.boolean(),
                checked: z.boolean(),
                // User-added items flag themselves so a Regenerate preserves
                // them. Plain optional boolean (no preprocess — the Zod v4
                // outer/inner gotcha in the docstring doesn't apply).
                custom: z.boolean().optional(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
  )
  .max(30)

export const TripPackingListSchema = z
  .object({ packingList: PackingCategoriesSchema })
  .strict()

export type TripPackingListInput = z.infer<typeof TripPackingListSchema>

/**
 * Create a saved packing template (POST /packing-templates) — FR-SAVED-PACKING.
 * Body { name, items } where items is the same category/item shape as a trip's
 * packing list. `checked` is accepted but normalized to false server-side at
 * store time (a template is a starting point, not a packed state).
 */
export const PackingTemplateCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    items: PackingCategoriesSchema,
  })
  .strict()

export type PackingTemplateCreateInput = z.infer<typeof PackingTemplateCreateSchema>

/** Seed a trip's packing list from a saved template
 *  (POST /trips/:id/packing-list/from-template). */
export const SeedFromTemplateSchema = z
  .object({ templateId: z.string().min(1) })
  .strict()

export type SeedFromTemplateInput = z.infer<typeof SeedFromTemplateSchema>

/** Copy (merge) another trip's packing list into this one
 *  (POST /trips/:id/packing-list/copy-from). */
export const CopyPackingFromTripSchema = z
  .object({ sourceTripId: z.string().min(1) })
  .strict()

export type CopyPackingFromTripInput = z.infer<typeof CopyPackingFromTripSchema>
