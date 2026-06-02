import { useState } from 'react'
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

export default function OhvResourceBlock({ userState }: { userState?: string | null }) {
  const [query, setQuery] = useState('')

  const matchedState: OhvStateResource | undefined = userState
    ? OHV_STATE_RESOURCES.find(r => r.state.toLowerCase() === userState.trim().toLowerCase())
    : undefined

  const q = query.trim().toLowerCase()
  const filtered = q
    ? OHV_STATE_RESOURCES.filter(r => r.state.toLowerCase().includes(q))
    : OHV_STATE_RESOURCES

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

      {/* 2 — "Your state" highlight (only when GPS-derived state matches a record) */}
      {matchedState && (
        <div>
          <h2 className="text-sm font-medium text-gray-700 mb-2">Your state</h2>
          <a
            href={matchedState.url}
            target="_blank"
            rel="noopener noreferrer"
            className="card border-2 border-[#1F6F8B] flex items-start gap-3 hover:bg-[#E0F0F4] transition-colors"
          >
            <MapPin size={18} className="text-[#1F6F8B] mt-0.5 flex-shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1 text-sm font-medium text-gray-900">
                {matchedState.agency}
                <ExternalLink size={12} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{matchedState.state}</p>
            </div>
          </a>
          <OhvExtraLinks extra={OHV_STATE_EXTRA_LINKS[matchedState.abbr]} />
        </div>
      )}

      {/* 3 — Browse all states */}
      <div>
        <div className="flex items-center justify-between mb-2 gap-2">
          <h2 className="text-sm font-medium text-gray-700">Browse all states</h2>
          <span className="text-xs text-gray-400 flex-shrink-0">
            {filtered.length} OHV program{filtered.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Find your state…"
            aria-label="Find your state"
            className="input pl-9"
          />
        </div>
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">No state matches “{query}”.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {filtered.map(r => (
              <div key={r.abbr} className="self-start">
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-2 p-2.5 rounded-lg border border-gray-200 hover:bg-[#E0F0F4] transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 text-xs font-medium text-gray-900">
                      {r.state}
                      <ExternalLink size={11} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
                    </div>
                    <p className="text-[11px] text-gray-500 truncate">{r.agency}</p>
                  </div>
                </a>
                <OhvExtraLinks extra={OHV_STATE_EXTRA_LINKS[r.abbr]} compact />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 4 — Honest disclaimer */}
      <p className="text-gray-500 text-xs">{OHV_RESOURCE_DISCLAIMER}</p>
    </div>
  )
}
