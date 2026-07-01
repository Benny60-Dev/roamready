import { z } from 'zod'

// The FIXED menu of canned read-only diagnostics. The client sends a query KEY
// from this enum — never SQL. There is no free-text SQL path anywhere; unknown
// keys are rejected by the enum and .strict() rejects any extra field.
export const DIAGNOSTIC_QUERIES = [
  'trip_by_id',
  'user_overview',
  'orphan_check',
  'dangling_sessions',
  'user_party',
] as const

export type DiagnosticQuery = (typeof DIAGNOSTIC_QUERIES)[number]

// Validates the GET query string. Param keys are accepted loosely (each query
// enforces which it actually needs in the controller); .strict() still rejects
// any UNKNOWN key so the surface stays exactly { query, tripId?, userId?, email? }.
export const DiagnosticQuerySchema = z
  .object({
    query: z.enum(DIAGNOSTIC_QUERIES),
    tripId: z.string().max(64).optional(),
    userId: z.string().max(64).optional(),
    email: z.string().max(320).optional(),
  })
  .strict()

export type DiagnosticInput = z.infer<typeof DiagnosticQuerySchema>
