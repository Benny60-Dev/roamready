/**
 * repairHomeCoords.ts — one-time data repair for the HOME-stop coords bug.
 *
 * BACKGROUND
 * Before Steps 2 & 3 of the home-coords fix (2026-05-30), createStop() applied
 * the trip owner's home coordinates to ANY stop typed HOME — regardless of whether
 * its city matched the owner's homeCity. Trips departing from a non-home city
 * (e.g. "San Jose to Shenandoah") got Mesa, AZ's coordinates on their start stop.
 *
 * This script finds those corrupted rows and nulls their lat/lng so the client
 * geocoder re-resolves the correct city on the next map load.
 *
 * CORRUPTION SIGNATURE (BOTH conditions must be true to qualify):
 *   1. Stop.type === 'HOME' AND normalizeCity(locationName) ≠ owner.homeCity
 *      (city mismatch — the start stop is not in the user's home city)
 *   2. |Stop.latitude  − owner.homeLat| ≤ 0.01° AND
 *      |Stop.longitude − owner.homeLng| ≤ 0.01°
 *      (coords match home — confirms they were wrongly stamped, not geocoded)
 *
 * THE REPAIR: set latitude=null, longitude=null on each corrupted stop.
 * No rows are deleted. No other fields are touched. The client geocode effect
 * picks up null coords on next map load and resolves the real start city.
 *
 * ─── SAFETY ───────────────────────────────────────────────────────────────────
 * DRY-RUN IS THE DEFAULT. Running the script with no flags NEVER writes anything.
 * The repair only runs when you explicitly pass --apply.
 * The double condition (city mismatch AND coords ≈ home) prevents accidentally
 * nulling a legitimately-home start stop.
 *
 * ─── USAGE (from the server/ directory) ─────────────────────────────────────
 *
 *   Dry run — preview affected stops, write NOTHING:
 *     tsx --env-file=../.env src/scripts/repairHomeCoords.ts
 *
 *   Dry run on one trip only:
 *     tsx --env-file=../.env src/scripts/repairHomeCoords.ts --tripId <id>
 *
 *   APPLY — null coords on corrupted stops (after reviewing dry-run output):
 *     tsx --env-file=../.env src/scripts/repairHomeCoords.ts --apply
 *
 *   Apply to one trip only:
 *     tsx --env-file=../.env src/scripts/repairHomeCoords.ts --apply --tripId <id>
 *
 * Or via npm (after adding to package.json scripts):
 *   npm run db:repair-home-coords                    # dry run
 *   npm run db:repair-home-coords -- --apply         # write
 *   npm run db:repair-home-coords -- --tripId <id>   # single trip dry run
 */
import { prisma } from '../utils/prisma'

// ─── Args ─────────────────────────────────────────────────────────────────────

interface Args {
  /** false = dry run (default, safe); true = actually write null coords */
  apply: boolean
  tripId: string | null
  showHelp: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, tripId: null, showHelp: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') {
      out.apply = true
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
repairHomeCoords — data repair for the HOME-stop coordinates bug.

Before the 2026-05-30 server fix, createStop() stamped the trip owner's home
coordinates onto ANY type=HOME stop, even when the start city was not the owner's
home city. This script finds those corrupted stops (city mismatch + coords ≈ home)
and nulls their lat/lng so the client geocoder re-resolves the correct location.

DRY-RUN IS THE DEFAULT. Pass --apply to write.

Usage:
  tsx --env-file=../.env src/scripts/repairHomeCoords.ts [options]

Options:
  --apply           Actually write null coords (default: dry run, writes nothing)
  --tripId <id>     Operate on this trip only (useful for testing before full run)
  --help, -h        Show this message

Examples:
  # Preview ALL affected stops (safe, writes nothing):
  tsx --env-file=../.env src/scripts/repairHomeCoords.ts

  # Preview a single trip:
  tsx --env-file=../.env src/scripts/repairHomeCoords.ts --tripId clxxx

