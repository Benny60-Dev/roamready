import { z } from 'zod'

/**
 * MaintenanceItem update payload — request body for PUT /api/v1/maintenance/:rigId/:itemId.
 *
 * Fields here are exhaustively listed and all .optional() so partial updates
 * work; .strict() at the root rejects unknown keys outright (rather than
 * silently stripping) so a typo or malicious payload surfaces as a 400.
 *
 * OMITTED server-managed fields (will be rejected if the client sends them):
 *   - id, createdAt, updatedAt — never client-writable.
 *   - rigId — PRIMARY RISK. Would let a user re-parent the maintenance item
 *     onto another rig (potentially another user's rig). The URL :rigId is
 *     verified via verifyRigOwnership in the controller; a body-level rigId
 *     would silently overwrite that verified value at write time.
 *   - status — server-computed by computeStatus(item, rig.currentMiles) on
 *     every read, and reset to 'OK' inside logService. Allowing client writes
 *     would let a user fake an OVERDUE state (poison dashboards) or hide a
 *     real OVERDUE state (silence reminders).
 *   - currentMiles — not consumed by any read path (status is computed from
 *     rig.currentMiles, the rig-level odometer, in getItems). Omitting now
 *     prevents stale mirrored data from accidentally becoming load-bearing
 *     later.
 */
export const MaintenanceItemUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    intervalMiles: z.number().int().min(0).nullable().optional(),
    intervalMonths: z.number().int().min(0).nullable().optional(),
    lastServiceMiles: z.number().int().min(0).nullable().optional(),
    lastServiceDate: z.coerce.date().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  })
  .strict()

export type MaintenanceItemUpdateInput = z.infer<typeof MaintenanceItemUpdateSchema>

/**
 * MaintenanceItem create payload — request body for POST /api/v1/maintenance/:rigId.
 *
 * Same allowlisted fields as MaintenanceItemUpdateSchema, but `name` is
 * REQUIRED at creation time (the Prisma column is non-nullable; we won't
 * insert a row without a label). All other fields stay optional so users
 * can add an item with just a name and fill the rest in via the edit screen.
 *
 * OMITTED server-managed fields (will be rejected if the client sends them
 * thanks to .strict()):
 *   - id, createdAt, updatedAt — never client-writable.
 *   - rigId — set from req.params.rigId in the controller after
 *     verifyRigOwnership confirms the caller owns the rig. Allowing a
 *     body-level rigId would let a client create an item on a rig they
 *     don't own (the controller's spread would overwrite the URL value).
 *   - status — server-computed (defaults to 'OK' at the DB layer, then
 *     re-derived on every read by computeStatus). See update schema for the
 *     spoofing-risk rationale.
 *   - currentMiles — not consumed by any read path; omitted to prevent
 *     stale mirrored data from accidentally becoming load-bearing later.
 */
export const MaintenanceItemCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    intervalMiles: z.number().int().min(0).nullable().optional(),
    intervalMonths: z.number().int().min(0).nullable().optional(),
    lastServiceMiles: z.number().int().min(0).nullable().optional(),
    lastServiceDate: z.coerce.date().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  })
  .strict()

export type MaintenanceItemCreateInput = z.infer<typeof MaintenanceItemCreateSchema>
