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

// Body for POST /admin/users/:id/impersonate ("act as user"). An optional
// free-text reason is recorded on the AdminActionLog audit row. .strict()
// rejects unknown keys (mass-assignment guard).
export const AdminImpersonateSchema = z
  .object({
    reason: z.string().max(500).nullable().optional(),
  })
  .strict()

export type AdminImpersonateInput = z.infer<typeof AdminImpersonateSchema>

// ── FEAT-REPLAY-CASES ────────────────────────────────────────────────────────
// Body for POST /admin/replay-cases — the replay-file shape the Session
// Inspector builds, plus the admin's "what went wrong" note. turns must carry
// at least one user turn; everything else is passed through as JSON.
const ReplayTurnSchema = z.object({
  user: z.string().trim().min(1).max(4000),
  expect: z.record(z.string(), z.unknown()).optional(),
}).strict()

export const AdminReplayCaseCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only'),
    note: z.string().trim().min(1, 'Say what went wrong').max(2000),
    sourceSessionId: z.string().trim().max(64).optional(),
    sourceUserEmail: z.string().trim().max(254).optional(),
    setup: z.record(z.string(), z.unknown()).default({}),
    turns: z.array(ReplayTurnSchema).min(1, 'At least one user turn'),
    final: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export type AdminReplayCaseCreateInput = z.infer<typeof AdminReplayCaseCreateSchema>

// Body for PATCH /admin/replay-cases/:id — status / note edits from the admin
// page, and lastRun written by the replay script after a run.
export const AdminReplayCaseUpdateSchema = z
  .object({
    status: z.enum(['OPEN', 'PASSING', 'FIXED']).optional(),
    note: z.string().trim().min(1).max(2000).optional(),
    turns: z.array(ReplayTurnSchema).min(1).optional(),
    final: z.record(z.string(), z.unknown()).optional(),
    lastRun: z.object({
      passed: z.number().int().min(0),
      total: z.number().int().min(0),
      base: z.string().max(200).optional(),
      failed: z.array(z.string().max(300)).max(50).optional(),
    }).strict().optional(),
  })
  .strict()
  .refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' })

export type AdminReplayCaseUpdateInput = z.infer<typeof AdminReplayCaseUpdateSchema>
