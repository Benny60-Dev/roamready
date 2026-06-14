/**
 * Self-person backfill (CREATES, unlike backfillIsSelf which only flags).
 *
 * For every DEFAULT TravelParty that has NO isSelf person, creates one
 * representing the account holder:
 *   { role: 'ADULT', name: user.firstName?.trim() || 'Me', isTraveling: true, isSelf: true }
 *
 * Why this exists: the account holder was never auto-created as a Person, so
 * a "me + companion" party counted as 1 adult. createParty now seeds a self
 * for new default parties; this script repairs existing ones. The earlier
 * backfillIsSelf only marked an EXISTING first-adult person — parties where the
 * user never added themselves still have no self, which this fixes.
 *
 * Idempotent:
 *   - A default party that already has any isSelf person is SKIPPED (the
 *     no-DB-uniqueness rule: never create a second self).
 *   - Re-running writes nothing on the second pass.
 *
 * Scope: DEFAULT parties only (isDefault: true). Trip-scoped parties are clones
 * of the default and aren't the user's source of truth.
 *
 * Mirrors backfillIsSelf.ts: per-party transaction, same prisma import +
 * disconnect, summary log.
 *
 * Run with:
 *   DATABASE_URL=... npx tsx src/scripts/backfillSelfPerson.ts
 */
import { prisma } from '../utils/prisma'
import { PersonRole } from '@prisma/client'

interface Summary {
  partiesProcessed: number
  selvesCreated: number
  partiesSkipped: number
}

async function main() {
  const summary: Summary = {
    partiesProcessed: 0,
    selvesCreated: 0,
    partiesSkipped: 0,
  }

  // Default parties only, with their people (to check for an existing self) and
  // the owning user's first name (for the self person's name).
  const parties = await prisma.travelParty.findMany({
    where: { isDefault: true },
    include: {
      people: true,
      user: { select: { firstName: true } },
    },
  })

  console.log(`[backfill-self] found ${parties.length} default party/parties`)

  for (const party of parties) {
    summary.partiesProcessed += 1

    try {
      await prisma.$transaction(async (tx) => {
        // Idempotency: already has a self → leave untouched.
        if (party.people.some((p) => p.isSelf)) {
          summary.partiesSkipped += 1
          console.log(`[backfill-self] party ${party.id}: already has a self person, skipping`)
          return
        }

        const name = party.user?.firstName?.trim() || 'Me'
        const self = await tx.person.create({
          data: {
            partyId: party.id,
            role: PersonRole.ADULT,
            name,
            isTraveling: true,
            isSelf: true,
          },
        })

        summary.selvesCreated += 1
        console.log(`[backfill-self] party ${party.id}: created self person ${self.id} ("${name}")`)
      })
    } catch (err) {
      console.error(`[backfill-self] party ${party.id}: FAILED —`, err)
    }
  }

  console.log('\n=== self-person backfill summary ===')
  console.log(`Parties processed:   ${summary.partiesProcessed}`)
  console.log(`Selves created:      ${summary.selvesCreated}`)
  console.log(`Parties skipped:     ${summary.partiesSkipped}`)
}

main()
  .catch((err) => {
    console.error('[backfill-self] fatal:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
