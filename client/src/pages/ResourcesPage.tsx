import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { MapPin, Phone, Star, Wrench, Mountain, Navigation, Globe, LocateFixed } from 'lucide-react'
import { resourcesApi, tripsApi } from '../services/api'
import { Trip, Stop } from '../types'

/**
 * Resources hub + Along-Route finder.
 *
 * Block 4 expanded /resources from a single-purpose "find nearby providers"
 * page into a hub for the app's read-only / reference surfaces:
 *
 *   - Hub tiles (top)   : Maintenance, Product Roadmap, OHV Destinations,
 *                          Van Destinations. These four pages were previously
 *                          orphaned (OHV/Van had zero inbound links in the
 *                          authed app; Maintenance + Roadmap were only
 *                          reachable from the Dashboard's Quick Actions row,
 *                          which Block 4 retired alongside this build).
 *   - Along-Route finder (below) : the original geolocation feature — RV
 *                          repair, propane, dump stations, etc., within 25mi
 *                          of the user's current location. Kept verbatim;
 *                          only the page chrome around it changed.
 *
 * Not on the hub deliberately:
 *   - /reservations (trip workflow, not a resource — Block 5 surfaces it as
 *     a Dashboard tab). We DON'T add a temporary link here; pushing Block 4
 *     and Block 5 together keeps origin from ever seeing an orphan state.
 *
 * Car Camping was added in the Block 4 follow-up — same orphaning shape as
 * OHV/Van (zero inbound links pre-Block 4). Desc line uses the page's own
 * subtitle ("Tent sites, walk-in, and backcountry") so the hub copy stays
 * in sync with what the destination actually shows.
 */
const HUB_TILES = [
  { to: '/maintenance',      icon: Wrench,   label: 'Maintenance',      desc: 'Rig service tracker' },
  { to: '/ohv-destinations', icon: Mountain, label: 'OHV Destinations', desc: 'Off-highway parks & trails' },
  // Van Destinations + Car Camping tiles hidden (post-launch revisit): they were
  // national keyword lists with hardcoded decorations, redundant with the trip
  // planner's campground discovery. Routes/pages/controllers stay dormant. Van
  // life & car camping are covered by the planner — see the note under the grid.
]

const RESOURCE_TABS = [
  { id: 'rv_repair', label: '🔧 RV Repair', desc: 'Roadside & shop repair' },
  { id: 'propane', label: '⛽ Propane', desc: 'Propane fill stations' },
  { id: 'dump_station', label: '🚽 Dump Stations', desc: 'RV waste disposal' },
  { id: 'rv_wash', label: '🚿 RV Wash', desc: 'RV & truck wash' },
  { id: 'parts_stores', label: '🏪 Parts / Gear', desc: 'RV parts & camping supplies' },
  { id: 'doggy_daycare', label: '🐶 Dog Services', desc: 'Daycare, grooming, vets' },
  { id: 'medical', label: '🏥 Medical', desc: 'Urgent care & hospitals' },
  { id: 'veterinary', label: '🐾 Veterinary', desc: 'Animal hospitals' },
]

// A stop is usable as a distance reference only if it has real coordinates.
function hasCoords(s: Stop): s is Stop & { latitude: number; longitude: number } {
  return typeof s.latitude === 'number' && typeof s.longitude === 'number'
}

// Reference toggle options. `Icon` typed as a single LucideIcon (typeof MapPin)
// so JSX rendering stays a single component type, not a union.
const MODE_OPTIONS: { m: 'me' | 'stop'; label: string; Icon: typeof MapPin }[] = [
  { m: 'me', label: 'Near me', Icon: LocateFixed },
  { m: 'stop', label: 'Near my stop', Icon: MapPin },
]

