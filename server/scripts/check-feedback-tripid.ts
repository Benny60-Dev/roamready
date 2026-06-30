// Integration check for trip-tagged feedback persistence.
//
// Run against a RUNNING backend (the route → .strict() Zod schema → controller
// → Prisma path is exactly what we want to exercise — a unit test on the
// controller would skip the schema, where a forgotten field silently 400s):
//
//   1. (apply the migration first — see the feature's run steps)
//   2. restart the backend so tsx picks up the new Prisma client + columns
//   3. cd server && npm run check:feedback-tripid
//
// What it does: mints a short-lived JWT for an existing verified user, POSTs two
// feedback submissions — one tagged with a tripId (+tripName), one with a
// sessionId — and asserts each id lands on the created row both in the API
// response AND when re-read straight from the DB. Deletes the two rows on the
// way out. Reads DATABASE_URL + JWT_SECRET from the root .env (the npm script
// passes --env-file=../.env). Exits non-zero on any failed assertion.
import axios from 'axios'
import jwt from 'jsonwebtoken'
import { prisma } from '../src/utils/prisma'

const BASE_URL = process.env.CHECK_BASE_URL || `http://localhost:${process.env.PORT || 3001}`
const ENDPOINT = `${BASE_URL}/api/v1/feedback`

let failed = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function main() {
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET not set — run via `npm run check:feedback-tripid` (loads ../.env).')
    process.exit(1)
  }

  // An existing verified, active user — required by requireAuth +
  // requireVerifiedEmail. Prefer the owner account. We never create or delete a
  // user; we only attach (and then remove) throwaway feedback rows.
  const user = await prisma.user.findFirst({
    where: { emailVerified: true, deactivatedAt: null },
    orderBy: { isOwner: 'desc' },
    select: { id: true, email: true },
  })
  if (!user) {
    console.error('No verified, active user found to authenticate the test POST.')
    process.exit(1)
  }
  console.log(`Using user ${user.email} against ${ENDPOINT}`)

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '15m' })
  const auth = { headers: { Authorization: `Bearer ${token}` } }

  const stamp = Date.now()
  const tripId = `check-trip-${stamp}`
  const tripName = `Check Trip ${stamp}`
  const sessionId = `check-session-${stamp}`
  const createdIds: string[] = []

  try {
    // ── Case 1: trip-tagged (built-trip page) ────────────────────────────────
    const tripRes = await axios.post(
      ENDPOINT,
      { type: 'BUG_REPORT', body: '[check-feedback-tripid] trip-tagged', tripId, tripName },
      auth,
    )
    const tripRow = tripRes.data
    createdIds.push(tripRow.id)
    check('trip: 201 created', tripRes.status === 201)
    check('trip: response carries tripId', tripRow.tripId === tripId, `got ${tripRow.tripId}`)
    check('trip: response carries tripName', tripRow.tripName === tripName, `got ${tripRow.tripName}`)
    check('trip: sessionId is null (kept distinct)', tripRow.sessionId == null, `got ${tripRow.sessionId}`)

    const tripDb = await prisma.feedback.findUnique({ where: { id: tripRow.id } })
    check('trip: tripId persisted in DB', tripDb?.tripId === tripId, `got ${tripDb?.tripId}`)
    check('trip: tripName persisted in DB', tripDb?.tripName === tripName, `got ${tripDb?.tripName}`)

    // ── Case 2: session-tagged (planning page, no built trip) ─────────────────
    const sessRes = await axios.post(
      ENDPOINT,
      { type: 'BUG_REPORT', body: '[check-feedback-tripid] session-tagged', sessionId },
      auth,
    )
    const sessRow = sessRes.data
    createdIds.push(sessRow.id)
    check('session: 201 created', sessRes.status === 201)
    check('session: response carries sessionId', sessRow.sessionId === sessionId, `got ${sessRow.sessionId}`)
    check('session: tripId is null (kept distinct)', sessRow.tripId == null, `got ${sessRow.tripId}`)

    const sessDb = await prisma.feedback.findUnique({ where: { id: sessRow.id } })
    check('session: sessionId persisted in DB', sessDb?.sessionId === sessionId, `got ${sessDb?.sessionId}`)
  } catch (err: any) {
    failed++
    const status = err?.response?.status
    const data = err?.response?.data
    console.log('FAIL  request threw', status ? `— HTTP ${status}: ${JSON.stringify(data)}` : `— ${err?.message}`)
    if (status === undefined) {
      console.log('      (is the backend running on', BASE_URL, '? start it, then re-run.)')
    }
  } finally {
    // Always clean up the throwaway rows.
    if (createdIds.length) {
      await prisma.feedback.deleteMany({ where: { id: { in: createdIds } } })
      console.log(`Cleaned up ${createdIds.length} test feedback row(s).`)
    }
    await prisma.$disconnect()
  }

  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.')
  process.exit(failed ? 1 : 0)
}

main().catch(async (err) => {
  console.error('check-feedback-tripid crashed:', err)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
