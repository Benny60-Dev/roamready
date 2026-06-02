import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Tent, Map, Mountain, Leaf, Search, MapPin } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  OHV_NATIONAL_LINKS,
  OHV_STATE_RESOURCES,
  OHV_RESOURCE_DISCLAIMER,
  type OhvResourceLink,
  type OhvStateResource,
} from '../constants/ohvStateResources'
import {
  OHV_STATE_EXTRA_LINKS,
  type OhvStateExtra,
} from '../constants/ohvStateExtraLinks'

// Curated OHV resources, shown when the live Rec.gov search is empty/blocked.
// Presentational only — no data fetching. The page passes the user's state
// (reverse-geocoded from GPS) for the "Your state" highlight; null/no-match
// just hides that one card.

// A relevant lucide icon per national link (data file has no icon field).
const NATIONAL_ICON: Record<string, LucideIcon> = {
  'Recreation.gov': Tent,
  'USFS Motor Vehicle Use Maps': Map,
  'BLM Off-Highway Vehicle': Mountain,
  'Tread Lightly!': Leaf,
}

// Supplemental per-state links (rider associations, "where to ride", etc.),
// rendered beneath the single official authority. Presentational only — same
// inline-anchor idiom as the rest of the block. Renders nothing when a state
// has no extra record. The cards above are themselves <a> elements, so these
// must render as siblings, never nested anchors.
function OhvExtraLinks({ extra, compact }: { extra?: OhvStateExtra; compact?: boolean }) {
  if (!extra) return null
  return (
    <div className="space-y-1.5 mt-2">
      {extra.note && <p className="text-gray-500 text-xs">{extra.note}</p>}
      {extra.links.map(link => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-2 p-2.5 rounded-lg border border-gray-200 hover:bg-[#E0F0F4] transition-colors"
        >
          <div className="flex-1 min-w-0">
            <div className={`flex items-center gap-1 font-medium text-gray-900 ${compact ? 'text-xs' : 'text-sm'}`}>
              {link.name}
              <ExternalLink size={compact ? 11 : 12} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
            </div>
          </div>
        </a>
      ))}
    </div>
  )
}

const MAX_MATCHES = 8

export default function OhvResourceBlock({ userState }: { userState?: string | null }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<OhvStateResource | null>(null)
  // Once the user types or picks a state, stop letting a late-arriving GPS
  // result override their choice (the geocode resolves async after mount).
  const [touched, setTouched] = useState(false)

  // GPS-derived state, matched by full name (case-insensitive), same as before.
  const gpsMatch = useMemo<OhvStateResource | undefined>(
    () =>
      userState
        ? OHV_STATE_RESOURCES.find(r => r.state.toLowerCase() === userState.trim().toLowerCase())
        : undefined,
    [userState],
  )

  // Pre-fill from GPS on mount / when it resolves, unless the user already acted.
  useEffect(() => {
    if (!touched && gpsMatch) {
      setSelected(gpsMatch)
      setQuery(gpsMatch.state)
    }
  }, [gpsMatch, touched])

  const q = query.trim().toLowerCase()
  // Show matches while the user is actively typing a query that differs from
  // the currently-selected state's name (so a selection collapses the list).
  const showMatches = q.length >= 1 && q !== (selected?.state.toLowerCase() ?? '')

  const matches = useMemo<OhvStateResource[]>(() => {
    if (!showMatches) return []
    return OHV_STATE_RESOURCES
      .filter(r => r.state.toLowerCase().includes(q))
      .sort((a, b) => {
        // Names that START WITH the query rank above those that merely contain it.
        const aStarts = a.state.toLowerCase().startsWith(q) ? 0 : 1
        const bStarts = b.state.toLowerCase().startsWith(q) ? 0 : 1
        return aStarts - bStarts || a.state.localeCompare(b.state)
      })
      .slice(0, MAX_MATCHES)
  }, [showMatches, q])

  const selectState = (r: OhvStateResource) => {
    setSelected(r)
    setQuery(r.state)
    setTouched(true)
  }

  return (
    <div className="space-y-5">
      {/* 1 — Nationwide resources */}
      <div>
        <h2 className="text-sm font-medium text-gray-700 mb-2">Nationwide resources</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {OHV_NATIONAL_LINKS.map((link: OhvResourceLink) => {
            const Icon = NATIONAL_ICON[link.name] ?? ExternalLink
            return (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:bg-[#E0F0F4] transition-colors"
              >
                <Icon size={18} className="text-[#1F6F8B] mt-0.5 flex-shrink-0" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1 text-sm font-medium text-[#1F6F8B]">
                    {link.name}
                    <ExternalLink size={12} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">{link.description}</p>
                </div>
              </a>
            )
          })}
        </div>
      </div>

      {/* 2 — Find your state (type-ahead). Pre-filled from GPS on load; the
            result panel folds in the former "Your state" highlight so a state
            is never shown twice. */}
      <div>
        <label htmlFor="ohv-state-search" className="block text-sm font-medium text-gray-700 mb-2">
          Find your state
        </label>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            id="ohv-state-search"
            type="text"
            value={query}
            onChange={e => {
              const v = e.target.value
              setQuery(v)
              setTouched(true)
              // Emptying the box clears the manual selection's result panel; if a
              // GPS state exists, fall back to it (the on-load panel), else none.
              if (v.trim().length === 0) setSelected(gpsMatch ?? null)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && matches.length === 1) {
                e.preventDefault()
                selectState(matches[0])
              }
            }}
            placeholder="Type a state name…"
            autoComplete="off"
            className="input pl-9"
          />
        </div>

        {/* Match list — sits directly under the input (not hidden by the keyboard) */}
        {showMatches && (
          matches.length === 0 ? (
            <p className="text-sm text-gray-400 mt-2">No match — check spelling.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {matches.map(r => (
                <li key={r.abbr}>
                  <button
                    type="button"
                    onClick={() => selectState(r)}
                    className="w-full text-left flex items-center gap-2 p-2.5 min-h-[44px] rounded-lg border border-gray-200 hover:bg-[#E0F0F4] transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900">{r.state}</div>
                      <p className="text-xs text-gray-500 truncate">{r.agency}</p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )
        )}

        {/* Result panel — selected state's authority + extras (+ note). */}
        {selected && !showMatches && (
          <div className="mt-3">
            <a
              href={selected.url}
              target="_blank"
              rel="noopener noreferrer"
              className="card border-2 border-[#1F6F8B] flex items-start gap-3 hover:bg-[#E0F0F4] transition-colors"
            >
              <MapPin size={18} className="text-[#1F6F8B] mt-0.5 flex-shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1 text-sm font-medium text-gray-900">
                  {selected.agency}
                  <ExternalLink size={12} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
                </div>
                <p className="text-xs text-gray-500 mt-0.5">{selected.state}</p>
              </div>
            </a>
            <OhvExtraLinks extra={OHV_STATE_EXTRA_LINKS[selected.abbr]} />
          </div>
        )}
      </div>

      {/* 4 — Honest disclaimer */}
      <p className="text-gray-500 text-xs">{OHV_RESOURCE_DISCLAIMER}</p>
    </div>
  )
}
