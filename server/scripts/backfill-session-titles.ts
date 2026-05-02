/**
 * One-off backfill: align PlanningSession.title with the linked Trip.name
 * for sessions that were promoted before the controller started mirroring
 * trip.name onto session.title.
 *
 * Run with: npx tsx server/scripts/backfill-session-titles.ts
 *
 * Idempotent — re-running skips sessions whose title already matches.
 */
import { prisma } from '../src/utils/prisma'

async function main() {
  const sessions = await prisma.planningSession.findMany({
    where: {
      status: 'COMPLETED',
      tripId: { not: null },
    },
    select: { id: true, title: true, tripId: true },
  })

  console.log(`Found ${sessions.length} sessions to backfill`)

  let updated = 0
  let skipped = 0

  for (const s of sessions) {
    if (!s.tripId) continue
    const trip = await prisma.trip.findUnique({
      where: { id: s.tripId },
      select: { name: true },
    })
    if (!trip) {
      console.log(`Skipping session ${s.id}: linked trip ${s.tripId} not found`)
      skipped++
      continue
    }
    if (s.title === trip.name) {
      skipped++
      continue
    }
    await prisma.planningSession.update({
      where: { id: s.id },
      data: { title: trip.name },
    })
    console.log(`Updated session ${s.id}: '${s.title ?? ''}' → '${trip.name}'`)
    updated++
  }

  console.log(`Done. Updated ${updated} sessions, skipped ${skipped} already-correct.`)
}

main()
  .catch(err => {
    console.error('Backfill failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
