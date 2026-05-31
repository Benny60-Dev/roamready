import { useEffect, useState } from 'react'
import { campgroundsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useUIStore } from '../store/uiStore'
import { MapPin, Navigation, Globe, Ticket } from 'lucide-react'

// Rec.gov FacilityDescription arrives as raw HTML (<p>, <h2>Overview</h2>, …).
// We deliberately do NOT render it as HTML (third-party content → XSS risk),
// so strip tags + decode common entities to clean plain text, then truncate at
// a word boundary so the card never trails off mid-word. The leading "Overview"
// heading is boilerplate on most facilities — drop it so the real sentence leads.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'",
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  mdash: '—', ndash: '–', hellip: '…', deg: '°',
}

function cleanDescription(raw?: string | null, maxLen = 180): string {
  if (!raw) return ''
  const text = raw
    .replace(/<[^>]*>/g, ' ')                                            // strip HTML tags
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')                                                // collapse whitespace
    .replace(/^\s*overview[\s:.-]*/i, '')                               // drop boilerplate heading
    .trim()
  if (text.length <= maxLen) return text
  // Truncate at the last word boundary before maxLen so we don't cut mid-word.
  const cut = text.slice(0, maxLen)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]$/, '')}…`
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '
}

export default function OhvDestinationsPage() {
  const [destinations, setDestinations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { hasAccess } = useAuthStore()
  const { openPaywall } = useUIStore()

  // OHV is open to all PRO users (no rig-type gating) — the PRO paywall in the
  // effect below is the only access gate. Cards render the real Recreation.gov
  // facility data that already arrives on each result.
  useEffect(() => {
    if (!hasAccess('ohvDestinations')) {
      // This page renders an empty shell behind the modal (no API call fires
      // for FREE users). redirectOnDismiss sends dismissals to /dashboard so
      // closing the modal doesn't leave the user staring at a blank header
      // and an empty grid.
      openPaywall('ohvDestinations', { redirectOnDismiss: '/dashboard' })
      // Clear loading so the page renders an empty state behind the paywall
      // instead of an infinite spinner. setLoading(false) only fires inside
      // the .then() below, which the early-return skips.
      setLoading(false)
      return
    }
    campgroundsApi.getOhv().then(res => { setDestinations(res.data); setLoading(false) })
  }, [])

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-medium text-gray-900">OHV Destinations</h1>
        <p className="text-sm text-gray-500">OHV &amp; off-road destinations</p>
      </div>
      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="card h-24 animate-pulse bg-gray-50" />)}</div>
      ) : destinations.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500 text-sm">No OHV destinations found right now.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {destinations.map(d => {
            // Directions from real lat/lng — same pattern as the Resources page.
            const mapsUrl = d.latitude != null && d.longitude != null
              ? `https://www.google.com/maps/search/?api=1&query=${d.latitude},${d.longitude}`
              : null
            const canReserve = Boolean(d.reservable && d.reservationUrl)
            const hasAttrs = Boolean(
              d.maxRigLength || d.maxRigHeight || (d.hookupTypes && d.hookupTypes.length) || d.isPetFriendly,
            )
            const hasActivities = Boolean(d.activities && d.activities.length)
            const hasActions = Boolean(mapsUrl || canReserve || d.website)
            const description = cleanDescription(d.description)

            return (
              <div key={d.id} className="card flex flex-col">
                <h3 className="font-medium text-gray-900 text-sm">{d.name}</h3>

                {d.address && (
                  <p className="text-xs text-gray-500 mt-0.5 flex items-start gap-1">
                    <MapPin size={12} className="text-gray-400 mt-0.5 flex-shrink-0" />
                    <span>{d.address}</span>
                  </p>
                )}

                {/* Cleaned, word-boundary-truncated plain text (no line-clamp):
                    a CSS "…" on a non-clickable card reads as "click for more",
                    so we truncate deterministically instead. The card stays a
                    static div — Directions / Reserve / Website are the only
                    actions, and .card has no hover/cursor affordance. */}
                {description && (
                  <p className="text-xs text-gray-600 mt-1.5">{description}</p>
                )}

                {/* Real rig-fit attributes — each only when present. */}
                {hasAttrs && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {d.maxRigLength ? (
                      <span className="badge bg-gray-50 text-gray-600 text-xs">Max rig: {d.maxRigLength} ft</span>
                    ) : null}
                    {d.maxRigHeight ? (
                      <span className="badge bg-gray-50 text-gray-600 text-xs">Max height: {d.maxRigHeight} ft</span>
                    ) : null}
                    {d.hookupTypes && d.hookupTypes.length > 0 ? (
                      <span className="badge bg-gray-50 text-gray-600 text-xs">Hookups: {d.hookupTypes.join(', ')}</span>
                    ) : null}
                    {d.isPetFriendly ? (
                      <span className="badge bg-gray-50 text-gray-600 text-xs">Pet-friendly</span>
                    ) : null}
                  </div>
                )}

                {/* Real Rec.gov activities (replaces the old hardcoded terrain tags). */}
                {hasActivities && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(d.activities as string[]).slice(0, 6).map(a => (
                      <span key={a} className="badge bg-amber-50 text-amber-700 text-xs">{a}</span>
                    ))}
                  </div>
                )}

                {/* Actions — touch-friendly. Directions is the primary roadside
                    action (filled); Reserve/Website are the practical path to
                    fee/permit info (no structured fee data from Rec.gov). */}
                {hasActions && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {mapsUrl && (
                      <a
                        href={mapsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#1F6F8B] text-white text-xs font-medium hover:bg-[#134756] transition-colors"
                      >
                        <Navigation size={13} /> Directions
                      </a>
                    )}
                    {canReserve && (
                      <a
                        href={d.reservationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-xs font-medium text-[#1F6F8B] hover:bg-[#E0F0F4] transition-colors"
                      >
                        <Ticket size={13} /> Reserve
                      </a>
                    )}
                    {d.website && (
                      <a
                        href={d.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-xs font-medium text-[#1F6F8B] hover:bg-[#E0F0F4] transition-colors"
                      >
                        <Globe size={13} /> Website
                      </a>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