export default function ResourcesPage() {
  const [activeTab, setActiveTab] = useState('rv_repair')
  const [resources, setResources] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  // Phase 2: distance reference mode. 'me' = live GPS (default, unchanged);
  // 'stop' = a chosen trip stop. The server uses whatever lat/lng it's given as
  // BOTH the search center and the distance origin, so switching the reference
  // is purely a client concern.
  const [mode, setMode] = useState<'me' | 'stop'>('me')
  // 'me' mode — live GPS.
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [locationError, setLocationError] = useState('')
  // 'stop' mode — the user's trips (null = not fetched yet) + the picked stop.
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const [selectedTripId, setSelectedTripId] = useState('')
  const [selectedStopId, setSelectedStopId] = useState('')

  // Request GPS only for 'me' mode (privacy: no geolocation prompt in stop mode).
  // Default mode is 'me', so this still fires on mount as before.
  useEffect(() => {
    if (mode !== 'me' || location) return
    navigator.geolocation.getCurrentPosition(
      pos => setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setLocationError('Location access is required to find resources near you. Enable location for this site in your browser settings, then reload.')
    )
  }, [mode, location])

  // Lazily load trips the first time the user enters 'stop' mode; cache in state.
  useEffect(() => {
    if (mode !== 'stop' || trips !== null) return
    tripsApi.getAll()
      .then(res => setTrips(Array.isArray(res.data) ? res.data : []))
      .catch(() => setTrips([]))
  }, [mode, trips])

  // Pre-fill a sensible default once trips load in stop mode: most-recent trip
  // with mapped stops (server already orders updatedAt desc) + its first such
  // stop. Guarded by selectedStopId so it never overrides a user's choice.
  useEffect(() => {
    if (mode !== 'stop' || !trips || selectedStopId) return
    const ct = trips.filter(t => (t.stops ?? []).some(hasCoords))
    const t = ct[0]
    const s = t && (t.stops ?? []).find(hasCoords)
    if (t && s) { setSelectedTripId(t.id); setSelectedStopId(s.id) }
  }, [mode, trips, selectedStopId])

  // Trips offerable in the picker (others can't be a reference) + the selection.
  const coordTrips = (trips ?? []).filter(t => (t.stops ?? []).some(hasCoords))
  const selectedTrip = trips?.find(t => t.id === selectedTripId) ?? null
  const selectedStop = selectedTrip?.stops?.find(s => s.id === selectedStopId) ?? null

  // The active distance reference: GPS in 'me' mode, the picked stop in 'stop'.
  const ref =
    mode === 'me'
      ? location
      : selectedStop && hasCoords(selectedStop)
        ? { lat: selectedStop.latitude, lng: selectedStop.longitude }
        : null
  const refLat = ref?.lat
  const refLng = ref?.lng

  // Fetch resources around the active reference. Keyed on primitive coords (not
  // the ref object) + tab, so a new ref identity each render doesn't loop.
  useEffect(() => {
    if (refLat == null || refLng == null) { setResources([]); return }
    setLoading(true)
    resourcesApi.get(refLat, refLng, activeTab, 25).then(res => {
      setResources(Array.isArray(res.data) ? res.data : [])
      setLoading(false)
    }).catch(() => { setResources([]); setLoading(false) })
  }, [refLat, refLng, activeTab])

  // Changing the trip resets the stop to that trip's first coord-bearing stop.
  function selectTrip(tripId: string) {
    setSelectedTripId(tripId)
    const t = trips?.find(x => x.id === tripId)
    setSelectedStopId((t?.stops ?? []).find(hasCoords)?.id ?? '')
  }

  return (
    <div className="space-y-6">
      {/* Page header. Stale "Profile › Resources" breadcrumb removed — Resources
          is a top-nav destination now (since Block 2), not a Profile sub-page. */}
      <div>
        <h1 className="text-xl font-medium text-gray-900">Resources</h1>
        <p className="text-sm text-gray-500">Tools, references, and travel guides.</p>
      </div>

      {/* Hub tiles — same compact card visual language the Dashboard's
          (now retired) Quick Actions row used, kept consistent on purpose so
          users who recognized them there map the same metaphor here. */}
      <div>
        <h2 className="text-sm font-medium text-gray-700 mb-2">Tools &amp; guides</h2>
        {/* Compact tile grid — 2 tiles (Maintenance, OHV) after Roadmap moved to
            Help. Mobile 2-col full width; on sm+ keep the two tiles compact and
            centered (max-w-md + mx-auto) rather than left-aligned in a wide row. */}
        <div className="grid grid-cols-2 gap-2 sm:max-w-md sm:mx-auto">
          {HUB_TILES.map(({ to, icon: Icon, label, desc }) => (
            <Link
              key={to}
              to={to}
              className="card flex flex-col items-center text-center gap-2 py-4 hover:border-[#1F6F8B]/30 transition-all"
            >
              <Icon size={20} className="text-[#1F6F8B]" />
              <span className="text-sm font-medium text-gray-700">{label}</span>
              <span className="text-xs text-gray-500 leading-snug">{desc}</span>
            </Link>
          ))}
        </div>
        {/* Van life & car camping fold into the planner — their standalone tiles
            were redundant (national keyword lists). Honest "we serve you" note. */}
        <p className="text-xs text-gray-500 mt-2 leading-snug">
          Van life or car camping? The AI trip planner finds BLM, dispersed, and tent-friendly
          campgrounds along your route — the same off-grid destination tools, built right into planning.
        </p>
      </div>

      {/* Along-Route finder — original ResourcesPage content, structurally
          unchanged. Wrapped in its own section header so it reads as a
          distinct surface from the hub above. */}
      <div className="space-y-3">
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-gray-700">
            {mode === 'stop' && selectedStop ? `Resources near ${selectedStop.locationName}` : 'Resources near you'}
          </h2>

          {/* Reference toggle: live GPS vs a trip stop. */}
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" style={{ borderWidth: '0.5px' }}>
            {MODE_OPTIONS.map(({ m, label, Icon }) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                  mode === m ? 'bg-[#1F6F8B] text-white' : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>

          {/* GPS-permission notice applies only to 'me' mode. */}
          {mode === 'me' && locationError && <p className="text-xs text-amber-600">{locationError}</p>}

          {/* Stop picker (only in 'stop' mode). */}
          {mode === 'stop' && (
            trips === null ? (
              <p className="text-xs text-gray-500">Loading your trips…</p>
            ) : coordTrips.length === 0 ? (
              <p className="text-xs text-gray-500">No trips with mapped stops yet. Plan a trip to find resources near a stop.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <select
                  value={selectedTripId}
                  onChange={e => selectTrip(e.target.value)}
                  className="flex-1 min-w-[140px] border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#1F6F8B]"
                  style={{ borderWidth: '0.5px' }}
                >
                  {coordTrips.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <select
                  value={selectedStopId}
                  onChange={e => setSelectedStopId(e.target.value)}
                  className="flex-1 min-w-[140px] border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#1F6F8B]"
                  style={{ borderWidth: '0.5px' }}
                >
                  {(selectedTrip?.stops ?? []).filter(hasCoords).map(s => (
                    <option key={s.id} value={s.id}>{s.locationName}</option>
                  ))}
                </select>
              </div>
            )
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {RESOURCE_TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-shrink-0 px-3 py-2 rounded-lg text-sm border transition-colors ${
                activeTab === tab.id ? 'bg-[#1F6F8B] text-white border-[#1F6F8B]' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              }`}
              style={{ borderWidth: '0.5px' }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-2">{[1, 2, 3, 4].map(i => <div key={i} className="card h-20 animate-pulse bg-gray-50" />)}</div>
        ) : resources.length === 0 ? (
          <div className="card text-center py-12">
            <p className="text-gray-500 text-sm">
              {mode === 'stop'
                ? (ref ? 'No results found near this stop.' : 'Pick a trip and stop to find resources nearby.')
                : (location ? 'No results found nearby.' : 'Allow location access to find resources near you.')}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {resources.map(r => (
              <div key={r.id} className="card flex items-start gap-3">
                <div className="w-8 h-8 bg-gray-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <MapPin size={15} className="text-[#1F6F8B]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{r.name}</p>
                  {r.address && <p className="text-xs text-gray-500 mt-0.5">{r.address}</p>}
                  <div className="flex items-center gap-3 mt-1">
                    {/* Distance from the user's GPS (server-computed). Quiet
                        neutral text, matching OhvDestinationsPage's badge.
                        Omitted when the place has no coordinates. */}
                    {typeof r.distanceMiles === 'number' && (
                      <span className="text-xs text-gray-500">{r.distanceMiles} mi away</span>
                    )}
                    {r.rating && (
                      <span className="flex items-center gap-0.5 text-xs text-amber-500">
                        <Star size={11} fill="currentColor" /> {r.rating}
                      </span>
                    )}
                    {r.isOpen !== undefined && (
                      <span className={`text-xs ${r.isOpen ? 'text-[#0F766E]' : 'text-gray-400'}`}>
                        {r.isOpen ? 'Open now' : 'Closed'}
                      </span>
                    )}
                  </div>

                  {/* Inline actions — touch-friendly tap targets (py-2, primary
                      use is mobile/roadside). Each renders only when its data
                      is present (no dead-code gating now that the Places API
                      returns phone / googleMapsUrl / website). Directions is
                      the primary roadside action, so it's the filled button. */}
                  {(r.googleMapsUrl || r.phone || r.website) && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {r.googleMapsUrl && (
                        <a
                          href={r.googleMapsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#1F6F8B] text-white text-xs font-medium hover:bg-[#134756] transition-colors"
                        >
                          <Navigation size={13} /> Directions
                        </a>
                      )}
                      {r.phone && (
                        <a
                          href={`tel:${r.phone}`}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-xs font-medium text-[#1F6F8B] hover:bg-[#E0F0F4] transition-colors"
                        >
                          <Phone size={13} /> Call
                        </a>
                      )}
                      {r.website && (
                        <a
                          href={r.website}
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
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
