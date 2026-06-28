/**
 * seedHazards.ts — seed the high-confidence RV hazard restrictions (FEAT-HAZARD-WARN,
 * Phase 2 slice 1). Run by Benny against dev; CC does NOT run this.
 *
 *   npm run db:seed-hazards --prefix server
 *   (→ tsx --env-file=../.env src/scripts/seedHazards.ts, run from server/)
 *
 * IDEMPOTENT: each row upserts by a deterministic slug id (name+state), so
 * re-running updates in place and never duplicates. It does NOT delete rows not
 * in this list, so manually-added hazards survive.
 *
 * CORE PRINCIPLE: seed the REAL NUMERIC LIMIT; rig-dimension gating
 * (controllers/trips.ts hazardFiresForRig) decides whether a warning fires. The
 * spreadsheet's "affects a 42-ft coach?" human note is NEVER seeded.
 *
 * lat/lng are HAND-CURATED representative points (NOT runtime-geocoded — several
 * rows are multi-feature corridors that geocode poorly). The 25-mi corridor
 * buffer absorbs the coarseness. Points marked `// VERIFY` need Benny's review,
 * especially the long parkways / multi-tunnel regions where one point is a rough
 * stand-in for a whole corridor.
 *
 * confidence: only HIGH fires live warnings in slice 1 (see detectStopHazards).
 * MED rows (Iron Mountain, Cumberland Gap, Hampton Roads) are seeded but dormant.
 */
import { PrismaClient, HazardType, HazardConfidence } from '@prisma/client'

const prisma = new PrismaClient()

interface SeedHazard {
  name: string
  state: string
  lat: number
  lng: number
  hazardType: HazardType
  maxLengthFt?: number | null
  maxHeightFt?: number | null
  maxWidthFt?: number | null
  maxWeightLbs?: number | null
  gradePct?: number | null
  propaneBanned?: boolean
  confidence: HazardConfidence
  source: string
  roadDesignation?: string | null
}

