// Flexible Polyline decoder — vendored (not an npm dependency, to avoid touching
// node_modules / the .bin junction; see CLAUDE.md node_modules safety rules).
//
// HERE Routing API v8 returns each section's geometry as a "flexible polyline"
// string (NOT Google's encoded polyline — a different, HERE-specific format).
// We need the decoded [lat, lng] point list so we can map each routing `action`
// (which carries a `duration` + an `offset` index into this point list) into the
// {durationSec, startLat/Lng, endLat/Lng} LegStep shape that planLegSplits'
// interpolateSplitPoint already consumes.
//
// Algorithm ported from HERE's published reference implementation
// (github.com/heremaps/flexible-polyline, Apache-2.0). Only the DECODE path is
// vendored — encoding is not needed. The decode/continuation bit math is the
// reference algorithm verbatim; the char table is built from ENCODING_TABLE at
// load time (more obviously-correct than transcribing the magic lookup array).

const ENCODING_TABLE =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

const DECODING_TABLE: Record<string, number> = {}
for (let i = 0; i < ENCODING_TABLE.length; i++) DECODING_TABLE[ENCODING_TABLE[i]] = i

function decodeChar(char: string): number {
  const v = DECODING_TABLE[char]
  if (v === undefined) throw new Error(`Invalid flexible-polyline char: ${char}`)
  return v
}

/** Unpack the base-64 varint stream into the raw unsigned values (header + deltas). */
function decodeUnsignedValues(encoded: string): bigint[] {
  let result = 0n
  let shift = 0n
  const out: bigint[] = []
  for (const ch of encoded) {
    const value = BigInt(decodeChar(ch))
    result |= (value & 0x1fn) << shift
    if ((value & 0x20n) === 0n) {
      out.push(result)
      result = 0n
      shift = 0n
    } else {
      shift += 5n
    }
  }
  return out
}

/** Zig-zag decode: even → +n/2, odd → -(n+1)/2. */
function toSigned(value: bigint): bigint {
  let v = value
  if ((v & 1n) !== 0n) v = ~v
  v >>= 1n
  return v
}

interface FlexHeader {
  precision: number
  thirdDim: number
  thirdDimPrecision: number
}

function decodeHeader(version: bigint, encodedHeader: bigint): FlexHeader {
  if (version !== 1n) throw new Error(`Unsupported flexible-polyline version: ${version}`)
  const headerNumber = encodedHeader
  const precision = Number(headerNumber & 15n)
  const thirdDim = Number((headerNumber >> 4n) & 7n)
  const thirdDimPrecision = Number((headerNumber >> 7n) & 15n)
  return { precision, thirdDim, thirdDimPrecision }
}

/**
 * Decode a HERE flexible-polyline string into an ordered list of [lat, lng]
 * pairs (any 3rd dimension — elevation etc. — is decoded to advance the stream
 * correctly but dropped from the result; we only need lat/lng for split points).
 * Returns [] for empty/invalid input rather than throwing, so a malformed
 * polyline degrades to "no usable steps" (caller then falls back) instead of
 * blowing up the planning request.
 */
export function decodeFlexiblePolyline(encoded: string): Array<[number, number]> {
  if (!encoded || encoded.length < 2) return []
  try {
    const decoder = decodeUnsignedValues(encoded)
    const header = decodeHeader(decoder[0], decoder[1])
    const factorDegree = 10 ** header.precision
    const hasThirdDim = header.thirdDim > 0

    let lastLat = 0
    let lastLng = 0
    const res: Array<[number, number]> = []

    let i = 2
    const stride = hasThirdDim ? 3 : 2
    for (; i + stride - 1 < decoder.length; i += stride) {
      lastLat += Number(toSigned(decoder[i]))
      lastLng += Number(toSigned(decoder[i + 1]))
      // decoder[i + 2] (3rd dim delta) intentionally skipped — see doc comment.
      res.push([lastLat / factorDegree, lastLng / factorDegree])
    }
    return res
  } catch {
    return []
  }
}
