// Standard Google encoded-polyline decoder (FEAT-LVR-ROUTING).
//
// The Routes API returns route geometry as a standard Google encoded polyline
// (precision 1e-5) — NOT HERE's flexible polyline — so the LVR display path
// needs its own decoder. Same output shape as decodeFlexiblePolyline:
// an array of [lat, lng] pairs.

/** Decode a standard Google encoded polyline into [lat, lng] pairs. Returns []
 *  for an empty/invalid input rather than throwing — display code fails soft. */
export function decodeGooglePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = []
  if (typeof encoded !== 'string' || encoded.length === 0) return points
  let index = 0
  let lat = 0
  let lng = 0
  try {
    while (index < encoded.length) {
      for (const which of [0, 1] as const) {
        let result = 0
        let shift = 0
        let b: number
        do {
          b = encoded.charCodeAt(index++) - 63
          result |= (b & 0x1f) << shift
          shift += 5
        } while (b >= 0x20)
        const delta = result & 1 ? ~(result >> 1) : result >> 1
        if (which === 0) lat += delta
        else lng += delta
      }
      points.push([lat / 1e5, lng / 1e5])
    }
  } catch {
    return []
  }
  return points
}
