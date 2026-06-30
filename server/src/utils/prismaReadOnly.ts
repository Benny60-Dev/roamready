import { PrismaClient } from '@prisma/client'

// Dedicated READ-ONLY Prisma client for the admin Diagnostics console.
//
// Points at DIAGNOSTICS_DATABASE_URL — a connection string for a SELECT-only
// Postgres ROLE, kept entirely separate from the app's main (writable)
// DATABASE_URL. Same generated client, only the connection URL differs, so
// even a buggy query physically cannot write (the role has no write grants).
//
// FAIL-CLOSED by design: if DIAGNOSTICS_DATABASE_URL is unset we export `null`
// and the diagnostics endpoints return 503. We NEVER fall back to the main
// writable client — that would defeat the read-only guarantee.
//
// Cached on globalThis (like utils/prisma.ts) so tsx-watch restarts in dev
// don't leak a new connection each reload. `null` is a valid cached value
// (env unset), so we distinguish "not yet created" via `undefined`.

declare global {
  // eslint-disable-next-line no-var
  var __prismaReadOnly: PrismaClient | null | undefined
}

function create(): PrismaClient | null {
  const url = process.env.DIAGNOSTICS_DATABASE_URL
  if (!url) return null
  return new PrismaClient({ datasourceUrl: url })
}

export const prismaReadOnly: PrismaClient | null =
  global.__prismaReadOnly !== undefined ? global.__prismaReadOnly : create()

if (process.env.NODE_ENV !== 'production') {
  global.__prismaReadOnly = prismaReadOnly
}
