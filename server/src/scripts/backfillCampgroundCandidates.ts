/**
 * Backfill `campgroundCandidates` for Stop rows that were created without
 * them. Stops added via AI modify-mode (ModifyTripPanel → tripsApi.createStop)
 * or manual UI insertion (TripSummaryPage → tripsApi.createStop) currently
 * persist with NULL candidates, so the orchestrator falls back to the generic
 * Places area-search instead of running the higher-quality "verify these
 * specific names" path. Backfilling lets those stops use Tier 2 verification.
 *
 * Idempotent — only NULL/empty rows are processed.
 *
 * Run with:
 *   cd server && npm run db:backfill-candidates
 */
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../utils/prisma'
import { logAIUsage } from '../services/ai'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('[backfill-candidates] ANTHROPIC_API_KEY is not set — cannot proceed')
  process.exit(1)
}
const client = new Anthropic({ apiKey })

// Haiku is the right tool here: short, structured output (just an array of
// names), low stakes, low cost. Mirrors generateRouteHighlightsAI's choice.
const MODEL = 'claude-haiku-4-5-20251001'
const RATE_LIMIT_MS = 250
const MAX_NAMES = 4

interface SkipRecord {
  stopId: string
  locationLabel: string
  reason: string
}

function buildPrompt(locationName: string, locationState: string | null): string {
  const location = locationState ? `${locationName}, ${locationState}` : locationName
  return `List 3 to 4 real campground or RV park names near ${location}.

Prefer:
- KOAs (Kampgrounds of America)
- Established commercial RV parks and resorts
- Well-known public campgrounds — state parks, county parks, national forest campgrounds, BLM campgrounds with developed sites

Avoid:
- Walmart-style overnight parking lots
- Truck stops or rest areas
- Generic "free dispersed camping" suggestions without a named area

Respond with ONLY a JSON array of strings. No prose, no markdown code fences, no explanations, no addresses, no phone numbers — names only.

Example response shape:
["Polson/Flathead Lake KOA", "Big Arm State Park Campground", "Westwood RV Park"]`
}

function parseCandidates(raw: string): string[] | null {
  // Tolerate the model slipping in markdown fences despite the instructions.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const strings = parsed.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
  if (strings.length === 0) return null
  return strings.slice(0, MAX_NAMES)
}

async function main() {
  console.log('[backfill-candidates] Starting')

  // Loose Prisma filter (Json equals-null is unreliable) — tighten in JS.
  const allStops = await prisma.stop.findMany({
    where: { nights: { gt: 0 }, type: { not: 'HOME' } },
    select: {
      id: true,
      locationName: true,
      locationState: true,
      nights: true,
      type: true,
      campgroundCandidates: true,
      trip: { select: { userId: true } },
    },
  })

  const needsBackfill = allStops.filter(s =>
    s.campgroundCandidates == null ||
    (Array.isArray(s.campgroundCandidates) && s.campgroundCandidates.length === 0),
  )

  console.log(`[backfill-candidates] Eligible: ${needsBackfill.length} of ${allStops.length} examined`)

  let backfilled = 0
  const skipped: SkipRecord[] = []

  for (const stop of needsBackfill) {
    const locationLabel = stop.locationState
      ? `${stop.locationName}, ${stop.locationState}`
      : stop.locationName ?? '(unnamed)'

    if (!stop.locationName) {
      skipped.push({ stopId: stop.id, locationLabel, reason: 'missing locationName' })
      console.log(`[backfill-candidates] SKIP ${stop.id}: missing locationName`)
      continue
    }

    if (!stop.trip?.userId) {
      skipped.push({ stopId: stop.id, locationLabel, reason: 'missing trip.userId (orphan stop?)' })
      console.log(`[backfill-candidates] SKIP ${stop.id} (${locationLabel}): orphan stop, no userId`)
      continue
    }

    try {
      const prompt = buildPrompt(stop.locationName, stop.locationState)
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      })

      // Mirror services/ai.ts pattern — fire-and-forget log per AI call.
      // callType ITINERARY: this is the same kind of itinerary-stop metadata
      // the chat planner emits during initial trip generation; the schema's
      // AICallType enum has no dedicated BACKFILL value (would need a
      // migration). Flagged in the report.
      logAIUsage({
        userId: stop.trip.userId,
        callType: 'ITINERARY',
        model: MODEL,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }).catch(() => {})

      const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
      const candidates = parseCandidates(text)

      if (!candidates) {
        const preview = text.slice(0, 80).replace(/\s+/g, ' ').trim()
        skipped.push({
          stopId: stop.id,
          locationLabel,
          reason: `unparseable response: "${preview}${text.length > 80 ? '…' : ''}"`,
        })
        console.log(`[backfill-candidates] SKIP ${locationLabel} (${stop.id}): could not parse AI response`)
        continue
      }

      await prisma.stop.update({
        where: { id: stop.id },
        data: { campgroundCandidates: candidates },
      })
      backfilled += 1
      console.log(`[backfill-candidates] OK ${locationLabel} (${stop.id}): [${candidates.join(', ')}]`)
    } catch (err: any) {
      skipped.push({
        stopId: stop.id,
        locationLabel,
        reason: `AI call failed: ${err?.message ?? String(err)}`,
      })
      console.log(`[backfill-candidates] FAIL ${locationLabel} (${stop.id}): ${err?.message ?? err}`)
    }

    // Sequential pacing — keeps cost predictable and avoids spiky Anthropic
    // usage. 250ms × ~21 stops = ~5s overhead, negligible vs the call itself.
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
  }

  console.log('')
  console.log('=== Backfill summary ===')
  console.log(`Eligible stops examined:    ${needsBackfill.length}`)
  console.log(`Successfully backfilled:    ${backfilled}`)
  console.log(`Skipped (parse / AI error): ${skipped.length}`)
  if (skipped.length > 0) {
    console.log('Skipped detail:')
    for (const s of skipped) {
      console.log(`  - ${s.stopId} (${s.locationLabel}): ${s.reason}`)
    }
  }
}

main()
  .catch(err => {
    console.error('[backfill-candidates] fatal:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
