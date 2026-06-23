import { z } from 'zod'

// Body for POST /admin/users/:id/suspend. A non-empty reason is REQUIRED — the
// audit trail is only useful if every suspension records WHY. .strict() rejects
// unknown keys (mass-assignment guard); .trim() + min(1) blocks whitespace-only.
export const AdminSuspendSchema = z
  .object({
    reason: z.string().trim().min(1, 'A reason is required').max(1000),
  })
  .strict()

export type AdminSuspendInput = z.infer<typeof AdminSuspendSchema>
