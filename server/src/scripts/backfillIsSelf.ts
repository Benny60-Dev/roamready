/**
 * Person.isSelf backfill script.
 *
 * Makes the "first ADULT represents the user themself" convention (see
 * backfillTravelParty.ts ~L74) explicit on the new Person.isSelf column.
 *
 * For each TravelParty, marks exactly ONE person as isSelf=true: the FIRST
 * person (lowest createdAt, tie-break lowest id) whose role is 'ADULT' and
 * isEmergencyContact is false. If a party has no matching person, it marks
 * none (all stay false) and logs that party's id.
 *
 * Idempotent:
 *   - If a party already has any isSelf=true person, it is left untouched —
 *     the script never marks a second self person.
 *   - Re-running produces the same result and writes nothing on the second
 *     pass (already-marked parties are skipped before any update).
 *
 * Mirrors backfillTravelParty.ts: per-party transaction so a partial failure
 * on one row leaves the others consistent, same prisma import + disconnect.
 *
 * Run with:
 *   DATABASE_URL=... npx tsx src/scripts/backfillIsSelf.ts
 *   (or `npm run db:backfill-isself` if a package.json script is added)
 *
 * NOTE: requires the add_person_isself migration to be applied first, so the
 * isSelf column exists.
 */
import { prisma } from '../utils/prisma'
import { PersonRole } from '@prisma/client'

interface Summary {
  partiesProcessed: number
  partiesMarked: number
  partiesAlreadyMarked: number
  partiesNoMatch: number
}

async function main() {
  const summary: Summary = {
    partiesProcessed: 0,
    partiesMarked: 0,
    partiesAlreadyMarked: 0,
    partiesNoMatch: 0,
  }

  // Every party — default (userId set) and trip-scoped (tripId set) alike.
  // Pull the people so we can pick the self person in-memory with a
  // deterministic ordering (createdAt asc, then id asc as a stable tie-break).
  const parties = await prisma.travelParty.findMany({
    include: {
      people: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
    },
  })

  console.log(`[backfill-isself] found ${parties.length} party/parties`)

  for (const party of parties) {
    summary.partiesProcessed += 1

    try {
      await prisma.$transaction(async (tx) => {
        // Idempotency: if this party already has a self person, do nothing.
        // Re-running never marks a second self person.
        const alreadyMarked = party.people.some((p) => p.isSelf)
        if (alreadyMarked) {
          summary.partiesAlreadyMarked += 1
          console.log(`[backfill-isself] party ${party.id}: already has a self person, skipping`)
          return
        }

        // First ADULT, non-emergency-contact person by (createdAt asc, id asc).
        // `party.people` is already ordered that way from the query above.
        const self = party.people.find(
          (p) => p.role === PersonRole.ADULT && p.isEmergencyContact === false,
        )

        if (!self) {
          summary.partiesNoMatch += 1
          console.log(`[backfill-isself] party ${party.id}: no ADULT/non-emergency person — marking none`)
          return
        }

        await tx.person.update({
          where: { id: self.id },
          data: { isSelf: true },
        })

        summary.partiesMarked += 1
        console.log(`[backfill-isself] party ${party.id}: marked person ${self.id} as self`)
      })
    } catch (err) {
      console.error(`[backfill-isself] party ${party.id}: FAILED —`, err)
    }
  }

  console.log('\n=== isSelf backfill summary ===')
  console.log(`Parties processed:        ${summary.partiesProcessed}`)
  console.log(`Parties marked:           ${summary.partiesMarked}`)
  console.log(`Parties already marked:   ${summary.partiesAlreadyMarked}`)
  console.log(`Parties with no match:    ${summary.partiesNoMatch}`)
}

main()
  .catch((err) => {
    console.error('[backfill-isself] fatal:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
