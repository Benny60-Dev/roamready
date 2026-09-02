// FEAT-NAV-HANDOFF — the one "hand this leg to a maps app" surface, used from
// the trip-map stop popup, the itinerary rows, the summary page's drive rows
// and the booking page's booked card. Replaces the pair of tiny
// "from my location · from previous stop" text links.
//
// What it promises the user, and why each piece exists:
//  • Leaving from — "My location" or the previous stop. When the phone says
//    we're still AT the previous stop (≤ NEAR_PREV_STOP_MILES) the corridor
//    waypoints go along either way; once we're down the road they are left
//    out (they'd route the driver back) and the sheet says so.
//  • Status line — the leg's provenance from the routes endpoint: measured for
//    the rig (LVR) vs. fell back to car routing vs. no rig dims on file. Shown
//    BEFORE the tap, in the "measured for your rig" vocabulary (never a vendor
//    name, never "RV-safe").
//  • Open in — Google Maps always; Apple Maps only on Apple devices. The last
//    app used is remembered per device and preselected next time.
//  • Every tap logs a `nav.handoff` event (app, origin, corridor, provenance)
//    so we learn which apps people use before deciding about Waze.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigation, Check, AlertTriangle, Info } from 'lucide-react'
import BottomSheet from '../ui/BottomSheet'
import type { DirectionsWaypoint } from '../../utils/directions'
import {
  legUrl, wholeTripUrl, isApplePlatform, getLastNavApp, setLastNavApp, milesBetween,
  NEAR_PREV_STOP_MILES, type NavApp,
} from '../../utils/navHandoff'
import { eventsApi } from '../../services/api'
import { useLegRoutesContext } from '../../hooks/useLegRoutes'

export interface NavStop {
  id?: string
  locationName: string
  locationState?: string | null
  latitude?: number | null
  longitude?: number | null
  bookingStatus?: string | null
  campgroundName?: string | null
  driveDistanceMiles?: number | null
  driveDuration?: string | null
}

export interface NavigateSheetProps {
  isOpen: boolean
  onClose: () => void
  /** The stop being navigated TO. */
  stop: NavStop
  /** The stop this leg departs from. null = unknown (first stop / no prev). */
  prevStop: NavStop | null
  /** ≤3 snapped corridor points for prevStop→stop (from the routes endpoint). */
  waypoints?: DirectionsWaypoint[] | null
  /** Leg provenance: true = measured for the rig, false = fell back to car
   *  routing with a rig on file, undefined = no usable rig dims / unknown. */
  rigAware?: boolean
  tripId?: string
  /** Where the sheet was opened from — for the usage log only. */
  source: 'map-popup' | 'itinerary' | 'summary' | 'booking'
  /** Preselect the origin. Booking page's "Start this leg" wants 'me'. */
  defaultOrigin?: 'me' | 'prev'
}

type Origin = 'me' | 'prev'
type Fix =
  | { kind: 'pending' }
  | { kind: 'near'; miles: number }
  | { kind: 'far'; miles: number }
  | { kind: 'none' } // denied / unavailable / no prev coords

