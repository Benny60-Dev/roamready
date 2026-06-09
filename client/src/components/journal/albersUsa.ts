import { US_ALBERS_PROJECTION } from './usStatesGeo'

/**
 * Dependency-free port of d3-geo's composite geoAlbersUsa — lower-48 Albers
 * conic + Alaska inset + Hawaii inset, with the same clip-region cascade so AK
 * and HI land in their insets (not approximated). Bound to US_ALBERS_PROJECTION
 * (the fitted scale + translate emitted by genUsStatesGeo.mjs from the SAME
 * geoAlbersUsa().fitSize([960,600]) that generated the state paths), so a
 * projected lat/lng lands in the exact 960×600 coordinate space of the map.
 *
 * Verified to match d3-geo to 0px for continental/AK/HI points (and null for
 * points outside the US). Keeps d3-geo OUT of the runtime bundle — the projector
 * math (d3's MIT albersUsa) is inlined here.
 *
 * project(lng, lat) → [x, y] in the viewBox, or null when the point is outside
 * the three US regions (such pins are skipped).
 */

const RAD = Math.PI / 180
const EPS = 1e-6

type Raw = (lambda: number, phi: number) => [number, number]

// d3 geoConicEqualAreaRaw for a pair of standard parallels (degrees).
function conicEqualAreaRaw(parallels: [number, number]): Raw {
  const y0 = parallels[0] * RAD
  const y1 = parallels[1] * RAD
  const sy0 = Math.sin(y0)
  const n = (sy0 + Math.sin(y1)) / 2
  const c = 1 + sy0 * (2 * n - sy0)
  const r0 = Math.sqrt(c) / n
  return (lambda, phi) => {
    const r = Math.sqrt(c - 2 * n * Math.sin(phi)) / n
    const t = lambda * n
    return [r * Math.sin(t), r0 - r * Math.cos(t)]
  }
}

interface Sub {
  raw: Raw
  dLambda: number // lambda-only rotation, radians
  scale: number
  dx: number
  dy: number
  clip: [number, number, number, number] // x0, y0, x1, y1 (composite pixel space)
}

function makeSub(opts: {
  parallels: [number, number]
  rotateLngDeg: number
  centerLngDeg: number
  centerLatDeg: number
  scale: number
  translate: [number, number]
  clip: [number, number, number, number]
}): Sub {
  const raw = conicEqualAreaRaw(opts.parallels)
  // center is projected WITHOUT rotation (d3 recenter()), then offsets the
  // translate so the center maps to opts.translate.
  const cr = raw(opts.centerLngDeg * RAD, opts.centerLatDeg * RAD)
  return {
    raw,
    dLambda: opts.rotateLngDeg * RAD,
    scale: opts.scale,
    dx: opts.translate[0] - opts.scale * cr[0],
    dy: opts.translate[1] + opts.scale * cr[1],
    clip: opts.clip,
  }
}

const K = US_ALBERS_PROJECTION.scale
const [TX, TY] = US_ALBERS_PROJECTION.translate

// The three sub-projections + clip rectangles, exactly as d3 albersUsa wires
// them (alaska at 0.35× scale; clip rects in lower-48-scale units).
const SUBS: Sub[] = [
  makeSub({
    parallels: [29.5, 45.5],
    rotateLngDeg: 96,
    centerLngDeg: -0.6,
    centerLatDeg: 38.7,
    scale: K,
    translate: [TX, TY],
    clip: [TX - 0.455 * K, TY - 0.238 * K, TX + 0.455 * K, TY + 0.238 * K],
  }),
  makeSub({
    parallels: [55, 65],
    rotateLngDeg: 154,
    centerLngDeg: -2,
    centerLatDeg: 58.5,
    scale: 0.35 * K,
    translate: [TX - 0.307 * K, TY + 0.201 * K],
    clip: [TX - 0.425 * K + EPS, TY + 0.12 * K + EPS, TX - 0.214 * K - EPS, TY + 0.234 * K - EPS],
  }),
  makeSub({
    parallels: [8, 18],
    rotateLngDeg: 157,
    centerLngDeg: -3,
    centerLatDeg: 19.9,
    scale: K,
    translate: [TX - 0.205 * K, TY + 0.212 * K],
    clip: [TX - 0.214 * K + EPS, TY + 0.166 * K + EPS, TX - 0.115 * K - EPS, TY + 0.234 * K - EPS],
  }),
]

function projectSub(lng: number, lat: number, s: Sub): [number, number] {
  let lambda = lng * RAD + s.dLambda
  if (lambda > Math.PI) lambda -= 2 * Math.PI
  else if (lambda < -Math.PI) lambda += 2 * Math.PI
  const r = s.raw(lambda, lat * RAD)
  return [s.dx + s.scale * r[0], s.dy - s.scale * r[1]]
}

/** Project lng/lat into the locked AlbersUSA viewBox, or null if outside the US
 *  (the lower-48 / Alaska / Hawaii regions), in which case the caller skips it. */
export function projectAlbersUsa(lng: number, lat: number): [number, number] | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  for (const s of SUBS) {
    const [px, py] = projectSub(lng, lat, s)
    if (px >= s.clip[0] && px <= s.clip[2] && py >= s.clip[1] && py <= s.clip[3]) {
      return [px, py]
    }
  }
  return null
}
