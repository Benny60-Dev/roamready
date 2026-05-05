/**
 * Travel Party Phase A — backfill script.
 *
 * Idempotently creates a default TravelParty for every user that has a
 * TravelProfile and doesn't already have one. Folds existing party-shaped
 * fields into the new model:
 *   - TravelProfile.adults / children / hasPets / petDetails / accessibilityNeeds
 *     / militaryStatus / firstResponder → Person + Pet rows on the default party
 *   - User.emergencyContact / emergencyPhone → a non-traveling Person flagged
 *     isEmergencyContact=true on the default party
 *
 * Old fields stay in place — Phase C will remove them after the UI cuts over.
 *
 * Run with:
 *   DATABASE_URL=... npx tsx src/scripts/backfillTravelParty.ts
 *   (or `npm run db:backfill-party` after Phase A's package.json edit lands)
 *
 * Safe to run multiple times — checks for an existing default party per user
 * before creating, and uses a per-user transaction so a partial failure on
 * one row leaves no orphans.
 */
import { prisma } from '../utils/prisma'
import { PersonRole, PetType } from '@prisma/client'

interface Summary {
  usersProcessed: number
  partiesCreated: number
  partiesSkipped: number
  peopleCreated: number
  petsCreated: number
  emergencyContactsFolded: number
}

async function main() {
  const summary: Summary = {
    usersProcessed: 0,
    partiesCreated: 0,
    partiesSkipped: 0,
    peopleCreated: 0,
    petsCreated: 0,
    emergencyContactsFolded: 0,
  }

  // Only consider users with a TravelProfile — those are the ones who have
  // party-shaped data to fold in. Users without a profile get nothing.
  const users = await prisma.user.findMany({
    where: { travelProfile: { isNot: null } },
    include: { travelProfile: true },
  })

  console.log(`[backfill] found ${users.length} user(s) with a TravelProfile`)

  for (const user of users) {
    summary.usersProcessed += 1

    try {
      await prisma.$transaction(async (tx) => {
        // Skip if a default party already exists for this user (idempotency).
        const existing = await tx.travelParty.findFirst({
          where: { userId: user.id, isDefault: true },
          select: { id: true },
        })
        if (existing) {
          summary.partiesSkipped += 1
          console.log(`[backfill] user ${user.id} (${user.email}): already has default party, skipping`)
          return
        }

        const profile = user.travelProfile!
        const adultsCount = Math.max(0, profile.adults ?? 1)
        const childrenCount = Math.max(0, profile.children ?? 0)
        const hasPets = profile.hasPets ?? false

        // Build the people list. The first ADULT represents the user themself
        // and carries any account-level military / first-responder / accessibility
        // data forward onto the per-Person record.
        const accountHolderName =
          `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || null

        const peopleData: Array<{
          role: PersonRole
          name: string | null
          age: number | null
          isTraveling: boolean
          isEmergencyContact: boolean
          emergencyPhone: string | null
          accessibilityNeeds: any
          militaryStatus: string | null
          firstResponder: string | null
        }> = []

        peopleData.push({
          role: PersonRole.ADULT,
          name: accountHolderName,
          age: null,
          isTraveling: true,
          isEmergencyContact: false,
          emergencyPhone: null,
          accessibilityNeeds: profile.accessibilityNeeds ?? null,
          militaryStatus: profile.militaryStatus ?? null,
          firstResponder: profile.firstResponder ?? null,
        })

        // Additional adults beyond the account holder. Blank slots — the user
        // can name them later in the Travel Party UI.
        for (let i = 0; i < adultsCount - 1; i++) {
          peopleData.push({
            role: PersonRole.ADULT,
            name: null,
            age: null,
            isTraveling: true,
            isEmergencyContact: false,
            emergencyPhone: null,
            accessibilityNeeds: null,
            militaryStatus: null,
            firstResponder: null,
          })
        }

        // Children — role-only by spec. Name and age both nullable.
        for (let i = 0; i < childrenCount; i++) {
          peopleData.push({
            role: PersonRole.CHILD,
            name: null,
            age: null,
            isTraveling: true,
            isEmergencyContact: false,
            emergencyPhone: null,
            accessibilityNeeds: null,
            militaryStatus: null,
            firstResponder: null,
          })
        }

        // Emergency contact: a non-traveling Person flagged as the contact.
        // Phone optional — User.emergencyContact may be set without phone.
        const hasEmergencyContact = !!user.emergencyContact?.trim()
        if (hasEmergencyContact) {
          peopleData.push({
            role: PersonRole.ADULT,
            name: user.emergencyContact!.trim(),
            age: null,
            isTraveling: false,
            isEmergencyContact: true,
            emergencyPhone: user.emergencyPhone ?? null,
            accessibilityNeeds: null,
            militaryStatus: null,
            firstResponder: null,
          })
          summary.emergencyContactsFolded += 1
        }

        // Pet — discovery confirmed petDetails is empty/null on essentially
        // all rows since no UI ever wrote to it. Pull `notes` if it's shaped
        // like { notes: string, ... } and otherwise leave null.
        const petsData: Array<{
          type: PetType
          name: string | null
          notes: string | null
        }> = []
        if (hasPets) {
          let petNotes: string | null = null
          const pd = profile.petDetails
          if (pd && typeof pd === 'object' && !Array.isArray(pd)) {
            const maybeNotes = (pd as Record<string, unknown>).notes
            if (typeof maybeNotes === 'string' && maybeNotes.trim()) {
              petNotes = maybeNotes.trim()
            }
          }
          petsData.push({
            type: PetType.DOG,
            name: null,
            notes: petNotes,
          })
        }

        await tx.travelParty.create({
          data: {
            userId: user.id,
            isDefault: true,
            people: { create: peopleData },
            pets: { create: petsData },
          },
        })

        summary.partiesCreated += 1
        summary.peopleCreated += peopleData.length
        summary.petsCreated += petsData.length

        console.log(
          `[backfill] user ${user.id} (${user.email}): created party with ` +
          `${peopleData.length} people, ${petsData.length} pets` +
          (hasEmergencyContact ? ' (incl. emergency contact)' : ''),
        )
      })
    } catch (err) {
      console.error(`[backfill] user ${user.id} (${user.email}): FAILED —`, err)
    }
  }

  console.log('\n=== Backfill summary ===')
  console.log(`Users processed:           ${summary.usersProcessed}`)
  console.log(`Parties created:           ${summary.partiesCreated}`)
  console.log(`Parties skipped (existed): ${summary.partiesSkipped}`)
  console.log(`People created:            ${summary.peopleCreated}`)
  console.log(`Pets created:              ${summary.petsCreated}`)
  console.log(`Emergency contacts folded: ${summary.emergencyContactsFolded}`)
}

main()
  .catch((err) => {
    console.error('[backfill] fatal:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