export default function NavigateSheet({
  isOpen, onClose, stop, prevStop, waypoints, rigAware, tripId, source, defaultOrigin,
}: NavigateSheetProps) {
  const apple = useMemo(() => isApplePlatform(), [])
  const [origin, setOrigin] = useState<Origin>(defaultOrigin ?? (prevStop ? 'prev' : 'me'))
  const [fix, setFix] = useState<Fix>({ kind: 'pending' })
  const [lastApp, setLastAppState] = useState<NavApp | null>(() => getLastNavApp())

  // One geolocation read per open. Only consulted for the "my location"
  // branch; never stored, never sent anywhere.
  useEffect(() => {
    if (!isOpen) return
    setOrigin(defaultOrigin ?? (prevStop ? 'prev' : 'me'))
    if (!prevStop || prevStop.latitude == null || prevStop.longitude == null || !('geolocation' in navigator)) {
      setFix({ kind: 'none' })
      return
    }
    setFix({ kind: 'pending' })
    let cancelled = false
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (cancelled) return
        const miles = milesBetween(pos.coords.latitude, pos.coords.longitude, prevStop.latitude!, prevStop.longitude!)
        setFix(miles <= NEAR_PREV_STOP_MILES ? { kind: 'near', miles } : { kind: 'far', miles })
      },
      () => { if (!cancelled) setFix({ kind: 'none' }) },
      { timeout: 6000, maximumAge: 60_000 },
    )
    return () => { cancelled = true }
  }, [isOpen, prevStop, defaultOrigin])

  const hasCorridor = !!waypoints && waypoints.length > 0
  // Corridor points ride along from the previous stop always, and from "my
  // location" only while we're still at (near) the previous stop.
  const corridorApplies = hasCorridor && (origin === 'prev' || fix.kind === 'near')

  const open = useCallback((app: NavApp) => {
    const from = origin === 'prev' ? prevStop : null
    const url = legUrl(app, from, stop, corridorApplies ? waypoints : null)
    setLastNavApp(app)
    setLastAppState(app)
    eventsApi.track('nav.handoff', {
      app, origin, source,
      corridor: corridorApplies,
      corridorPoints: corridorApplies ? waypoints!.length : 0,
      rigAware: rigAware ?? null,
      fix: fix.kind,
      platformApple: apple,
    }, tripId)
    window.open(url, '_blank', 'noopener,noreferrer')
    onClose()
  }, [origin, prevStop, stop, corridorApplies, waypoints, rigAware, fix.kind, apple, source, tripId, onClose])

  const dest = stop.bookingStatus === 'CONFIRMED' && stop.campgroundName ? stop.campgroundName : null
  const legLine = [dest, stop.driveDistanceMiles ? `${Math.round(stop.driveDistanceMiles)} mi` : null, stop.driveDuration || null]
    .filter(Boolean).join(' · ')

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={`Navigate to ${stop.locationName}${stop.locationState ? `, ${stop.locationState}` : ''}`}>
      <div className="px-5 pb-6 pt-3 space-y-4">
        {legLine && <p className="text-xs text-gray-500 -mt-1">{legLine}</p>}

        {/* Leaving from */}
        {prevStop && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#6B6458] mb-1.5">Leaving from</p>
            <div className="flex rounded-[10px] border border-gray-300 overflow-hidden" role="radiogroup" aria-label="Leaving from">
              <OriginOption
                active={origin === 'me'} onClick={() => setOrigin('me')} label="My location"
                sub={fix.kind === 'near' ? `you're at ${prevStop.locationName}`
                  : fix.kind === 'far' ? `${Math.round(fix.miles)} mi from ${prevStop.locationName}`
                  : fix.kind === 'pending' ? 'checking…' : 'location unavailable'}
              />
              <OriginOption
                active={origin === 'prev'} onClick={() => setOrigin('prev')} label="Previous stop"
                sub={`${prevStop.locationName}${prevStop.locationState ? `, ${prevStop.locationState}` : ''}`}
              />
            </div>
          </div>
        )}

        {/* Status — provenance first, then the corridor caveat when it applies. */}
        {rigAware === true && corridorApplies && (
          <StatusBox tone="ok" icon={<Check size={14} />}>
            <strong>Route measured for your rig.</strong> The maps app is given {waypoints!.length} point{waypoints!.length === 1 ? '' : 's'} along our route so it keeps to the same roads.
          </StatusBox>
        )}
        {rigAware === true && !corridorApplies && fix.kind === 'far' && (
          <StatusBox tone="warn" icon={<AlertTriangle size={14} />}>
            <strong>Heads up — you're already on this leg.</strong> Our measured route points are left out from here so the app doesn't send you back to {prevStop?.locationName ?? 'the previous stop'}; it will route the rest as a car. Switch to "Previous stop" to see the full measured route.
          </StatusBox>
        )}
        {rigAware === true && !corridorApplies && fix.kind !== 'far' && (
          <StatusBox tone="warn" icon={<AlertTriangle size={14} />}>
            <strong>Heads up — {fix.kind === 'pending' ? 'still checking your location' : 'we couldn’t confirm your location'}.</strong> Without it the measured route points are left out and the app routes as a car. Choose "Previous stop" to include the full measured route.
          </StatusBox>
        )}
        {rigAware === false && (
          <StatusBox tone="warn" icon={<AlertTriangle size={14} />}>
            <strong>Heads up — this leg wasn't measured for your rig.</strong> Rig-measured routing isn't available here, so the maps app will route it as a car. Check clearances and grades yourself before you go.
          </StatusBox>
        )}
        {rigAware === undefined && (
          <StatusBox tone="info" icon={<Info size={14} />}>
            This leg isn't measured for a rig — add your rig's height, length and weight on your profile to get drive routes measured for it.
          </StatusBox>
        )}

        {/* Open in */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#6B6458] mb-1.5">Open in</p>
          <div className={`grid gap-2.5 ${apple ? 'grid-cols-2' : 'grid-cols-1'}`}>
            <AppButton primary={!apple || lastApp !== 'apple'} remembered={lastApp === 'google'} onClick={() => open('google')}>Google Maps</AppButton>
            {apple && (
              <AppButton primary={lastApp === 'apple'} remembered={lastApp === 'apple'} onClick={() => open('apple')}>Apple Maps</AppButton>
            )}
          </div>
          <p className="text-[11px] text-gray-400 text-center mt-2">
            {apple ? 'Waze isn’t supported yet — it can’t follow a multi-point route.' : 'Apple Maps appears on iPhone, iPad and Mac. Waze isn’t supported yet.'}
          </p>
        </div>
      </div>
    </BottomSheet>
  )
}