  # Apply to all affected stops (run the dry run first!):
  tsx --env-file=../.env src/scripts/repairHomeCoords.ts --apply
`

// ─── City normalizer ──────────────────────────────────────────────────────────
// Copied verbatim from server/src/controllers/trips.ts (module-level private fn).
// Keep in sync if trips.ts ever changes it.

function normalizeCity(s: string): string {
  return s.toLowerCase()
    .replace(/,?\s*\d{5}(-\d{4})?$/, '')
    .replace(/,?\s*(usa|united states)$/, '')
    .replace(/,?\s*(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/, '')
    .replace(/,?\s+[a-z]{2}$/, '')
    .trim()
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Tolerance (degrees) for "coords ≈ home" check.
 * 0.01° ≈ ~1 km at mid-latitudes — tight enough to exclude geocoded city-centre
 * results (which could be a few km from a home address) while still catching any
 * floating-point variation in the stored home coords.
 */
const COORD_TOLERANCE = 0.01

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.showHelp) {
    console.log(HELP)
    return
  }

  const tag = args.apply ? '[repairHomeCoords:APPLY]' : '[repairHomeCoords:DRY-RUN]'

  if (!args.apply) {
    console.log(`${tag} DRY-RUN mode — nothing will be written.`)
    console.log(`${tag} Pass --apply to perform the repair.`)
    console.log()
  } else {
    console.log(`${tag} *** APPLY mode — corrupted coords will be nulled. ***`)
    console.log()
  }

  if (args.tripId) {
    console.log(`${tag} Scoped to tripId: ${args.tripId}`)
    console.log()
  }

  // ── Query: HOME stops with non-null coords whose owner has home data ──────────
  // We need non-null lat/lng (there's nothing to repair if already null) and the
  // owner must have homeCity + homeLat + homeLng so we can evaluate both conditions.
  const homeStops = await prisma.stop.findMany({
    where: {
      type: 'HOME',
      latitude:  { not: null },
      longitude: { not: null },
      trip: {
        user: {
          homeCity: { not: null },
          homeLat:  { not: null },
          homeLng:  { not: null },
        },
        ...(args.tripId ? { id: args.tripId } : {}),
      },
    },
    select: {
      id: true,
      locationName: true,
      locationState: true,
      latitude: true,
      longitude: true,
      tripId: true,
      trip: {
        select: {
          id: true,
          name: true,
          user: {
            select: {
              id: true,
              homeCity: true,
              homeLat: true,
              homeLng: true,
            },
          },
        },
      },
    },
    orderBy: { tripId: 'asc' },
  })

  console.log(`${tag} HOME stops with non-null coords (owner has homeCity + home coords): ${homeStops.length}`)

  // ── Filter to corrupted set ──────────────────────────────────────────────────
  // Both conditions must be true:
  //   1. City mismatch: normalizeCity(locationName) ≠ owner.homeCity
  //   2. Coords ≈ home: within COORD_TOLERANCE of owner's homeLat/homeLng
  const corrupted = homeStops.filter(s => {
    const owner = s.trip.user
    // Null-guard (Prisma WHERE already filtered, but TypeScript doesn't narrow from WHERE)
    if (!owner.homeCity || owner.homeLat == null || owner.homeLng == null) return false
    if (s.latitude == null || s.longitude == null) return false

    // Condition 1 — city mismatch
    const stopCity = normalizeCity(s.locationName)
    const homeCity = owner.homeCity.toLowerCase().trim()
    if (stopCity === homeCity) return false   // legitimate home stop — skip

    // Condition 2 — coords match home (within tolerance)
    const latDiff = Math.abs(s.latitude  - owner.homeLat)
    const lngDiff = Math.abs(s.longitude - owner.homeLng)
    return latDiff <= COORD_TOLERANCE && lngDiff <= COORD_TOLERANCE
  })

  console.log(`${tag} Corrupted (city mismatch + coords ≈ home): ${corrupted.length}`)
  console.log()

  if (corrupted.length === 0) {
    console.log(`${tag} Nothing to repair. Exiting.`)
    return
  }

  // ── Print report ─────────────────────────────────────────────────────────────
  console.log(`${tag} Affected stops:`)
  for (const s of corrupted) {
    const owner = s.trip.user
    console.log(
      `  stop ${s.id}` +
      ` | trip "${s.trip.name}" (${s.tripId})` +
      ` | locationName="${s.locationName}${s.locationState ? ', ' + s.locationState : ''}"` +
      ` | owner.homeCity="${owner.homeCity}"` +
      ` | WRONG lat=${s.latitude?.toFixed(5)} lng=${s.longitude?.toFixed(5)}` +
      ` | home lat=${owner.homeLat?.toFixed(5)} lng=${owner.homeLng?.toFixed(5)}`,
    )
  }
  console.log()

  // ── Dry-run exit ──────────────────────────────────────────────────────────────
  if (!args.apply) {
    console.log(`${tag} DRY RUN complete.`)
    console.log(`${tag} ${corrupted.length} stop(s) WOULD be repaired (latitude/longitude → null).`)
    console.log(`${tag} Re-run with --apply to perform the repair.`)
    return
  }

  // ── Apply: null out lat/lng on each corrupted stop ────────────────────────────
  let repaired = 0
  for (const s of corrupted) {
    await prisma.stop.update({
      where: { id: s.id },
      data: { latitude: null, longitude: null },
    })
    console.log(`${tag} Nulled coords on stop ${s.id} (locationName="${s.locationName}", trip ${s.tripId})`)
    repaired++
  }

  console.log()
  console.log(`${tag} Repair complete. ${repaired} stop(s) updated (lat/lng → null).`)
  console.log(`${tag} Affected trips will re-geocode to the correct start city on next map load.`)
}

main()
  .catch(err => {
    console.error('[repairHomeCoords] Fatal error:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
