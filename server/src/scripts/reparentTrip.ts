import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TRIP_ID = 'cmorcyjyc000fv7i4rzv916kx'
const TARGET_USER_ID = 'cmou6jilq0000v7dgo1uo9bve' // Cindy@roamready.ai
const EXPECTED_SOURCE_USER_ID = 'cmo4q8fux0000v7rg2ptwhpcc' // Benny — sanity check

async function main() {
  // Sanity-check: trip exists, currently belongs to expected source user
  const trip = await prisma.trip.findUnique({
    where: { id: TRIP_ID },
    select: { id: true, name: true, userId: true },
  })
  if (!trip) throw new Error(`Trip ${TRIP_ID} not found`)
  if (trip.userId !== EXPECTED_SOURCE_USER_ID) {
    throw new Error(
      `Trip ${TRIP_ID} belongs to ${trip.userId}, expected ${EXPECTED_SOURCE_USER_ID}. Aborting to avoid moving the wrong row.`
    )
  }

  // Sanity-check: target user exists
  const target = await prisma.user.findUnique({
    where: { id: TARGET_USER_ID },
    select: { id: true, email: true },
  })
  if (!target) throw new Error(`Target user ${TARGET_USER_ID} not found`)

  console.log(`[reparent] Moving "${trip.name}" → ${target.email}`)

  await prisma.$transaction(async tx => {
    await tx.trip.update({
      where: { id: TRIP_ID },
      data: { userId: TARGET_USER_ID },
    })

    // PlanningSession is 1:1 with trip via @unique tripId — at most one row
    const sessionUpdate = await tx.planningSession.updateMany({
      where: { tripId: TRIP_ID },
      data: { userId: TARGET_USER_ID },
    })
    console.log(`[reparent] PlanningSession rows updated: ${sessionUpdate.count}`)
  })

  // Verify after
  const verifyTrip = await prisma.trip.findUnique({
    where: { id: TRIP_ID },
    select: { userId: true },
  })
  console.log(`[reparent] Trip.userId now: ${verifyTrip?.userId}`)
  console.log(`[reparent] Done.`)
}

main()
  .catch(err => {
    console.error('[reparent] FAILED:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