function OriginOption({ active, onClick, label, sub }: { active: boolean; onClick: () => void; label: string; sub: string }) {
  return (
    <button
      type="button" role="radio" aria-checked={active} onClick={onClick}
      className={`flex-1 min-h-[48px] px-2 py-2 flex flex-col items-center justify-center text-[13px] leading-tight transition-colors ${
        active ? 'bg-[#1F6F8B] text-white font-medium' : 'bg-white text-gray-700 hover:bg-gray-50'
      }`}
    >
      <span>{label}</span>
      <span className={`text-[11px] ${active ? 'text-white/80' : 'text-gray-500'}`}>{sub}</span>
    </button>
  )
}

function StatusBox({ tone, icon, children }: { tone: 'ok' | 'warn' | 'info'; icon: React.ReactNode; children: React.ReactNode }) {
  const cls = tone === 'ok' ? 'bg-[#DCE5D5] text-[#2F4030]'
    : tone === 'warn' ? 'bg-amber-50 border border-amber-200 text-amber-800'
    : 'bg-[#E0F0F4] text-[#134756]'
  return (
    <div className={`flex items-start gap-2 rounded-[10px] px-3 py-2.5 text-xs leading-relaxed ${cls}`}>
      <span className="flex-shrink-0 mt-0.5">{icon}</span>
      <span>{children}</span>
    </div>
  )
}

function AppButton({ primary, remembered, onClick, children }: { primary: boolean; remembered: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" onClick={onClick}
      className={`min-h-[48px] rounded-[10px] text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
        primary ? 'bg-[#F7A829] text-white hover:bg-[#C9851A]' : 'bg-white text-[#1F6F8B] border border-[#1F6F8B] hover:bg-[#E0F0F4]'
      }`}
    >
      {remembered && <Check size={14} aria-label="last used" />}
      {children}
    </button>
  )
}

/** The trigger + inline provenance chip. Owns the sheet's open state so a
 *  page only has to drop <NavigateButton …/> where the text links used to be. */
