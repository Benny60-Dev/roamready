import { Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { AuthRequest } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { prismaReadOnly } from '../utils/prismaReadOnly'
import { DiagnosticQuerySchema, DiagnosticInput } from '../schemas/diagnostics'

// Admin Diagnostics — a FIXED registry of canned, PURE-SELECT queries run on a
// dedicated read-only Postgres role (prismaReadOnly). Four safety layers:
//   1. canned only      — the client picks a query KEY; there is no SQL input.
//   2. parameterized    — every value is a Prisma.sql bind param, never concat.
//   3. read-only role   — prismaReadOnly connects as a SELECT-only Postgres user.
//   4. fail-closed       — no read-only client configured → 503, never the main DB.
//
// Counts are cast ::int in SQL so $queryRaw returns numbers (not BigInt, which
// JSON.stringify can't serialize). messages length is guarded by jsonb_typeof
// in case a row ever holds a non-array.

// `prismaReadOnly!` is safe at every call site below: runDiagnostic guards on
// it and 503s before any helper runs.

// (a) Trip-by-ID — full state of one trip + owner + stop count.
function tripById(tripId: string) {
  return prismaReadOnly!.$queryRaw(Prisma.sql`
    SELECT t.id, t.name, t.status, t."userId",
           u.email AS owner_email, u."firstName" AS owner_first_name, u."lastName" AS owner_last_name,
           t."createdAt", t."updatedAt",
           (SELECT COUNT(*)::int FROM "Stop" s WHERE s."tripId" = t.id) AS stop_count
    FROM "Trip" t
    LEFT JOIN "User" u ON u.id = t."userId"
    WHERE t.id = ${tripId}
  `)
}

// (b) User-overview — resolve by userId OR email, then their trips + sessions.
async function userOverview(input: DiagnosticInput) {
  const userRows = await prismaReadOnly!.$queryRaw<any[]>(Prisma.sql`
    SELECT id, email, "firstName", "lastName", "createdAt"
    FROM "User"
    WHERE ${input.userId ? Prisma.sql`id = ${input.userId}` : Prisma.sql`email ILIKE ${input.email}`}
    LIMIT 1
  `)
  const user = userRows[0] ?? null
  if (!user) return { user: null, trips: [], sessions: [] }

  const trips = await prismaReadOnly!.$queryRaw(Prisma.sql`
    SELECT t.id, t.name, t.status, t."createdAt", t."updatedAt",
           (SELECT COUNT(*)::int FROM "Stop" s WHERE s."tripId" = t.id) AS stop_count
    FROM "Trip" t
    WHERE t."userId" = ${user.id}
    ORDER BY t."updatedAt" DESC
  `)
  const sessions = await prismaReadOnly!.$queryRaw(Prisma.sql`
    SELECT ps.id, ps.title, ps.status, ps."tripId", ps."createdAt", ps."updatedAt",
           CASE WHEN jsonb_typeof(ps.messages) = 'array' THEN jsonb_array_length(ps.messages) ELSE 0 END AS message_count
    FROM "PlanningSession" ps
    WHERE ps."userId" = ${user.id}
    ORDER BY ps."createdAt" DESC
  `)
  return { user, trips, sessions }
}

// (c) Orphan / empty-shell check — exists? owned by whom? zero stops?
async function orphanCheck(tripId: string) {
  const rows = await prismaReadOnly!.$queryRaw<any[]>(Prisma.sql`
    SELECT (t.id IS NOT NULL) AS exists,
           t."userId" AS owner_id, u.email AS owner_email,
           (SELECT COUNT(*)::int FROM "Stop" s WHERE s."tripId" = ${tripId}) AS stop_count
    FROM (SELECT ${tripId}::text AS id) p
    LEFT JOIN "Trip" t ON t.id = p.id
    LEFT JOIN "User" u ON u.id = t."userId"
  `)
  return rows[0] ?? null
}

// (d) Global dangling-session integrity scan — sessions whose tripId points to a
// missing Trip row. Should be EMPTY (PlanningSession.tripId is a FK with
// onDelete: SetNull), so any row here is a real integrity violation.
function danglingSessions() {
  return prismaReadOnly!.$queryRaw(Prisma.sql`
    SELECT ps.id AS session_id, ps."tripId", ps."userId", ps.status, ps."createdAt"
    FROM "PlanningSession" ps
    LEFT JOIN "Trip" t ON t.id = ps."tripId"
    WHERE ps."tripId" IS NOT NULL AND t.id IS NULL
    ORDER BY ps."createdAt" DESC
  `)
}

export async function runDiagnostic(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Layer 4 — fail closed. No read-only client => the feature is off; never
    // touch the main writable connection.
    if (!prismaReadOnly) {
      throw new AppError('Diagnostics is not configured (DIAGNOSTICS_DATABASE_URL is unset).', 503)
    }

    const parsed = DiagnosticQuerySchema.safeParse(req.query)
    if (!parsed.success) throw new AppError('Invalid diagnostics request', 400)
    const input = parsed.data

    // Audit trail — who ran which diagnostic (owner-gated route; only the key is logged).
    console.info('[admin-diagnostics] owner=%s query=%s', req.user!.email, input.query)

    let result: unknown
    switch (input.query) {
      case 'trip_by_id':
        if (!input.tripId) throw new AppError('tripId is required for this query', 400)
        result = await tripById(input.tripId)
        break
      case 'user_overview':
        if (!input.userId && !input.email) throw new AppError('userId or email is required for this query', 400)
        result = await userOverview(input)
        break
      case 'orphan_check':
        if (!input.tripId) throw new AppError('tripId is required for this query', 400)
        result = await orphanCheck(input.tripId)
        break
      case 'dangling_sessions':
        result = await danglingSessions()
        break
    }

    res.json({ query: input.query, result })
  } catch (err) {
    next(err)
  }
}
