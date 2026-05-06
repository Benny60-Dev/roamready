/**
 * Backfill `Trip.startLocation` and `Trip.endLocation` for trips whose endpoints
 * have drifted from the actual first/last stop. Endpoints were originally set at
 * trip creation time and not refreshed when stops were later mutated, so a
 * round trip whose closing return-home leg was removed in modify-mode still
 * reports the stale destination. Modify-mode prompts that surface
 * `Route: ${trip.startLocation} → ${trip.endLocation}` then misframe the trip
 * shape for the AI ("Mesa → Mesa" on a one-way Mesa→Carlsbad trip).
 *
 * Idempotent — only trips with drift are updated; trips already in sync are
 * left untouched.
 *
 * Run with:
 *   cd server && npm run db:sync-endpoints
 */
import { prisma } from '../utils/prisma'

async function main() {
  console.log('[sync-endpoints] Starting')

  const trips = await prisma.trip.findMany({
    select: {
      id: true,
      name: true,
      startLocation: true,
      endLocation: true,
      stops: {
        orderBy: { order: 'asc' },
        select: { locationName: true },
      },
    },
  })

  let updated = 0
  let unchanged = 0
  let skipped = 0

  for (const trip of trips) {
    const tripLabel = trip.name || '(unnamed)'

    if (trip.stops.length === 0) {
      console.log(`[sync-endpoints] SKIP ${trip.id} (${tripLabel}): no stops`)
      skipped += 1
      continue
    }

    const newStart = trip.stops[0].locationName
    const newEnd = trip.stops[trip.stops.length - 1].locationName

    if (newStart === trip.startLocation && newEnd === trip.endLocation) {
      unchanged += 1
      continue
    }

    await prisma.trip.update({
      where: { id: trip.id },
      data: { startLocation: newStart, endLocation: newEnd },
    })

    console.log(
      `[sync-endpoints] OK ${trip.id} (${tripLabel}): ` +
      `start "${trip.startLocation}" → "${newStart}", ` +
      `end "${trip.endLocation}" → "${newEnd}"`,
    )
    updated += 1
  }

  console.log('')
  console.log('=== Sync summary ===')
  console.log(`Trips examined:  ${trips.length}`)
  console.log(`Updated:         ${updated}`)
  console.log(`Already in sync: ${unchanged}`)
  console.log(`Skipped (empty): ${skipped}`)
}

main()
  .catch(err => {
    console.error('[sync-endpoints] fatal:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