export function NavigateButton({
  stop, prevStop, waypoints, rigAware, tripId, source, defaultOrigin, label, compact,
}: Omit<NavigateSheetProps, 'isOpen' | 'onClose'> & { label?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  // Pages that don't pass waypoints/rigAware explicitly (summary, booking)
  // provide them through LegRoutesProvider; explicit props win.
  const ctx = useLegRoutesContext()
  if (waypoints === undefined && stop.id) waypoints = ctx.waypoints.get(stop.id)
  if (rigAware === undefined && stop.id) rigAware = ctx.rigAware.get(stop.id)
  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={e => { e.stopPropagation(); setOpen(true) }}
          className={`inline-flex items-center gap-1.5 rounded-lg bg-[#E0F0F4] text-[#1F6F8B] font-medium hover:bg-[#1F6F8B] hover:text-white transition-colors ${
            compact ? 'px-2.5 py-1.5 text-xs min-h-[36px]' : 'px-3 py-2 text-[13px] min-h-[44px]'
          }`}
        >
          <Navigation size={compact ? 12 : 15} />
          {label ?? `Navigate to ${stop.locationName}`}
        </button>
        {rigAware === true && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#2F4030]"><Check size={12} /> Measured for your rig</span>
        )}
        {rigAware === false && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-800"><AlertTriangle size={12} className="text-amber-600" /> Not measured for your rig</span>
        )}
      </div>
      {open && (
        <NavigateSheet
          isOpen={open} onClose={() => setOpen(false)}
          stop={stop} prevStop={prevStop} waypoints={waypoints} rigAware={rigAware}
          tripId={tripId} source={source} defaultOrigin={defaultOrigin}
        />
      )}
    </>
  )
}

/** Whole-trip handoff (Cindy's "view trip in Google Maps"): every stop as a
 *  waypoint, no corridor points (the apps re-route between stops — the sheet
 *  says so). Google caps at 9 intermediate stops; over that it opens the
 *  first 11 stops and says how many were left out. */
export function WholeTripButton({ stops, tripId, className }: { stops: NavStop[]; tripId?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const apple = useMemo(() => isApplePlatform(), [])
  const google = useMemo(() => wholeTripUrl('google', stops), [stops])
  const appleTrip = useMemo(() => (apple ? wholeTripUrl('apple', stops) : null), [apple, stops])
  if (!google) return null
  const go = (app: NavApp) => {
    const r = app === 'apple' ? appleTrip : google
    if (!r) return
    setLastNavApp(app)
    eventsApi.track('nav.wholetrip', { app, stops: r.total, included: r.included, platformApple: apple }, tripId)
    window.open(r.url, '_blank', 'noopener,noreferrer')
    setOpen(false)
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className ?? 'btn-outline text-sm flex items-center gap-1.5'}>
        <Navigation size={13} /> Whole trip
      </button>
      {open && (
        <BottomSheet isOpen={open} onClose={() => setOpen(false)} title="Open the whole trip in a maps app">
          <div className="px-5 pb-6 pt-3 space-y-4">
            <StatusBox tone="info" icon={<Info size={14} />}>
              Every stop is passed in order, but between stops the maps app plans its own roads — this is the overview, not the measured route. Use <strong>Navigate</strong> on a stop for the leg measured for your rig.
            </StatusBox>
            {google.included < google.total && (
              <StatusBox tone="warn" icon={<AlertTriangle size={14} />}>
                Google Maps accepts up to {google.included} stops in one link, so the first {google.included} of your {google.total} stops open; the rest are left off.
              </StatusBox>
            )}
            <div className={`grid gap-2.5 ${apple ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <AppButton primary remembered={false} onClick={() => go('google')}>Google Maps</AppButton>
              {apple && appleTrip && <AppButton primary={false} remembered={false} onClick={() => go('apple')}>Apple Maps</AppButton>}
            </div>
          </div>
        </BottomSheet>
      )}
    </>
  )
}
