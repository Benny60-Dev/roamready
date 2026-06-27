// Corridor-waypoint sampling for the HERE route-display integration.
//
// HERE's flexible polyline decodes to hundreds of [lat,lng] points — far too
// many to feed into a Google Maps directions URL (2048-char cap) or a
// computeRoutes `intermediates` list (waypoint ceiling + Advanced-SKU billing).
// We reduce the polyline to a handful of corridor-PINNING waypoints that keep the
// route's decision-point vertices (where it actually turns / picks a road) and
// drop the redundant near-collinear points along straightaways.
//
// Algorithm: Ramer–Douglas–Peucker (RDP). We don't pick a fixed epsilon — we
// binary-search epsilon until the simplified interior point count fits the
// requested budget, so we always return the MOST significant ≤N waypoints.

export interface LatLng {
  lat: number
  lng: number
}

/** Perpendicular distance (in degrees, planar approximation — adequate at a
 *  single leg's scale for ranking vertex significance) from point p to the line
 *  segment a→b. */
function perpDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const [py, px] = p
  const [ay, ax] = a
  const [by, bx] = b
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0 && dy === 0) {
    // a and b coincide → plain point distance.
    return Math.hypot(px - ax, py - ay)
  }
  // Distance from p to the infinite line through a,b (numerator is the 2× area
  // of the triangle; denominator is the base length).
  const num = Math.abs(dy * px - dx * py + bx * ay - by * ax)
  const den = Math.hypot(dx, dy)
  return num / den
}

/** Ramer–Douglas–Peucker. Returns the kept points (endpoints always kept) for a
 *  given epsilon. Iterative stack (no recursion) to stay safe on long polylines. */
function rdp(points: [number, number][], epsilon: number): [number, number][] {
  const n = points.length
  if (n <= 2) return points.slice()
  const keep = new Array<boolean>(n).fill(false)
  keep[0] = true
  keep[n - 1] = true
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [start, end] = stack.pop()!
    let maxDist = -1
    let idx = -1
    for (let i = start + 1; i < end; i++) {
      const d = perpDistance(points[i], points[start], points[end])
      if (d > maxDist) {
        maxDist = d
        idx = i
      }
    }
    if (maxDist > epsilon && idx !== -1) {
      keep[idx] = true
      stack.push([start, idx])
      stack.push([idx, end])
    }
  }
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i])
  return out
}

/**
 * Reduce a decoded HERE polyline to ≤ maxInterior corridor waypoints, dropping
 * the first and last points (those are the leg endpoints / stops — Google gets
 * them as origin & destination, never as waypoints). Returns the interior
 * decision-point vertices, in route order.
 *
 * Binary-searches the RDP epsilon so the result lands at (or just under) the
 * budget — keeping the MOST significant turns rather than a blind every-Nth
 * decimation. Returns [] for a degenerate polyline so callers fall back cleanly.
 */
export function sampleCorridorWaypoints(
  coords: Array<[number, number]>,
  maxInterior: number,
): LatLng[] {
  if (!Array.isArray(coords) || coords.length < 3 || maxInterior <= 0) return []

  // If already small enough, take the interior points as-is.
  const interiorCount = coords.length - 2
  if (interiorCount <= maxInterior) {
    return coords.slice(1, -1).map(([lat, lng]) => ({ lat, lng }))
  }

  // Binary-search epsilon: larger epsilon → fewer kept points. Find the smallest
  // epsilon whose interior-kept count is ≤ maxInterior (most detail that fits).
  let lo = 0
  // Upper bound: span of the bounding box is a safe "drop everything" epsilon.
  let hi = 0
  for (const [lat, lng] of coords) hi = Math.max(hi, Math.abs(lat), Math.abs(lng))
  hi = hi || 1
  let best: [number, number][] = [coords[0], coords[coords.length - 1]]
  for (let iter = 0; iter < 40; iter++) {
    const mid = (lo + hi) / 2
    const simplified = rdp(coords, mid)
    const interior = simplified.length - 2
    if (interior <= maxInterior) {
      best = simplified
      hi = mid // try to keep MORE detail (smaller epsilon)
    } else {
      lo = mid
    }
    if (hi - lo < 1e-9) break
  }
  return best.slice(1, -1).map(([lat, lng]) => ({ lat, lng }))
}
