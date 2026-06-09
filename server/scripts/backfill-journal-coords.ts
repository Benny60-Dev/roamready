/**
 * One-time backfill: populate JournalEntry.lat/lng/placeName from the linked
 * Stop, so the step-7b journal map pin layer has coordinates to render.
 *
 * Going forward the write paths (createEntry, upsertEntry in
 * controllers/journal.ts) fill these from the stop automatically; this script
 * fixes EXISTING rows created before that change.
 *
 * Scope (coord source = linked Stop ONLY, per the locked decision):
 *   - Targets entries that have a stopId AND are still missing coords
 *     (lat null OR lng null).
 *   - Sets lat = Stop.latitude, lng = Stop.longitude, and
 *     placeName = (entry.placeName ?? Stop.locationName) — never clobbering a
 *     placeName the entry already has.
 *   - Freeform entries (no stopId) are left untouched — no coords, no pin.
 *   - Entries whose Stop itself has no coordinates are skipped (nothing to copy).
 *
 * Idempotent: once a row has lat+lng it no longer matches the filter, so
 * re-running is a no-op (beyond re-scanning rows whose stop lacks coords).
 *
 * Run from the repo root with the root .env loaded:
 *   npx tsx --env-file=.env server/scripts/backfill-journal-coords.ts
 *
 * NEVER runs against a non-localhost DATABASE_URL (guard below).
 */
import { prisma } from '../src/utils/prisma'

// ── Localhost-only guard ────────────────────────────────────────────────────
// Refuse to touch anything unless DATABASE_URL clearly points at a local DB.
// Runs before any Prisma query (PrismaClient is lazy — no connection until the
// first query below). Same guard as seed-expired-user.ts.
const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  console.error(
    '✖ DATABASE_URL is not set. Run with the root .env loaded, e.g.:\n' +
    '    npx tsx --env-file=.env server/scripts/backfill-journal-coords.ts',
  )
  process.exit(1)
}
if (!dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1')) {
  console.error(
    '✖ Refusing to run: DATABASE_URL does not point at localhost / 127.0.0.1.\n' +
    '  This script is DEV-ONLY and must never touch a remote/prod database.',
  )
  process.exit(1)
}

async function main() {
  // Candidates: stop-linked entries still missing coordinates.
  const candidates = await prisma.journalEntry.findMany({
    where: {
      stopId: { not: null },
      OR: [{ lat: null }, { lng: null }],
    },
    include: {
      stop: { select: { latitude: true, longitude: true, locationName: true } },
    },
  })

  let updated = 0
  let skippedNoStopCoords = 0

  for (const e of candidates) {
    const stop = e.stop
    // Can't backfill coords if the linked stop has none — skip (leave null).
    if (!stop || stop.latitude == null || stop.longitude == null) {
      skippedNoStopCoords++
      continue
    }
    await prisma.journalEntry.update({
      where: { id: e.id },
      data: {
        lat: stop.latitude,
        lng: stop.longitude,
        // Keep an existing placeName; otherwise fall back to the stop's name.
        placeName: e.placeName ?? stop.locationName ?? null,
      },
    })
    updated++
  }

  console.log('\n✓ Journal coordinate backfill complete (dev DB)\n')
  console.log('  candidates (stop-linked, missing coords): ', candidates.length)
  console.log('  updated (coords copied from stop):        ', updated)
  console.log('  skipped (linked stop has no coords):      ', skippedNoStopCoords)
  console.log('')
}

main()
  .catch((err) => {
    console.error('✖ Backfill failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
