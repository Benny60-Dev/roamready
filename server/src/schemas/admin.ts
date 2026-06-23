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

// Body for POST /admin/users/:id/grant-pro. A non-empty reason is required.
// customExpiresAt is required ONLY for durationKind CUSTOM, and must be a future
// ISO datetime. .strict() rejects unknown keys.
export const AdminGrantProSchema = z
  .object({
    durationKind: z.enum(['MONTH', 'YEAR', 'LIFETIME', 'CUSTOM']),
    customExpiresAt: z.string().datetime().optional(),
    reason: z.string().trim().min(1, 'A reason is required').max(1000),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.durationKind === 'CUSTOM') {
      if (!data.customExpiresAt) {
        ctx.addIssue({ code: 'custom', path: ['customExpiresAt'], message: 'customExpiresAt is required for a CUSTOM grant' })
        return
      }
      if (new Date(data.customExpiresAt).getTime() <= Date.now()) {
        ctx.addIssue({ code: 'custom', path: ['customExpiresAt'], message: 'customExpiresAt must be in the future' })
      }
    }
  })

export type AdminGrantProInput = z.infer<typeof AdminGrantProSchema>