// NOTE: no `message` column exists on the Hazard model — the user-facing warning
// text is composed from these fields at match time (composeHazardNote). The
// "Hampton Roads allowed-with-shutoff" nuance can't be stored verbatim yet; it's
// MED so it won't fire live in slice 1. P3 follow-on: add a Hazard.message column
// for verbatim spreadsheet wording + per-hazard nuance.
const HAZARDS: SeedHazard[] = [
  // ── Length bans ────────────────────────────────────────────────────────────
  { name: 'Going-to-the-Sun Road', state: 'MT', lat: 48.6960, lng: -113.7180, // VERIFY (Logan Pass)
    hazardType: HazardType.LENGTH_BAN, maxLengthFt: 21, maxWidthFt: 8, maxHeightFt: 10,
    confidence: HazardConfidence.HIGH, source: 'NPS', roadDesignation: 'GTSR' },
  { name: "Smugglers' Notch", state: 'VT', lat: 44.5530, lng: -72.7930, // VERIFY
    hazardType: HazardType.LENGTH_BAN, maxLengthFt: 40,
    confidence: HazardConfidence.HIGH, source: '23 VSA §1006b', roadDesignation: 'VT-108' },
  { name: 'Tail of the Dragon', state: 'TN/NC', lat: 35.4670, lng: -83.9230, // VERIFY (Deals Gap)
    hazardType: HazardType.LENGTH_BAN, maxLengthFt: 30,
    confidence: HazardConfidence.HIGH, source: 'advisory', roadDesignation: 'US-129' },
  { name: 'Independence Pass', state: 'CO', lat: 39.1080, lng: -106.5640, // VERIFY (summit)
    hazardType: HazardType.LENGTH_BAN, maxLengthFt: 35,
    confidence: HazardConfidence.HIGH, source: 'CDOT', roadDesignation: 'CO-82' },
  { name: 'Beartooth Highway', state: 'WY/MT', lat: 44.9700, lng: -109.4700, // VERIFY (Beartooth Pass)
    hazardType: HazardType.LENGTH_BAN, maxLengthFt: 40,
    confidence: HazardConfidence.HIGH, source: 'advisory', roadDesignation: 'US-212' },
  { name: 'Natchez Trace Parkway', state: 'MS/AL/TN', lat: 32.5000, lng: -89.8000, // VERIFY (long corridor — central MS stand-in)
    hazardType: HazardType.LENGTH_BAN, maxLengthFt: 32, // trailer limit; motorhome rule VERIFY
    confidence: HazardConfidence.HIGH, source: 'NPS', roadDesignation: 'Natchez Trace Pkwy' },
  { name: 'Garden State Parkway', state: 'NJ', lat: 40.0000, lng: -74.1500, // VERIFY (long corridor — central NJ stand-in)
    hazardType: HazardType.LENGTH_BAN, maxLengthFt: 55,
    confidence: HazardConfidence.HIGH, source: 'NJ DOT', roadDesignation: 'Garden State Pkwy' },

  // ── Width bans ─────────────────────────────────────────────────────────────
  { name: 'Needles Highway', state: 'SD', lat: 43.7780, lng: -103.4220, // VERIFY (Needles Eye Tunnel)
    hazardType: HazardType.WIDTH_BAN, maxWidthFt: 8, maxHeightFt: 11,
    confidence: HazardConfidence.HIGH, source: 'SD DOT', roadDesignation: 'SD-87' },
  { name: 'Iron Mountain Road', state: 'SD', lat: 43.8160, lng: -103.4520, // VERIFY (dims unconfirmed)
    hazardType: HazardType.WIDTH_BAN, maxWidthFt: 8, // VERIFY width + tunnel heights
    confidence: HazardConfidence.MED, source: 'SD DOT', roadDesignation: 'US-16A' },

  // ── Height bans ────────────────────────────────────────────────────────────
  { name: 'Merritt Parkway / Wilbur Cross Parkway', state: 'CT', lat: 41.2500, lng: -73.2000, // VERIFY (corridor)
    hazardType: HazardType.HEIGHT_BAN, maxHeightFt: 8,
    confidence: HazardConfidence.HIGH, source: 'CT DOT', roadDesignation: 'CT-15' },

  // ── Vehicle bans (RVs/trailers prohibited) ────────────────────────────────
  { name: 'Mount Washington Auto Road', state: 'NH', lat: 44.2580, lng: -71.3530, // VERIFY (base)
    hazardType: HazardType.VEHICLE_BAN,
    confidence: HazardConfidence.HIGH, source: 'Mt Washington Auto Road' },
  { name: 'Taconic State Parkway', state: 'NY', lat: 41.4000, lng: -73.7800, // VERIFY (corridor) — also a 9-ft height ban
    hazardType: HazardType.VEHICLE_BAN, maxHeightFt: 9,
    confidence: HazardConfidence.HIGH, source: 'NY DOT' },
  { name: 'NYC Parkways (Hutchinson, Saw Mill, etc.)', state: 'NY', lat: 40.9000, lng: -73.8200, // VERIFY (multi-parkway region)
    hazardType: HazardType.VEHICLE_BAN,
    confidence: HazardConfidence.HIGH, source: 'NYC DOT' },

  // ── Propane tunnels ────────────────────────────────────────────────────────
  { name: 'Baltimore Harbor & Fort McHenry Tunnels', state: 'MD', lat: 39.2630, lng: -76.5790, // VERIFY (Ft McHenry)
    hazardType: HazardType.PROPANE_TUNNEL, propaneBanned: true, maxWidthFt: 8,
    confidence: HazardConfidence.HIGH, source: 'MDTA', roadDesignation: 'I-95 / I-895' },
  { name: 'Boston Harbor Tunnels (Ted Williams, Callahan, Sumner)', state: 'MA', lat: 42.3600, lng: -71.0400, // VERIFY (multi-tunnel)
    hazardType: HazardType.PROPANE_TUNNEL, propaneBanned: true,
    confidence: HazardConfidence.HIGH, source: 'MassDOT' },
  { name: 'NYC East River & Hudson Tunnels (Lincoln, Holland, etc.)', state: 'NY/NJ', lat: 40.7560, lng: -74.0030, // VERIFY (multi-tunnel region)
    hazardType: HazardType.PROPANE_TUNNEL, propaneBanned: true,
    confidence: HazardConfidence.HIGH, source: 'PANYNJ / NYC DOT' },
  { name: 'Cumberland Gap Tunnel', state: 'KY/TN', lat: 36.6030, lng: -83.6750, // VERIFY
    hazardType: HazardType.PROPANE_TUNNEL, propaneBanned: true,
    confidence: HazardConfidence.MED, source: 'advisory', roadDesignation: 'US-25E' },
  { name: 'Hampton Roads & Chesapeake Bay Bridge-Tunnels', state: 'VA', lat: 37.0000, lng: -76.1500, // VERIFY (multi-crossing; propane allowed WITH shutoff — see P3 message-field note)
    hazardType: HazardType.PROPANE_TUNNEL, propaneBanned: true,
    confidence: HazardConfidence.MED, source: 'advisory' },
]

/** Deterministic id so re-runs upsert in place (mirrors prisma/seed.ts RigDatabase). */
function hazardId(h: SeedHazard): string {
  return `${h.name}-${h.state}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

async function main() {
  console.log(`Seeding ${HAZARDS.length} hazard(s)...`)
  for (const h of HAZARDS) {
    const id = hazardId(h)
    const data = {
      name: h.name,
      state: h.state,
      lat: h.lat,
      lng: h.lng,
      hazardType: h.hazardType,
      maxLengthFt: h.maxLengthFt ?? null,
      maxHeightFt: h.maxHeightFt ?? null,
      maxWidthFt: h.maxWidthFt ?? null,
      maxWeightLbs: h.maxWeightLbs ?? null,
      gradePct: h.gradePct ?? null,
      propaneBanned: h.propaneBanned ?? false,
      confidence: h.confidence,
      source: h.source,
      roadDesignation: h.roadDesignation ?? null,
    }
    await prisma.hazard.upsert({ where: { id }, update: data, create: { id, ...data } })
    console.log(`  ✓ ${h.confidence.padEnd(4)} ${h.hazardType.padEnd(14)} ${h.name} (${h.state})`)
  }
  const high = HAZARDS.filter(h => h.confidence === 'HIGH').length
  console.log(`Done. ${HAZARDS.length} hazard(s) seeded — ${high} HIGH (fire live), ${HAZARDS.length - high} MED (dormant in slice 1).`)
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
