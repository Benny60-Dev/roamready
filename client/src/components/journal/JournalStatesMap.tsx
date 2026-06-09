import { useMemo, useState } from 'react'
import { US_STATES, US_ALBERS_VIEWBOX } from './usStatesGeo'
import { SMALL_STATES } from './stateUtils'
import { projectAlbersUsa } from './albersUsa'
import type { JournalEntry } from '../../types'

/**
 * Visited-states choropleth (Journal map, step 6). Renders the bundled,
 * pre-projected AlbersUSA paths — no runtime CDN fetch, no runtime d3. This
 * component is the heavy one (carries usStatesGeo), so it's lazy-loaded by
 * VisitedStatesBanner and lands in its own code-split chunk.
 *
 * Tiers (v1, derived in JournalTabContent):
 *   overnight   → solid RV Blue (#1F6F8B)
 *   passthrough → diagonal RV-Blue stripe pattern
 *   not-yet     → soft gray
 * Pine (#3E5540) is reserved and intentionally never used here.
 *
 * Tapping a state is display-only for v1 (shows name + status below the map) —
 * no manual override yet.
 */

const RV_BLUE = '#1F6F8B'
const GRAY_NOT_YET = '#E8EAED'
const STROKE = '#FFFFFF'
// Journal pin = Sunset Gold with a white ring — reads on both RV-Blue-filled
// and gray states. Pine (#3E5540) stays reserved and is not used.
const PIN_FILL = '#F7A829'

type Tier = 'overnight' | 'passthrough' | 'none'

interface Pin {
  id: string
  x: number
  y: number
  title: string
  placeName: string | null
}

interface Props {
  overnight: Set<string>
  passthrough: Set<string>
  /** Count of visited states (overnight ∪ passthrough), excluding DC, of 50. */
  visitedCount: number
  /** Full journal entry set — projected to pins when showPins is on. */
  entries: JournalEntry[]
  showPins: boolean
}

function tierLabel(tier: Tier): string {
  return tier === 'overnight' ? 'Stayed overnight' : tier === 'passthrough' ? 'Passed through' : 'Not visited yet'
}

export default function JournalStatesMap({ overnight, passthrough, visitedCount, entries, showPins }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedPin, setSelectedPin] = useState<Pin | null>(null)

  // Project entries with coordinates into the locked AlbersUSA space. Entries
  // with null lat/lng (freeform / un-backfilled) or that project outside the US
  // are skipped. Memoized so we don't reproject on every render.
  const pins = useMemo<Pin[]>(() => {
    const out: Pin[] = []
    for (const e of entries) {
      if (e.lat == null || e.lng == null) continue
      const xy = projectAlbersUsa(e.lng, e.lat)
      if (!xy) continue
      out.push({
        id: e.id,
        x: xy[0],
        y: xy[1],
        title: e.title?.trim() || 'Journal entry',
        placeName: e.placeName ?? null,
      })
    }
    return out
  }, [entries])

  function tierOf(code: string): Tier {
    if (overnight.has(code)) return 'overnight'
    if (passthrough.has(code)) return 'passthrough'
    return 'none'
  }

  function fillFor(tier: Tier): string {
    if (tier === 'overnight') return RV_BLUE
    if (tier === 'passthrough') return 'url(#rr-stripe)'
    return GRAY_NOT_YET
  }

  const selectedState = selected ? US_STATES.find(s => s.code === selected) : null
  const selectedTier = selected ? tierOf(selected) : null

  return (
    <div>
      {/* Counter */}
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-2xl font-semibold text-[#1F6F8B]">{visitedCount}</span>
        <span className="text-sm text-gray-500">of 50 states</span>
      </div>

      <svg
        viewBox={US_ALBERS_VIEWBOX}
        className="w-full h-auto"
        role="img"
        aria-label={`United States map — ${visitedCount} of 50 states visited`}
      >
        <defs>
          {/* Diagonal RV-Blue stripe = passed-through. */}
          <pattern
            id="rr-stripe"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill="#E0F0F4" />
            <rect width="2.5" height="6" fill={RV_BLUE} />
          </pattern>
        </defs>

        {/* State fills */}
        {US_STATES.map(s => {
          const tier = tierOf(s.code)
          return (
            <path
              key={s.code}
              d={s.d}
              fill={fillFor(tier)}
              stroke={STROKE}
              strokeWidth={0.75}
              style={{ cursor: 'pointer' }}
              onClick={() => setSelected(s.code)}
              aria-label={`${s.name}: ${tierLabel(tier)}`}
            >
              <title>{`${s.name} — ${tierLabel(tier)}`}</title>
            </path>
          )
        })}

        {/* Tap-target dots for tiny / dense-Northeast states (incl. DC). */}
        {US_STATES.filter(s => SMALL_STATES.has(s.code)).map(s => {
          const tier = tierOf(s.code)
          return (
            <circle
              key={`dot-${s.code}`}
              cx={s.cx}
              cy={s.cy}
              r={5}
              fill={fillFor(tier)}
              stroke={STROKE}
              strokeWidth={1}
              style={{ cursor: 'pointer' }}
              onClick={() => setSelected(s.code)}
              aria-label={`${s.name}: ${tierLabel(tier)}`}
            >
              <title>{`${s.name} — ${tierLabel(tier)}`}</title>
            </circle>
          )
        })}

        {/* Journal pins (memory-lane layer) — on top of the state fills. Tap
            shows the entry title + place in the caption below. */}
        {showPins &&
          pins.map(p => (
            <circle
              key={`pin-${p.id}`}
              cx={p.x}
              cy={p.y}
              r={4}
              fill={PIN_FILL}
              stroke={STROKE}
              strokeWidth={1.5}
              style={{ cursor: 'pointer' }}
              onClick={() => setSelectedPin(p)}
              aria-label={p.placeName ? `${p.title} — ${p.placeName}` : p.title}
            >
              <title>{p.placeName ? `${p.title} — ${p.placeName}` : p.title}</title>
            </circle>
          ))}
      </svg>

      {/* Caption (display-only): a tapped pin takes precedence over a tapped
          state. */}
      <div className="mt-1 min-h-5 text-center text-xs text-gray-600">
        {selectedPin ? (
          <span>
            <span className="font-medium text-gray-900">{selectedPin.title}</span>
            {selectedPin.placeName && <span className="text-gray-500"> · {selectedPin.placeName}</span>}
          </span>
        ) : selectedState && selectedTier ? (
          <span>
            <span className="font-medium text-gray-900">{selectedState.name}</span>
            {selectedState.code === 'DC' && <span className="text-gray-400"> (not counted)</span>}
            {' — '}
            {tierLabel(selectedTier)}
          </span>
        ) : (
          <span className="text-gray-400">
            {showPins ? 'Tap a state or a pin for details' : 'Tap a state to see its status'}
          </span>
        )}
      </div>

      {/* Legend */}
      <div className="mt-2 flex items-center justify-center gap-4 flex-wrap text-xs text-gray-600">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: RV_BLUE }} />
          Overnight
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm border border-gray-200"
            style={{
              backgroundImage: `repeating-linear-gradient(45deg, ${RV_BLUE} 0 2px, #E0F0F4 2px 5px)`,
            }}
          />
          Passed through
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: GRAY_NOT_YET }} />
          Not yet
        </span>
        {showPins && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full border border-white"
              style={{ background: PIN_FILL, boxShadow: '0 0 0 0.5px #d1d5db' }}
            />
            Journal entry
          </span>
        )}
      </div>
    </div>
  )
}
