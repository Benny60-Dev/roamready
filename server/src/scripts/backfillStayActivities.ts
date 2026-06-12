/**
 * Block 15 — Step 4 backfill.
 *
 * For every existing trip, walks Trip.itinerary, collects each multi-night
 * DESTINATION stop's per-day activity arrays, dedupes them into ONE merged
 * list, and writes that list to Stop.stayActivities. Trip.itinerary is
 * NEVER touched and continues to serve as the fallback render path for any
 * trip that, for whatever reason, this script doesn't write to.
 *
 * The script is purely additive: it only ever writes to Stop.stayActivities
 * on rows where stayActivities is currently NULL. No deletes, no other
 * writes, no schema changes.
 *
 * Safety design:
 *   - Only ever WRITES to Stop.stayActivities. Never to Trip.itinerary, the
 *     Trip row itself, or any other table/field.
 *   - Idempotent: any stop that already has stayActivities non-null is
 *     skipped, so re-running this script is a no-op for previously-touched
 *     rows. Running it twice does no harm.
 *   - Dry-run mode (--dry-run): logs what it WOULD write per stop without
 *     writing anything. Use this to preview before the real run.
 *   - Single-trip mode (--tripId <id>): operates only on that one trip.
 *     Run this on a test trip first to verify the merged output looks right
 *     before any cross-trip exposure.
 *   - Malformed/null itinerary JSON for a trip is logged and that trip is
 *     skipped — the rest of the run is unaffected.
 *
 * Run examples (from the `server/` directory):
 *
 *   Show the help text:
 *     tsx --env-file=../.env src/scripts/backfillStayActivities.ts --help
 *
 *   Dry-run on one trip (PREVIEW ONLY — writes nothing):
 *     tsx --env-file=../.env src/scripts/backfillStayActivities.ts --dry-run --tripId <id>
 *
 *   Real run on one trip:
 *     tsx --env-file=../.env src/scripts/backfillStayActivities.ts --tripId <id>
 *
 *   Real run across all trips:
 *     tsx --env-file=../.env src/scripts/backfillStayActivities.ts
 *
 * If you want a `npm run db:backfill-stay-activities` shortcut, add this
 * line to server/package.json's "scripts" block (matches the pattern of the
 * existing backfill scripts):
 *
 *   "db:backfill-stay-activities": "tsx --env-file=../.env src/scripts/backfillStayActivities.ts"
 *
 * Then invoke with:
 *   npm run db:backfill-stay-activities -- --dry-run --tripId <id>
 *   npm run db:backfill-stay-activities -- --tripId <id>
 *   npm run db:backfill-stay-activities
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../utils/prisma'

// ─── Args ─────────────────────────────────────────────────────────────────────

interface Args {
  dryRun: boolean
  tripId: string | null
  showHelp: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, tripId: null, showHelp: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run' || a === '--dryRun') {
      out.dryRun = true
    } else if (a === '--tripId' || a === '--trip-id') {
      out.tripId = argv[i + 1] ?? null
      i++
    } else if (a === '--help' || a === '-h') {
      out.showHelp = true
    }
  }
  return out
}

const HELP = `\
Block 15 stayActivities backfill.

Walks each trip's itinerary, dedupes per-day activity arrays per multi-night
DESTINATION stop, and writes one merged list to Stop.stayActivities. Never
writes to any other field; never deletes anything; skips stops that already
have stayActivities non-null (idempotent).

Usage:
  tsx --env-file=../.env src/scripts/backfillStayActivities.ts [options]

Options:
  --tripId <id>     Process only this trip (test mode). Without it, the
                    script runs across every trip in the DB.
  --dry-run         Report what would be written, but write nothing.
  --help, -h        Show this message.

Examples:
  # Preview what would happen on a single trip
  tsx ... src/scripts/backfillStayActivities.ts --dry-run --tripId clxxx

  # Apply to one trip
  tsx ... src/scripts/backfillStayActivities.ts --tripId clxxx

  # Apply to all trips (after the single-trip test looks right)
  tsx ... src/scripts/backfillStayActivities.ts
`

// ─── Types ────────────────────────────────────────────────────────────────────

interface ItineraryActivityRecord {
  name: string
  checked: boolean
  isCustom?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize one activities-array entry (plain string OR a structured
 * {name, checked, isCustom?} object) to a structured ItineraryActivity.
 * Returns null for entries we can't make sense of (empty string, malformed
 * object, etc.) so dedupe doesn't insert junk.
 */
