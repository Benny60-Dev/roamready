import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Tent, Map, Mountain, Leaf, Search, MapPin, ChevronDown } from 'lucide-react'
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
  // Combobox dropdown open/closed. Independent of selection — opening to browse
  // never changes the current result panel until a row is picked.
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  // Click-outside (scoped to this component) closes the dropdown without
  // changing the selection.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const q = query.trim().toLowerCase()
  // Searching = actively typing a query that differs from the selected state's
  // name. Drives SEARCH vs BROWSE mode in the dropdown and hides the result
  // panel mid-search (same gate the type-ahead used before).
  const isSearching = q.length >= 1 && q !== (selected?.state.toLowerCase() ?? '')

  const matches = useMemo<OhvStateResource[]>(() => {
    if (!isSearching) return []
    return OHV_STATE_RESOURCES
      .filter(r => r.state.toLowerCase().includes(q))
      .sort((a, b) => {
        // Names that START WITH the query rank above those that merely contain it.
        const aStarts = a.state.toLowerCase().startsWith(q) ? 0 : 1
        const bStarts = b.state.toLowerCase().startsWith(q) ? 0 : 1
        return aStarts - bStarts || a.state.localeCompare(b.state)
      })
      .slice(0, MAX_MATCHES)
  }, [isSearching, q])

  // Full list for BROWSE mode, alphabetical by full state name.
  const allStatesAZ = useMemo<OhvStateResource[]>(
    () => [...OHV_STATE_RESOURCES].sort((a, b) => a.state.localeCompare(b.state)),
    [],
  )

  const selectState = (r: OhvStateResource) => {
    setSelected(r)
    setQuery(r.state)
    setTouched(true)
    setOpen(false)
  }

  // One row renderer for browse + filtered lists (same chrome, >=44px tap target).
  const stateRow = (r: OhvStateResource) => (
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
  )

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

      {/* 2 — Find your state (combobox). Type to filter, or open the caret to
            browse the full A-Z list with the GPS state pinned on top. Pre-filled
            from GPS on load; the result panel folds in the former "Your state"
            highlight so a state is never shown twice in the result area. */}
      <div ref={rootRef}>
        <label htmlFor="ohv-state-search" className="block text-sm font-medium text-gray-700 mb-2">
          Find your state
        </label>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            id="ohv-state-search"
            type="text"
            value={query}
            onFocus={() => { if (query.trim().length === 0) setOpen(true) }}
            onChange={e => {
              const v = e.target.value
              setQuery(v)
              setTouched(true)
              setOpen(true)
              // Emptying the box clears the manual selection's result panel; if a
              // GPS state exists, fall back to it (the on-load panel), else none.
              if (v.trim().length === 0) setSelected(gpsMatch ?? null)
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') { setOpen(false); return }
              if (e.key === 'Enter' && matches.length === 1) {
                e.preventDefault()
                selectState(matches[0])
              }
            }}
            placeholder="Type a state name…"
            autoComplete="off"
            className="input pl-9 pr-10"
          />
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-label="Browse states"
            aria-expanded={open}
            className="absolute right-0 top-0 h-full px-2.5 flex items-center text-gray-400 hover:text-[#1F6F8B]"
          >
            <ChevronDown size={18} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        </div>

        {/* Dropdown — normal flow directly under the input (not hidden by the
            on-screen keyboard), height-capped so a 50-row list never pushes the
            disclaimer down the page. */}
        {open && (
          <div className="mt-2 rounded-lg border border-gray-200 overflow-hidden">
            <ul className="max-h-60 overflow-y-auto p-1 space-y-1">
              {isSearching ? (
                matches.length === 0 ? (
                  <li><p className="text-sm text-gray-400 p-2.5">No match — check spelling.</p></li>
                ) : (
                  matches.map(stateRow)
                )
              ) : (
                <>
                  {gpsMatch && (
                    <>
                      {/* Pinned GPS state — same emphasis chrome as the result
                          panel. Also appears in its normal A-Z spot below; the
                          pin is a shortcut, not a removal. */}
                      <li>
                        <button
                          type="button"
                          onClick={() => selectState(gpsMatch)}
                          className="w-full text-left flex items-center gap-2 p-2.5 min-h-[44px] rounded-lg border-2 border-[#1F6F8B] hover:bg-[#E0F0F4] transition-colors"
                        >
                          <MapPin size={16} className="text-[#1F6F8B] flex-shrink-0" aria-hidden="true" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium text-gray-900">{gpsMatch.state}</span>
                              <span className="badge bg-[#E0F0F4] text-[#1F6F8B] text-[10px]">your location</span>
                            </div>
                            <p className="text-xs text-gray-500 truncate">{gpsMatch.agency}</p>
                          </div>
                        </button>
                      </li>
                      <li className="px-2 pt-1.5 pb-0.5 text-[11px] uppercase tracking-wide text-gray-400">All states</li>
                    </>
                  )}
                  {allStatesAZ.map(stateRow)}
                </>
              )}
            </ul>
          </div>
        )}

        {/* Result panel — selected state's authority + extras (+ note). */}
        {selected && !isSearching && (
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