function normalizeOne(raw: unknown): ItineraryActivityRecord | null {
  if (typeof raw === 'string') {
    const name = raw.trim()
    if (!name) return null
    return { name, checked: false }
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    const rawName = typeof r.name === 'string' ? r.name.trim() : ''
    if (!rawName) return null
    const out: ItineraryActivityRecord = { name: rawName, checked: !!r.checked }
    if (r.isCustom) out.isCustom = true
    return out
  }
  return null
}

/**
 * Merge multiple per-day activity arrays into one deduped list.
 *   - Order: first occurrence of each name wins (so the merged list reads
 *     in the order the AI originally suggested across day 1 → day N).
 *   - Match: case-insensitive on the trimmed name (so "Hike main trail" and
 *     "hike main trail" collapse — these come up because the AI sometimes
 *     repeats a suggestion with slightly different casing day-to-day).
 *   - Checked-state merge: if ANY duplicate had checked=true, the merged
 *     entry stays checked. We never want to lose a user's "done" state
 *     just because two days carried the same activity.
 *   - isCustom: preserved if any duplicate had it set (user-added entries
 *     stay tagged so the UI can render them distinctly in the future).
 */
function mergeAndDedupe(arrays: unknown[][]): ItineraryActivityRecord[] {
  const byKey = new Map<string, ItineraryActivityRecord>()
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue
    for (const raw of arr) {
      const item = normalizeOne(raw)
      if (!item) continue
      const key = item.name.toLowerCase()
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, { ...item })
      } else {
        if (item.checked) existing.checked = true
        if (item.isCustom) existing.isCustom = true
      }
    }
  }
  return Array.from(byKey.values())
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.showHelp) {
    console.log(HELP)
    return
  }

  const tag = args.dryRun
    ? '[backfill-stay-activities | DRY RUN]'
    : '[backfill-stay-activities]'
  console.log(`${tag} starting${args.tripId ? ` (single trip: ${args.tripId})` : ' (all trips)'}`)

  const trips = await prisma.trip.findMany({
    where: args.tripId ? { id: args.tripId } : undefined,
    select: {
      id: true,
      name: true,
      itinerary: true,
      stops: {
        select: {
          id: true,
          order: true,
          type: true,
          nights: true,
          locationName: true,
          stayActivities: true,
        },
      },
    },
  })

  if (trips.length === 0) {
    console.log(`${tag} no trips matched${args.tripId ? ` for id=${args.tripId}` : ''}; nothing to do`)
    return
  }
  console.log(`${tag} examining ${trips.length} trip(s)`)

  let tripsTouched = 0
  let stopsWritten = 0
  let stopsSkipped_alreadySet = 0
  let stopsSkipped_singleOrZeroNight = 0
  let stopsSkipped_notDestination = 0
  let stopsSkipped_noActivities = 0
  let tripsSkipped_malformed = 0
  let tripsSkipped_nullItinerary = 0

  for (const trip of trips) {
    const tripLabel = `${trip.id}${trip.name ? ` (${trip.name})` : ''}`

    // Edge case: itinerary is null. This is normal for brand-new trips that
    // haven't generated yet, or for any trip where the AI never wrote one.
    // Nothing to merge from → skip the whole trip.
    if (trip.itinerary == null) {
      tripsSkipped_nullItinerary += 1
      console.log(`${tag} SKIP trip ${tripLabel}: itinerary is null`)
      continue
    }

    // Edge case: itinerary is not an array. Should never happen because
    // saveItinerary always writes ItineraryDay[], but defend against an
    // older malformed write (a stray object, a stringified blob, etc.).
    if (!Array.isArray(trip.itinerary)) {
      tripsSkipped_malformed += 1
      console.log(`${tag} SKIP trip ${tripLabel}: itinerary is not an array (type=${typeof trip.itinerary})`)
      continue
    }

    const itineraryDays: any[] = trip.itinerary as any[]
    let tripHadAnyWrite = false

    for (const stop of trip.stops) {
      const stopLabel = `${stop.id} (${stop.locationName ?? '(unnamed)'}, order=${stop.order}, ${stop.nights} night${stop.nights !== 1 ? 's' : ''})`

      // Edge case: only DESTINATION type qualifies. OVERNIGHT_ONLY and HOME
      // are excluded by spec — they don't render the stay-activities list
      // at all, so backfilling them is meaningless.
      if (stop.type !== 'DESTINATION') {
        stopsSkipped_notDestination += 1
        continue
      }

      // Edge case: only MULTI-night stops qualify. 0-night (return-home
      // edge case) and 1-night stops don't suffer from the per-day
      // duplication this backfill exists to fix.
      if ((stop.nights ?? 0) < 2) {
        stopsSkipped_singleOrZeroNight += 1
        continue
      }

      // Edge case: stayActivities already non-null. Either a trip was
      // regenerated after Step 2 (Step 2's controller wrote it), or a
      // previous run of this script already touched it. Either way: SKIP.
      // This is the rule that makes the script idempotent.
      if (stop.stayActivities != null) {
        stopsSkipped_alreadySet += 1
        console.log(`${tag} SKIP ${stopLabel}: stayActivities already set`)
        continue
      }

      // LINKING: ItineraryDay.stopOrder ↔ Stop.order, within the same trip.
      // For a multi-night stay at order=N, the itinerary contains:
      //   - one STAY day (night 1) with stopOrder=N, activities usually null
      //   - (nights - 1) ACTIVITY days with stopOrder=N, activities populated
      //   - the inbound DRIVE day also carries stopOrder=N but activities is null
      // We collect activities from EVERY day matching this stop's order
      // regardless of day type — defensive against a user having edited the
      // STAY day's array, or a DRIVE day that somehow has activities set
      // (shouldn't happen but mergeAndDedupe handles arrays from any source).
      const matchingDays = itineraryDays.filter(d =>
        d && typeof d === 'object' &&
        Number((d as any).stopOrder) === stop.order
      )
      const activityArrays: unknown[][] = matchingDays
        .map(d => (d as any).activities)
        .filter((a): a is unknown[] => Array.isArray(a))

      const merged = mergeAndDedupe(activityArrays)

      if (merged.length === 0) {
        // Edge case: nothing in any matching day's activities array. Leave
        // stayActivities NULL so the "never had any" signal is preserved
        // — empty array would mean "intentionally cleared", which is a
        // different state. Old-path renderer keeps working for this stop.
        stopsSkipped_noActivities += 1
        console.log(`${tag} SKIP ${stopLabel}: no activities found across ${activityArrays.length} matching day(s); leaving stayActivities null`)
        continue
      }

      const preview = merged.map(a => `${a.checked ? '✓' : '·'} ${a.name}${a.isCustom ? ' (custom)' : ''}`).join(' | ')
      console.log(`${tag} ${args.dryRun ? 'WOULD WRITE' : 'WRITE'} ${stopLabel}: ${merged.length} activit${merged.length === 1 ? 'y' : 'ies'} merged from ${activityArrays.length} day(s) → ${preview}`)

      if (!args.dryRun) {
        await prisma.stop.update({
          where: { id: stop.id },
          // merged is ItineraryActivityRecord[] (a typed object array, which
          // lacks the string index signature Prisma's InputJsonObject wants).
          // The runtime value is valid JSON; cast to Prisma.InputJsonValue to
          // bridge the type systems — same target type as the adHocVehicle Json
          // writes in trips.ts / sessions.ts (double-cast via unknown is needed
          // here because the source is a typed array, not a Record).
          data: { stayActivities: merged as unknown as Prisma.InputJsonValue },
        })
      }
      stopsWritten += 1
      tripHadAnyWrite = true
    }

    if (tripHadAnyWrite) tripsTouched += 1
  }

  console.log('')
  console.log(`${tag} === summary ===`)
  console.log(`Trips examined:                  ${trips.length}`)
  console.log(`Trips with at least one write:   ${tripsTouched}${args.dryRun ? ' (DRY RUN — nothing actually persisted)' : ''}`)
  console.log(`Trips skipped (itinerary null):  ${tripsSkipped_nullItinerary}`)
  console.log(`Trips skipped (malformed):       ${tripsSkipped_malformed}`)
  console.log(`Stops written:                   ${stopsWritten}${args.dryRun ? ' (DRY RUN — nothing actually persisted)' : ''}`)
  console.log(`Stops skipped (already set):     ${stopsSkipped_alreadySet}`)
  console.log(`Stops skipped (0 or 1 night):    ${stopsSkipped_singleOrZeroNight}`)
  console.log(`Stops skipped (not DESTINATION): ${stopsSkipped_notDestination}`)
  console.log(`Stops skipped (no activities):   ${stopsSkipped_noActivities}`)
}

main()
  .catch(err => {
    console.error('[backfill-stay-activities] fatal:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
