import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import {
  CheckCircle, AlertTriangle, ExternalLink,
  Phone, MapPin, Globe, ChevronDown, ChevronUp, Loader, Check,
  BadgeInfo, Bed, Tent, X,
} from 'lucide-react'
import { tripsApi, campgroundsApi, usersApi } from '../../services/api'
import { Trip, Stop, Campground, Rig } from '../../types'
import { formatTripDate } from '../../utils/dates'
import { useAuthStore } from '../../store/authStore'
import { MEMBERSHIP_TYPES } from '../../constants/memberships'
import { buildStopBadges, formatStopBadgeLabel, formatStopBadgeMarker, isHomeBadge } from '../../utils/stopBadge'
import { useUIStore } from '../../store/uiStore'
import ConfirmModal from '../../components/ui/ConfirmModal'
import RigInfoModal from '../../components/trip/RigInfoModal'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcDistance(lat1?: number | null, lng1?: number | null, lat2?: number | null, lng2?: number | null): string | null {
  if (!lat1 || !lng1 || !lat2 || !lng2) return null
  const R = 3959
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1)
}

// B3 — formatDate() helper removed. Its only consumer was the old
// destination header above the card, which now lives inside the card via
// StopHeaderBlock. The header block uses formatTripDate directly with a
// shorter 'MMM d' format (e.g. "May 28 → May 29") matching the redesign.

function truncateName(name: string): string {
  return name.length > 35 ? name.slice(0, 30) + '...' : name
}

// AI-only fallback entries set reservationUrl to a Google Maps search link, while
// RIDB-sourced entries point at recreation.gov, and Places-verified entries usually
// link to the campground's own website. Pick a label that matches where the click
// actually lands so users aren't told "Recreation.gov" and dropped on Google Maps.
function reservationLinkLabel(url: string): string {
  const lower = url.toLowerCase()
  if (lower.includes('recreation.gov')) return 'Recreation.gov'
  if (lower.includes('google.com/maps')) return 'Find on Google Maps'
  return 'Website'
}

// Reservation Honesty: gentle membership reminder rendered under the booking
// CTA when the user has saved any active, non-expired memberships. Never
// claims a discount IS applied — it's a prompt to ask the campground, not a
// price promise. No siteRate math, no percentages, no dollar amounts.
function formatMembershipNudge(labels: string[]): string {
  if (labels.length === 0) return ''
  if (labels.length === 1) return `You have ${labels[0]} — ask if it saves you money here.`
  if (labels.length === 2) return `You have ${labels[0]} and ${labels[1]} — ask if any save you money here.`
  const joined = labels.slice(0, -1).join(', ') + ', and ' + labels[labels.length - 1]
  return `You have ${joined} — ask if any save you money here.`
}

// ─── Reservation & Notes collapsible section ─────────────────────────────────

interface ReservationForm {
  confirmationNum: string
  siteNumber: string
  checkInTime: string
  checkOutTime: string
  notes: string
  // Block 13 — actual cost capture. Stored as strings (matching the rest
  // of the form-state convention for <input> values) and converted to
  // numbers in the save payload below. siteRate is the campground's
  // published/AI-estimated rate; these two record what the user actually
  // paid after discounts / fees / taxes.
  actualRate: string
  actualFees: string
}

function ReservationSection({
  stop,
  cg,
  draftMode,
  onSaved,
}: {
  stop: Stop
  cg: Campground
  draftMode: boolean
  onSaved: (data: Partial<Stop>) => void
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [form, setForm] = useState<ReservationForm>({
    confirmationNum: stop.confirmationNum || '',
    siteNumber: stop.siteNumber || '',
    checkInTime: stop.checkInTime || '',
    checkOutTime: stop.checkOutTime || '',
    notes: stop.notes || '',
    // Pre-fill from prior actuals so editing a booking shows the values
    // already recorded. Number → string via `?? ''` because the inputs are
    // controlled text fields; the save path converts back to number.
    actualRate: stop.actualRate != null ? String(stop.actualRate) : '',
    actualFees: stop.actualFees != null ? String(stop.actualFees) : '',
  })

  // Track previous bookingStatus + draftMode across renders. The component stays mounted
  // unconditionally so these refs can see real transitions: false→true on the draftMode
  // flag (user just clicked the gold button) drives auto-expand; CONFIRMED→non-CONFIRMED
  // on bookingStatus (unbook) drives the form reset.
  const prevStatusRef = useRef(stop.bookingStatus)
  const prevDraftRef = useRef(draftMode)
  const confirmationInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const prevStatus = prevStatusRef.current
    const status = stop.bookingStatus
    const prevDraft = prevDraftRef.current

    if (!prevDraft && draftMode) {
      // User just clicked the gold button: open the form and focus the confirmation input
      // so they can paste the # they get back from Recreation.gov.
      setOpen(true)
      setTimeout(() => confirmationInputRef.current?.focus(), 50)
    } else if (prevStatus === 'CONFIRMED' && status !== 'CONFIRMED') {
      // Unbook: component stays mounted, so resync local form to the prop and collapse —
      // otherwise stale values would survive the next rebook.
      setForm({
        confirmationNum: stop.confirmationNum || '',
        siteNumber: stop.siteNumber || '',
        checkInTime: stop.checkInTime || '',
        checkOutTime: stop.checkOutTime || '',
        notes: stop.notes || '',
        actualRate: stop.actualRate != null ? String(stop.actualRate) : '',
        actualFees: stop.actualFees != null ? String(stop.actualFees) : '',
      })
      setOpen(false)
    }

    prevStatusRef.current = status
    prevDraftRef.current = draftMode
  }, [stop.bookingStatus, draftMode])

  function set(field: keyof ReservationForm, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  async function save() {
    setSaving(true)
    try {
      // Block 13 — convert the actual-cost text inputs to numbers (or
      // undefined when blank / non-numeric so the field is left alone in
      // the DB). The HTML inputs are type="number" so non-numeric strings
      // are rare, but Number('') is 0 and would clobber a previously-set
      // value — hence the explicit empty-string guard before Number().
      const toNum = (s: string): number | undefined => {
        if (s.trim() === '') return undefined
        const n = Number(s)
        return Number.isFinite(n) && n >= 0 ? n : undefined
      }
      const payload: Partial<Stop> = {
        confirmationNum: form.confirmationNum || undefined,
        siteNumber: form.siteNumber || undefined,
        checkInTime: form.checkInTime || undefined,
        checkOutTime: form.checkOutTime || undefined,
        notes: form.notes || undefined,
        actualRate: toNum(form.actualRate),
        actualFees: toNum(form.actualFees),
      }
      // Reservation Honesty: when this save fires from draft mode it IS the booking commit —
      // flip bookingStatus and link the chosen campground in the same updateStop call so we
      // never publish a CONFIRMED stop without the user-entered fields. Already-confirmed
      // edits skip this block and behave as before (form-field updates only).
      if (draftMode && stop.bookingStatus !== 'CONFIRMED') {
        payload.bookingStatus = 'CONFIRMED'
        payload.campgroundId = cg.id
        payload.campgroundName = cg.name
        if (cg.siteRate !== undefined) payload.siteRate = cg.siteRate
      }
      await tripsApi.updateStop(stop.tripId, stop.id, payload)
      onSaved(payload)
      setJustSaved(true)
      setOpen(false)
      setTimeout(() => setJustSaved(false), 3000)
    } catch (e) {
      console.error('[saveReservation]', e)
    } finally {
      setSaving(false)
    }
  }

  // Render only when the stop is actually booked OR the user is filling in a draft.
  // Keeping the component mounted regardless lets the transition useEffect above see flips.
  if (stop.bookingStatus !== 'CONFIRMED' && !draftMode) return null

  // Collapsed-state summary — shows the three highest-signal fields if any are set,
  // or a hint that prompts the user to click. Check-out and notes are intentionally
  // omitted to keep the line short and scannable.
  const summaryParts: string[] = []
  if (form.confirmationNum) summaryParts.push(`Confirmation: ${form.confirmationNum}`)
  if (form.siteNumber) summaryParts.push(`Site: ${form.siteNumber}`)
  if (form.checkInTime) summaryParts.push(`Check-in: ${form.checkInTime}`)
  const collapsedSummary = summaryParts.length > 0
    ? summaryParts.join(' · ')
    : 'Click to add confirmation #, site number, and notes'

  return (
    <div className="border-t border-gray-100 mt-3 pt-3" style={{ borderTopWidth: '0.5px' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full text-left -mx-1.5 px-1.5 py-1 rounded-md hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center justify-between text-xs font-medium text-gray-600">
          <span className="text-rr-blue hover:underline underline-offset-2">Reservation &amp; Notes</span>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </div>
        {!open && (
          <div className="mt-1 text-xs text-gray-600">
            {collapsedSummary}
          </div>
        )}
      </button>

      {justSaved && !open && (
        <p className="mt-1.5 text-xs text-[#0F766E] flex items-center gap-1">
          <Check size={11} /> Saved
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs italic text-gray-500 leading-relaxed">
            RoamReady doesn't make reservations for you. Use this to record your own
            confirmation # after you book directly with the campground.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Confirmation #</label>
              <input
                ref={confirmationInputRef}
                className="input text-xs w-full"
                placeholder="ABC123456"
                value={form.confirmationNum}
                onChange={e => set('confirmationNum', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Site #</label>
              <input
                className="input text-xs w-full"
                placeholder="14A"
                value={form.siteNumber}
                onChange={e => set('siteNumber', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Check-in time</label>
              <input
                className="input text-xs w-full"
                placeholder="2:00 PM"
                value={form.checkInTime}
                onChange={e => set('checkInTime', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Check-out time</label>
              <input
                className="input text-xs w-full"
                placeholder="11:00 AM"
                value={form.checkOutTime}
                onChange={e => set('checkOutTime', e.target.value)}
              />
            </div>
            {/* Block 13 — actual cost capture. The campground's published rate
                (stop.siteRate) is the pre-booking estimate; what users
                actually pay is shaped by discounts, loyalty, taxes, and
                fees that vary site-by-site. These two inputs record the
                real numbers so the trip's cost total reflects reality
                instead of the published-rate estimate. Both are optional
                — a user can save reservation info without filling them
                in, and can come back later to fill them after the stay. */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Rate per night (actual)</label>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                className="input text-xs w-full"
                placeholder="65.00"
                value={form.actualRate}
                onChange={e => set('actualRate', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Fees &amp; taxes</label>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                className="input text-xs w-full"
                placeholder="0.00"
                value={form.actualFees}
                onChange={e => set('actualFees', e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Notes</label>
            <textarea
              className="input text-xs w-full resize-none"
              rows={3}
              placeholder="Gate code, quiet hours, things to remember..."
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
            />
          </div>
          {/* Gold outline — same shape as the Book button on the unbooked
              card. Last solid-orange "billboard" CTA on the redesigned
              page gets the same calm treatment as everything else. */}
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 transition-colors hover:bg-[#BA7517]/5 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              color: '#BA7517',
              border: '1px solid #BA7517',
              background: 'transparent',
              fontSize: 13,
              fontWeight: 500,
              padding: '7px 14px',
              borderRadius: 6,
            }}
          >
            {saving
              ? <><Loader size={13} className="animate-spin" /> Saving…</>
              : <><CheckCircle size={13} /> Save reservation info</>
            }
          </button>
        </div>
      )}
    </div>
  )
}

// ─── StopHeaderBlock — shared header row for the recommended card + fallback ──
// B3 — the destination header that used to live above the card (city + dates
// + booking-status pill in renderStopContent) is folded into the cards
// themselves. This helper renders the new header for the recommended card,
// the "no campgrounds found" fallback, and the "no compatible" fallback, so
// users still see destination context whether or not a recommendation exists.
//
// Layout: numbered circle (RV-blue for overnight, gold for stay) + type icon
// (Bed gray for overnight, Tent gold for stay) + center column (lead name
// inline with date range + nights count; city/mileage subline) + right-side
// type pill ("Overnight" / "N-night stay").

function StopHeaderBlock({
  stop,
  prevStop,
  marker,
  leadName,
}: {
  stop: Stop
  prevStop?: Stop
  marker: string
  // The bold lead text. For the recommended card this is the campground name;
  // for fallback cards it's the "No campgrounds found near {city}" headline.
  leadName: string
}) {
  const isOvernight = stop.type === 'OVERNIGHT_ONLY'
  const driveDistance = prevStop
    ? calcDistance(prevStop.latitude, prevStop.longitude, stop.latitude, stop.longitude)
    : null
  const arr = stop.arrivalDate ? formatTripDate(stop.arrivalDate, 'MMM d') : null
  const dep = stop.departureDate ? formatTripDate(stop.departureDate, 'MMM d') : null
  const dateRange = arr ? (dep && dep !== arr ? `${arr} → ${dep}` : arr) : null
  const nightsLabel = stop.nights === 1 ? '1 night' : `${stop.nights} nights`
  const typeLabel = isOvernight ? 'Overnight' : `${stop.nights}-night stay`

  return (
    <div className="flex items-start gap-3">
      {/* Numbered circle — 26×26, pale RV-blue (overnight) or pale gold (stay) */}
      <div
        className="flex items-center justify-center flex-shrink-0 rounded-full"
        style={{
          width: 26,
          height: 26,
          background: isOvernight ? '#E0F0F4' : '#FAEEDA',
          color: isOvernight ? '#134756' : '#854F0B',
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        {marker}
      </div>
      {/* Type icon */}
      {isOvernight
        ? <Bed size={17} className="flex-shrink-0" style={{ color: '#5F5E5A', marginTop: 4 }} />
        : <Tent size={17} className="flex-shrink-0" style={{ color: '#BA7517', marginTop: 4 }} />
      }
      {/* Center — bold name lead + date range inline, city subline */}
      <div className="flex-1 min-w-0">
        <p className="text-gray-900" style={{ fontSize: 18, fontWeight: 500, lineHeight: 1.25 }}>
          {leadName}
          {dateRange && (
            <span className="text-gray-500 font-normal" style={{ fontSize: 14 }}>
              {' · '}{dateRange}
              {stop.nights > 0 && <>{' · '}{nightsLabel}</>}
            </span>
          )}
        </p>
        <p className="text-gray-500" style={{ fontSize: 12, marginTop: 4 }}>
          {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
          {driveDistance && <span className="text-gray-400">{' · '}~{driveDistance} mi from previous stop</span>}
        </p>
      </div>
      {/* Right-side type pill — informational about stop type only. Booking
          state is signaled elsewhere (sidebar dot, B4 collapsed row). */}
      <span
        className="flex-shrink-0"
        style={{
          background: isOvernight ? '#F1EFE8' : '#FAEEDA',
          color: isOvernight ? '#5F5E5A' : '#854F0B',
          fontSize: 11,
          fontWeight: 500,
          padding: '3px 9px',
          borderRadius: 6,
          whiteSpace: 'nowrap',
        }}
      >
        {typeLabel}
      </span>
    </div>
  )
}

// ─── Booked-state collapsed row ──────────────────────────────────────────────
// B4 — replaces the full RecommendedCampgroundCard + "Booked" banner combo
// for stops with bookingStatus === 'CONFIRMED'. Renders as a single pale-
// green row at rest; expanding "Edit" reveals the booking-management
// surface (pre-filled ReservationSection, alternates toggle, destructive
// Unbook action). The alternates LIST itself still animates open below the
// card via the same expandedAlts state — only the toggle moves.
//
// Spec colors locked:
//   bg #F3F7EE  border #9FBF8A  check-icon bg #DCE5D5  check stroke #2F4030
// Edit is one click deeper than the prior inline Unbook link — deliberately,
// per the design call ("unbook is too punishing for the Recreation.gov-
// dates-fell-through case; keep the collapsed row clean and let the user
// drill into Edit when they need to manage").

function BookedRowCard({
  stop,
  cg,
  marker,
  onStopUpdated,
  onUnbook,
  altCount,
  altsExpanded,
  onToggleAlts,
}: {
  stop: Stop
  // The booked campground — comes from renderStopContent's bookedCg lookup
  // (cgs.find(c => c.id === stop.campgroundId)). Required: ReservationSection
  // inside the Edit expansion needs a campground id/name when saving.
  cg: Campground
  marker: string
  onStopUpdated: (stopId: string, data: Partial<Stop>) => void
  onUnbook: () => void
  altCount: number
  altsExpanded: boolean
  onToggleAlts: () => void
}) {
  // Edit expansion local state. Independent from altsExpanded — the user can
  // open Edit, browse alternates, and close Edit, leaving alternates visible
  // below the card; or vice versa.
  const [editOpen, setEditOpen] = useState(false)
  const isOvernight = stop.type === 'OVERNIGHT_ONLY'
  const arr = stop.arrivalDate ? formatTripDate(stop.arrivalDate, 'MMM d') : null
  const dep = stop.departureDate ? formatTripDate(stop.departureDate, 'MMM d') : null
  const dateLabel = arr ? (dep && dep !== arr ? `${arr} → ${dep}` : arr) : null
  const nightsLabel = stop.nights === 1 ? '1 night' : `${stop.nights} nights`
  // Show what the user actually paid when actuals are entered; fall back to
  // the AI estimate for the rare case of a CONFIRMED stop without recorded
  // actuals. Fees only count when actualRate is set (no phantom fees from
  // a still-estimated stop).
  const hasActuals = stop.actualRate != null
  const ratePerNight = hasActuals ? stop.actualRate! : stop.siteRate
  const fees = hasActuals ? (stop.actualFees ?? 0) : 0
  const totalCost = ratePerNight != null ? ratePerNight * stop.nights + fees : 0

  return (
    <div
      className="mb-3"
      style={{
        background: '#F3F7EE',
        border: '1px solid #9FBF8A',
        borderRadius: 8,
      }}
    >
      {/* Collapsed row */}
      <div className="flex items-start gap-3" style={{ padding: '12px 16px' }}>
        {/* Check icon */}
        <div
          className="flex-shrink-0 flex items-center justify-center rounded-full"
          style={{ width: 26, height: 26, background: '#DCE5D5', color: '#2F4030' }}
        >
          <Check size={14} strokeWidth={2.5} />
        </div>
        {/* Type icon */}
        {isOvernight
          ? <Bed size={16} className="flex-shrink-0" style={{ color: '#5F5E5A', marginTop: 5 }} />
          : <Tent size={16} className="flex-shrink-0" style={{ color: '#BA7517', marginTop: 5 }} />
        }
        {/* Center — campground name bold lead inline with Stop N + city,
            line 2 has the booked metadata. */}
        <div className="flex-1 min-w-0">
          <p style={{ fontSize: 14, lineHeight: 1.3 }}>
            <span className="font-medium text-gray-900">{stop.campgroundName ?? cg.name}</span>
            <span className="text-gray-500" style={{ fontSize: 12 }}>
              {' · '}Stop {marker}
              {' · '}{stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
            </span>
          </p>
          <p className="text-gray-500" style={{ fontSize: 12, marginTop: 2 }}>
            {dateLabel && <>{dateLabel}{' · '}</>}
            {nightsLabel}
            {totalCost > 0 && <>{' · '}${totalCost}</>}
            {stop.confirmationNum && <>{' · '}conf. {stop.confirmationNum}</>}
          </p>
        </div>
        {/* Edit toggle */}
        <button
          onClick={() => setEditOpen(o => !o)}
          className="flex-shrink-0 transition-colors hover:underline"
          style={{ color: '#185FA5', fontSize: 13 }}
          aria-expanded={editOpen}
        >
          {editOpen ? 'Close' : 'Edit'}
        </button>
      </div>

      {/* Edit expansion — animated via the same grid-rows trick used for the
          alternates list. The ReservationSection inside auto-opens its form
          because draftMode={editOpen} crosses false→true; for CONFIRMED
          stops it pre-fills from the stop's existing confirmation fields
          (form state is initialized from stop props in its useState). */}
      <div
        className={`grid transition-all duration-300 ease-in-out ${editOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      >
        <div className="overflow-hidden">
          <div
            style={{
              padding: '4px 16px 16px',
              borderTop: '0.5px solid #9FBF8A',
            }}
          >
            {/* Pre-filled reservation form — same component, same save path
                (tripsApi.updateStop). draftMode=editOpen forces the form to
                open as the expansion opens; the save logic skips the
                draft-commit branch for already-CONFIRMED stops so it
                writes field updates only, not a re-commit. */}
            <ReservationSection
              key={stop.id}
              stop={stop}
              cg={cg}
              draftMode={editOpen}
              onSaved={data => onStopUpdated(stop.id, data)}
            />

            {/* Alternates toggle — per the design call, the affordance to
                "see other campgrounds" survives for booked stops but lives
                one click deep so the resting row stays clean. The list
                itself still animates open below the card via the page-
                level expandedAlts state — only the toggle button is here. */}
            {altCount > 0 && (
              <div className="pt-3 mt-3" style={{ borderTop: '0.5px solid #9FBF8A' }}>
                <button
                  onClick={onToggleAlts}
                  className="transition-colors hover:underline"
                  style={{ color: '#185FA5', fontSize: 13 }}
                >
                  {altsExpanded
                    ? 'Hide other options'
                    : `See other campgrounds (${altCount} option${altCount !== 1 ? 's' : ''}) →`}
                </button>
                <p className="text-xs text-gray-500 mt-1 leading-snug">
                  Dates fell through at the campground? Compare alternates without unbooking first.
                </p>
              </div>
            )}

            {/* Destructive unbook — one click deeper than the prior inline
                Unbook link, matched with explanatory subtext so accidental
                clicks are unlikely. Same handler as before — opens the
                page-level ConfirmModal via setUnbookTarget(stop). */}
            <div className="pt-3 mt-3" style={{ borderTop: '0.5px solid #9FBF8A' }}>
              <button
                onClick={onUnbook}
                className="text-red-600 hover:underline transition-colors"
                style={{ fontSize: 13 }}
              >
                Unbook this stop
              </button>
              <p className="text-xs text-gray-500 mt-1 leading-snug">
                Clears your confirmation number, site number, and times here. Doesn't cancel anything with the campground.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Recommended campground card (primary recommendation per stop) ───────────

function RecommendedCampgroundCard({
  cg,
  stop,
  prevStop,
  marker,
  draftMode,
  onSelectCampground,
  onStopUpdated,
  membershipLabels,
  altCount,
  altsExpanded,
  onToggleAlts,
}: {
  cg: Campground
  stop: Stop
  // Previous stop in the trip — used for "~N mi from previous stop" line.
  prevStop?: Stop
  // The display marker ("1"–"N") for the numbered circle in the card header.
  // Computed at the page level via stopDisplayNumbers / formatStopBadgeMarker.
  marker: string
  draftMode: boolean
  onSelectCampground: () => void
  onStopUpdated: (stopId: string, data: Partial<Stop>) => void
  membershipLabels: string[]
  // B3 — alternates toggle moved from below the card into the card's contact
  // row, right-aligned. altCount is altOptions.length at the page level; the
  // page still owns the expand state and renders the animated list below the
  // card so the toggle action stays a one-liner here.
  altCount: number
  altsExpanded: boolean
  onToggleAlts: () => void
  // B4 — onUnbook dropped: booked stops now route to BookedRowCard (a
  // separate component in this file), which owns the unbook trigger inside
  // its Edit expansion. RecommendedCampgroundCard only renders for unbooked
  // stops, so an unbook handler here would be unreachable.
}) {
  // B4 — isConfirmed left here defensively for the edge case where a stop's
  // bookingStatus is CONFIRMED but its campgroundId doesn't match any
  // currently-loaded campground (so renderStopContent falls through to
  // RecommendedCampgroundCard rather than BookedRowCard). In the common
  // case this is always false because the parent routes confirmed stops
  // to BookedRowCard. Used below to suppress the action row + contact row
  // so the user isn't prompted to book again in that edge case.
  const isConfirmed = stop.campgroundId === cg.id && stop.bookingStatus === 'CONFIRMED'
  // B3 — Directions URL replaces the old "Map" link. Switches Google Maps'
  // mode from /search/ to /dir/?api=1&destination= so a click drops the user
  // straight into turn-by-turn navigation from their current location.
  const directionsUrl = cg.latitude && cg.longitude
    ? `https://www.google.com/maps/dir/?api=1&destination=${cg.latitude},${cg.longitude}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([cg.name, cg.address].filter(Boolean).join(' '))}`

  // B3 — composed description line: "~$N/night · full hookups · fits your rig".
  // Each part is gated independently so the line gracefully omits whatever
  // isn't reliably populated (no "·" with nothing after). Spec acknowledged
  // these signals may not always be present.
  //
  // Rate fallback: cg.siteRate is unreliable for AI-only candidates — the
  // campground search endpoint can't always produce a published rate (no
  // RIDB/Places hit with pricing). Stop.siteRate IS reliably populated
  // by AI generation as a typical-for-this-location estimate and is also
  // what feeds the header's trip-total — so when cg.siteRate is missing
  // we read stop.siteRate so the price doesn't vanish from the card.
  // After booking, Stop.siteRate is the actual chosen campground's rate
  // (the booking save copies it from cg), so the fallback stays correct.
  const ratePerNight = (cg.siteRate != null && cg.siteRate > 0)
    ? cg.siteRate
    : (stop.siteRate != null && stop.siteRate > 0 ? stop.siteRate : null)
  const descParts: string[] = []
  if (ratePerNight != null) descParts.push(`~$${ratePerNight}/night`)
  if (cg.hookupTypes?.some(h => /full/i.test(h))) descParts.push('full hookups')
  if (cg.isCompatible !== false) descParts.push('fits your rig')

  return (
    <div
      className="bg-white mb-3"
      style={{
        border: '1px solid #E8E4DA',
        borderRadius: 8,
        padding: '16px 18px',
      }}
    >
      {/* B4 — Booked banner dropped from this card. Confirmed stops route to
          BookedRowCard now (see renderStopContent below). This component
          only renders for unbooked stops in the common case; isConfirmed
          stays referenced for the edge case where renderStopContent falls
          through here due to a missing bookedCg lookup, but the banner
          itself is gone. */}

      {/* Header row — numbered circle + type icon + name-led title + type pill */}
      <StopHeaderBlock stop={stop} prevStop={prevStop} marker={marker} leadName={cg.name} />

      {/* Body — indented to align past the 26px circle + 12px gap (≈38px).
          Carries the rating, description, action row, and contact row. */}
      <div style={{ marginLeft: 38, marginTop: 12 }}>
        {/* Rating + address row — "Rating 4.1/5 · address" */}
        {(cg.rating != null || cg.address) && (
          <p className="text-gray-500" style={{ fontSize: 12 }}>
            {cg.rating != null && (
              <>
                Rating <span className="text-gray-800 font-medium">{cg.rating.toFixed(1)}</span>
                <span className="text-gray-400">/5</span>
              </>
            )}
            {cg.rating != null && cg.address && <span className="text-gray-300">{' · '}</span>}
            {cg.address && <span>{cg.address}</span>}
          </p>
        )}

        {/* Composed description — graceful omission per spec */}
        {descParts.length > 0 && (
          <p className="text-gray-500" style={{ fontSize: 13, marginTop: 6 }}>
            {descParts.join(' · ')}
          </p>
        )}

        {/* Action row — outline gold Book button + RV-blue "Already booked?"
            sibling. Gated by !isConfirmed && !draftMode same as before; the
            click handlers are unchanged from prior design (Book opens the
            reservation URL in a new tab without touching local state; Already
            booked opens the inline ReservationSection draft). */}
        {!isConfirmed && !draftMode && (
          <>
            <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 12 }}>
              {cg.reservationUrl && (
                <button
                  onClick={() => window.open(cg.reservationUrl!, '_blank', 'noopener,noreferrer')}
                  className="inline-flex items-center gap-1.5 transition-colors hover:bg-[#BA7517]/5"
                  style={{
                    color: '#BA7517',
                    border: '1px solid #BA7517',
                    background: 'transparent',
                    fontSize: 13,
                    fontWeight: 500,
                    padding: '7px 14px',
                    borderRadius: 6,
                  }}
                >
                  <ExternalLink size={13} />
                  Book at {truncateName(cg.name)}
                </button>
              )}
              <button
                onClick={onSelectCampground}
                className="hover:underline underline-offset-2 transition-colors"
                style={{ color: '#185FA5', fontSize: 13 }}
              >
                Already booked? Record conf #
              </button>
            </div>
            {cg.reservationUrl && (
              <p className="text-xs text-gray-500 mt-2 leading-snug">
                Opens the campground's site — you book directly with them.
              </p>
            )}
            {membershipLabels.length > 0 && (
              <p className="text-xs text-gray-500 mt-1 leading-snug">
                {formatMembershipNudge(membershipLabels)}
              </p>
            )}
          </>
        )}

        {/* Contact row — Phone + Website + Directions (replaces the duplicate
            reservationUrl link) + (right-aligned) See other campgrounds toggle */}
        <div
          className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-3 pt-2.5 border-t border-gray-100"
          style={{ borderTopWidth: '0.5px' }}
        >
          {cg.phone && (
            <a
              href={`tel:${cg.phone}`}
              className="flex items-center gap-1.5 transition-colors hover:underline"
              style={{ color: '#185FA5', fontSize: 12 }}
            >
              <Phone size={11} />{cg.phone}
            </a>
          )}
          {cg.website && (
            <a
              href={cg.website}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 transition-colors hover:underline"
              style={{ color: '#185FA5', fontSize: 12 }}
            >
              <Globe size={11} /> Website
            </a>
          )}
          <a
            href={directionsUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 transition-colors hover:underline"
            style={{ color: '#185FA5', fontSize: 12 }}
          >
            <MapPin size={11} /> Directions
          </a>
          {altCount > 0 && (
            <button
              onClick={onToggleAlts}
              className="ml-auto flex items-center gap-1 transition-colors hover:underline"
              style={{ color: '#185FA5', fontSize: 12 }}
            >
              {altsExpanded
                ? 'Hide other options'
                : `See other campgrounds (${altCount} option${altCount !== 1 ? 's' : ''}) →`
              }
            </button>
          )}
        </div>
      </div>

      {/* ReservationSection — draft form for "Already booked? Record conf #".
          Kept outside the indented body so the form has full card width. */}
      <ReservationSection
        key={stop.id}
        stop={stop}
        cg={cg}
        draftMode={draftMode}
        onSaved={data => onStopUpdated(stop.id, data)}
      />
    </div>
  )
}

// ─── Alternate campground card (shown in expanded alternatives list) ─────────

function AlternateCampgroundCard({
  cg,
  stop,
  primary,
  draftMode,
  onSelectCampground,
  membershipLabels,
}: {
  cg: Campground
  stop: Stop
  // The currently-recommended campground for this stop. Used both as the anchor for the
  // distance line ("X mi from {primary.name}") and to size context vs. the primary card.
  primary: Campground | null
  // True only when *this specific alt* is the active draft for the stop. In practice the
  // draft alt is promoted to the primary slot and filtered out of altOptions, so this is
  // defensive — kept to mirror the primary card's draftMode visibility logic.
  draftMode: boolean
  onSelectCampground: () => void
  // Same shape/source as on the primary card — see RecommendedCampgroundCard.
  membershipLabels: string[]
}) {
  const isConfirmed = stop.campgroundId === cg.id && stop.bookingStatus === 'CONFIRMED'
  const dist = calcDistance(primary?.latitude, primary?.longitude, cg.latitude, cg.longitude)
  const distLabel = dist
    ? primary?.name
      ? `${dist} mi from ${primary.name}`
      : `${dist} mi away`
    : null

  const mapQuery = [cg.name, cg.address].filter(Boolean).join(' ')
  const mapUrl = cg.latitude && cg.longitude
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cg.name)}&ll=${cg.latitude},${cg.longitude}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`

  return (
    <div className={`rounded-lg border bg-white p-3 transition-colors ${
      isConfirmed ? 'border-[#3E5540]/30 bg-[#DCE5D5]/20' : 'border-gray-200'
    }`} style={{ borderWidth: '0.5px' }}>
      {/* Booked pill — only when the user happened to commit to this specific alt. In
          practice the booked cg is promoted to the recommended slot, so this is defensive.
          No Unbook button here — the primary card already exposes that affordance. */}
      {isConfirmed && (
        <div className="flex items-center gap-1.5 text-xs font-semibold rounded-lg px-2.5 py-1.5 mb-2.5 border text-[#2F4030] bg-[#DCE5D5] border-[#3E5540]/30">
          <CheckCircle size={12} />
          <span>Booked</span>
        </div>
      )}

      {/* Name + rating */}
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-medium text-gray-900 leading-snug min-w-0 flex-1">{cg.name}</h4>
        {cg.rating != null && (
          <span className="text-xs text-amber-500 flex-shrink-0">★ {cg.rating.toFixed(1)}</span>
        )}
      </div>

      {/* Address */}
      {cg.address && (
        <div className="flex items-center gap-1 mt-0.5 text-xs text-gray-500">
          <MapPin size={10} className="flex-shrink-0" />{cg.address}
        </div>
      )}

      {/* Distance from primary */}
      {distLabel && (
        <p className="text-xs text-gray-600 mt-0.5">{distLabel}</p>
      )}

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5 mt-2">
        {cg.hookupTypes?.map(h => <span key={h} className="badge-green text-xs">{h}</span>)}
        {cg.isPetFriendly && <span className="badge-blue text-xs">🐾 Pets OK</span>}
        {cg.maxRigLength && <span className="badge text-xs bg-gray-100 text-gray-600">Max {cg.maxRigLength}ft</span>}
        {cg.isMilitaryOnly && <span className="badge text-xs bg-blue-50 text-blue-700">🎖️ Military</span>}
        {cg.siteRate != null && <span className="badge text-xs bg-gray-100 text-gray-600">${cg.siteRate}/nt</span>}
      </div>

      {/* Contact links — same pattern as primary card's footer so users can phone /
          click out to Recreation.gov / open Map without committing to an alt first. */}
      <div className="flex items-center gap-4 mt-3 pt-2.5 border-t border-gray-100" style={{ borderTopWidth: '0.5px' }}>
        {cg.phone && (
          <a href={`tel:${cg.phone}`} className="flex items-center gap-1 text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors">
            <Phone size={11} />{cg.phone}
          </a>
        )}
        {cg.website && (
          <a href={cg.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors">
            <Globe size={11} /> Website
          </a>
        )}
        {cg.reservationUrl && (
          <a href={cg.reservationUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors">
            <ExternalLink size={11} /> {reservationLinkLabel(cg.reservationUrl)}
          </a>
        )}
        <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-gray-400 hover:text-[#1F6F8B] transition-colors ml-auto">
          <MapPin size={11} /> Map
        </a>
      </div>

      {/* Gold button — same visibility logic as the primary card: hidden once this alt is
          confirmed or while it's the active draft (it's been promoted to the primary slot).
          Label differs from the primary card on purpose: on an alt this action *promotes*
          the campground to the recommended slot, not just opens the form. */}
      {!isConfirmed && !draftMode && (
        <>
          <button
            onClick={() => {
              if (cg.reservationUrl) window.open(cg.reservationUrl, '_blank', 'noopener,noreferrer')
              onSelectCampground()
            }}
            className="bg-rr-gold hover:bg-rr-gold-dark text-white rounded-lg font-medium transition-colors text-sm w-full flex items-center justify-center gap-1.5 py-2.5 mt-3"
          >
            Choose this campground instead
          </button>
          {/* Reservation Honesty: membership reminder — same copy/treatment as on
              the primary card. The alt card has no "Opens the campground's site"
              helper line above it, so the nudge sits directly under the gold
              button. Never claims a discount applies. */}
          {membershipLabels.length > 0 && (
            <p className="text-xs text-gray-500 text-center mt-1.5 leading-snug">
              {formatMembershipNudge(membershipLabels)}
            </p>
          )}
        </>
      )}
    </div>
  )
}

// ─── Towing note modal ───────────────────────────────────────────────────────
// B2 — statusBadge() removed. It only built the "Booked / Not booked /
// Pending / Cancelled" pill for the old sidebar row. The new rail
// communicates state via an 8px green/gray dot; richer states (PENDING,
// CANCELLED, WAITLISTED) collapse to the unbooked dot for now since none
// of those states are reachable from the current booking flow (we only
// flip NOT_BOOKED ↔ CONFIRMED via tripsApi.updateStop). If/when those
// other statuses become user-facing we can re-introduce richer signaling
// on the dot or in a per-row aside.
// Lifted out of the per-card advisory (formerly rendered inline under every
// unbooked RecommendedCampgroundCard for users with rig.isTowing=true). Same
// underlying point: campgrounds disagree on whether the towed vehicle counts
// toward site-length limits, and we can't pre-classify them — surface the
// nuance once so users know to ask. Matches RigInfoModal's structural pattern
// (backdrop + centered card + escape to close).

function TowingNoteModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="towing-note-modal-title"
        className="bg-white rounded-xl w-full max-w-md overflow-hidden shadow-xl"
        style={{ borderWidth: '0.5px', borderStyle: 'solid', borderColor: '#E8E4DA' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start justify-between mb-4">
            <h2 id="towing-note-modal-title" className="font-medium text-gray-900 text-lg flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500" />
              Towing note
            </h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1 -mt-1 -mr-1 rounded-lg hover:bg-gray-100"
            >
              <X size={18} />
            </button>
          </div>
          <div className="text-sm text-gray-600 leading-relaxed space-y-3">
            <p>
              Some campgrounds (often national parks) count your towed vehicle
              toward site-length limits. Others (often private parks) only count
              the RV itself.
            </p>
            <p>
              There's no reliable per-campground convention for which is which,
              so it's worth asking when you call — it's the question that
              prevents an unpleasant surprise at check-in.
            </p>
          </div>
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="bg-[#1F6F8B] text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-[#134756] transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TripBookingPage() {
  const { id } = useParams<{ id: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [campgrounds, setCampgrounds] = useState<Record<string, Campground[]>>({})
  const [loading, setLoading] = useState(true)
  const [activeStop, setActiveStop] = useState<string | null>(null)
  // per-stop expand/collapse alternatives
  const [expandedAlts, setExpandedAlts] = useState<Record<string, boolean>>({})
  // Reservation Honesty: clicking the gold button records the user's chosen campground here
  // *without* writing to the DB. The form expands in draft mode and only the user's "Save
  // reservation info" click (in ReservationSection) commits the booking. Keys are stopIds;
  // presence implies draft mode for that stop. Cleared when the save commits or on unbook.
  const [draftSelections, setDraftSelections] = useState<Record<string, Campground>>({})
  const [unbookTarget, setUnbookTarget] = useState<Stop | null>(null)
  const [unbooking, setUnbooking] = useState(false)
  // Rig info modal state. The default rig is fetched once on mount and shared
  // across all stops' cards so we don't refetch per card open.
  const [rigInfoOpen, setRigInfoOpen] = useState(false)
  // B1 — page-level towing-note modal state, replacing the per-card towing
  // advisory that used to render inline under every unbooked card.
  const [towingNoteOpen, setTowingNoteOpen] = useState(false)
  const [defaultRig, setDefaultRig] = useState<Rig | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { hasAccess, user } = useAuthStore()
  const { openPaywall } = useUIStore()

  // Active, non-expired memberships → human labels via MEMBERSHIP_TYPES. The
  // server's /auth/me already filters to isActive:true (controllers/auth.ts
  // getMe), so the isActive check below is defense-in-depth; the expiresAt
  // check is NOT redundant because the server does not filter on expiry.
  // De-duped via Set so a user with two records of the same type (e.g. two
  // GOOD_SAM rows) doesn't see the label printed twice in the nudge.
  // Used by both campground cards to render the "you have these — ask if any
  // save you money here" nudge. Empty array hides the nudge entirely.
  const membershipLabels: string[] = [...new Set(
    (user?.memberships ?? [])
      .filter(m => m.isActive && (!m.expiresAt || new Date(m.expiresAt) > new Date()))
      .map(m => MEMBERSHIP_TYPES.find(t => t.id === m.type)?.label)
      .filter((l): l is string => !!l)
  )]

  // Pull the user's default rig once. If they have no rig (or no default flag
  // set), we still render the modal but it shows an empty state with a link
  // to /profile/rig. .catch is a no-op — failing to load the rig should never
  // block the booking page.
  useEffect(() => {
    usersApi.getRigs().then(res => {
      const rigs = (res.data ?? []) as Rig[]
      const def = rigs.find(r => r.isDefault) ?? rigs[0] ?? null
      setDefaultRig(def)
    }).catch(() => {})
  }, [])

  // Load trip — honor ?stopId param from incoming navigation
  useEffect(() => {
    if (!hasAccess('campgroundBooking')) {
      // Empty shell behind the modal — route dismissals to /dashboard so
      // the user has a clear exit instead of a blank page. Mirrors the
      // same intent on Ohv/Van destinations pages.
      openPaywall('campgroundBooking', { redirectOnDismiss: '/dashboard' })
      // Critical: clear loading so the page renders an empty state behind the
      // paywall instead of an infinite spinner. Without this, setLoading(false)
      // only fires inside the .then() of the trip fetch, which never runs.
      setLoading(false)
      return
    }
    if (!id) return
    const targetStopId = searchParams.get('stopId')
    tripsApi.get(id).then(res => {
      setTrip(res.data)
      // Default the active stop to the first BOOKABLE entry — both home endpoints
      // are now visible in the list but neither shows a campground card, so
      // landing on one would feel empty. Use the badge helper instead of
      // s.type === 'HOME' so return-home loops (last stop typed DESTINATION)
      // still skip past the finish home stop here.
      const sortedForPicker = [...(res.data.stops ?? [])].sort((a: Stop, b: Stop) => a.order - b.order)
      const pickerBadges = buildStopBadges(sortedForPicker, user)
      const firstBookable = sortedForPicker.find(s => !isHomeBadge(pickerBadges[s.id]))?.id ?? null
      setActiveStop(targetStopId ?? firstBookable)
      setLoading(false)
      // Scroll to the target stop after React renders the sections
      if (targetStopId) setTimeout(() => scrollToStop(targetStopId), 80)
    })
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load campgrounds for ALL stops in parallel when trip loads
  useEffect(() => {
    if (!trip?.stops?.length) return
    // Skip both home endpoints — return-home loops type the last stop as
    // DESTINATION, so the badge helper is the reliable signal here, not
    // stop.type === 'HOME' alone.
    const sortedForFetch = [...trip.stops].sort((a, b) => a.order - b.order)
    const fetchBadges = buildStopBadges(sortedForFetch, user)
    trip.stops.forEach(stop => {
      if (isHomeBadge(fetchBadges[stop.id])) return
      campgroundsApi.search({
        q: stop.locationName,
        lat: stop.latitude,
        lng: stop.longitude,
        // Phase 1B orchestration trigger: backend uses this to load the stop's
        // campgroundCandidates and verify them via Google Places before merging
        // results. Without it the response is RIDB-only.
        stopId: stop.id,
      }).then(res => {
        setCampgrounds(prev => {
          if (prev[stop.id] !== undefined) return prev
          return { ...prev, [stop.id]: res.data }
        })
      }).catch(() => {
        setCampgrounds(prev => ({ ...prev, [stop.id]: [] }))
      })
    })
  }, [trip?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll right panel to a stop section, sync internal state, and reflect
  // the chosen stop in the URL so refresh / share keeps the user on the same
  // stop. replace: true so each row click doesn't pollute browser history
  // (one back-press still returns to the previous page, not the previous
  // sidebar click). B2 — used to only update internal state; the URL update
  // is the new piece.
  function scrollToStop(stopId: string) {
    setActiveStop(stopId)
    setSearchParams({ stopId }, { replace: true })
    requestAnimationFrame(() => {
      const section = document.getElementById(`stop-section-${stopId}`)
      const panel   = contentRef.current
      if (section && panel) {
        const offset = section.getBoundingClientRect().top - panel.getBoundingClientRect().top
        panel.scrollBy({ top: offset - 12, behavior: 'smooth' })
      }
    })
  }

  // B2 — handleContentScroll removed. Previously this updated activeStop
  // based on which section was visible in the right panel, but the only
  // consumer of activeStop on desktop was the sidebar's blue-highlight
  // visual, which the redesign drops. Mobile still reads activeStop for
  // its tab-bar active fill and single-stop content filter, both driven
  // by click handlers — scroll position doesn't apply there (mobile
  // renders one stop at a time, no scroll-through).

  // Reservation Honesty: gold button now opens the form in *draft mode* only — no DB write.
  // The user's "Save reservation info" click is the actual commit (see ReservationSection.save).
  // Storing the chosen campground here also lets renderStopContent promote it as the
  // recommended display (so clicking gold on an alt swaps the recommended card to that alt).
  function handleSelectCampground(stop: Stop, cg: Campground) {
    setDraftSelections(prev => ({ ...prev, [stop.id]: cg }))
  }

  function handleStopUpdated(stopId: string, data: Partial<Stop>) {
    setTrip(prev => {
      if (!prev) return prev
      const updatedStops = prev.stops?.map(s => s.id === stopId ? { ...s, ...data } : s)
      // Recompute the trip-level camp total when a save touches booking status or rate —
      // the footer/header summary needs to reflect a draft commit (NOT_BOOKED → CONFIRMED).
      if (data.bookingStatus !== undefined || data.siteRate !== undefined) {
        const estimatedCamp = updatedStops?.reduce(
          (sum, s) => s.bookingStatus === 'CONFIRMED' && s.siteRate ? sum + s.siteRate * s.nights : sum,
          0
        ) ?? 0
        return { ...prev, stops: updatedStops, estimatedCamp }
      }
      return { ...prev, stops: updatedStops }
    })
    // Reservation Honesty: a draft commit (save with bookingStatus=CONFIRMED) ends draft
    // mode for that stop — drop the entry so the gold button stays hidden behind the now-
    // visible "Booked" pill, not because of stale draft state.
    if (data.bookingStatus === 'CONFIRMED') {
      setDraftSelections(prev => {
        if (!prev[stopId]) return prev
        const next = { ...prev }
        delete next[stopId]
        return next
      })
    }
  }

  async function handleUnbook() {
    if (!unbookTarget || !trip || unbooking) return
    setUnbooking(true)
    try {
      await tripsApi.updateStop(trip.id, unbookTarget.id, { bookingStatus: 'NOT_BOOKED' })
      setTrip(prev => {
        if (!prev) return prev
        const updatedStops = prev.stops?.map(s =>
          s.id === unbookTarget.id
            ? {
                ...s,
                bookingStatus: 'NOT_BOOKED' as any,
                // Mirror the backend's reservation-detail clear (see updateStop in trips.ts)
                // so the local prop matches the DB and ReservationSection's reset useEffect
                // sees empty values when it mirrors the prop.
                confirmationNum: undefined,
                siteNumber: undefined,
                checkInTime: undefined,
                checkOutTime: undefined,
                notes: undefined,
              }
            : s
        )
        const estimatedCamp = updatedStops?.reduce(
          (sum, s) => s.bookingStatus === 'CONFIRMED' && s.siteRate ? sum + s.siteRate * s.nights : sum,
          0
        )
        return { ...prev, stops: updatedStops, estimatedCamp }
      })
      // Defensive: an unbooked stop has no draft selection either.
      setDraftSelections(prev => {
        if (!prev[unbookTarget.id]) return prev
        const next = { ...prev }
        delete next[unbookTarget.id]
        return next
      })
      setUnbookTarget(null)
    } catch (err) {
      console.error('Failed to unbook stop', err)
      alert('Could not unbook. Please try again.')
    } finally {
      setUnbooking(false)
    }
  }

  if (loading) return (
    <div className="flex justify-center py-20">
      <div className="w-6 h-6 border-2 border-[#1F6F8B] border-t-transparent rounded-full animate-spin" />
    </div>
  )
  if (!trip) return null

  const sortedStops        = [...(trip.stops ?? [])].sort((a, b) => a.order - b.order)
  const stopDisplayNumbers = buildStopBadges(sortedStops, user)
  // Badge-based: catches return-home loops where the last stop is typed
  // DESTINATION but the helper flags it 'H' via homeCity match.
  const bookableStops = sortedStops.filter(s => !isHomeBadge(stopDisplayNumbers[s.id]))
  const bookedCount   = sortedStops.filter(s => s.bookingStatus === 'CONFIRMED').length
  const incompatCount = sortedStops.filter(s => !s.isCompatible).length
  // Trip total — uses actuals when available, falls back to the AI estimate
  // for unbooked stops. Fees are only added for stops where the user has
  // actually entered them (actualRate present); never inflated by phantom
  // fees on still-estimated stops. Mirrors the estimate→actual pattern
  // used by the itinerary drive-day card's RateLine helper.
  const totalCampCost = sortedStops.reduce((sum, s) => {
    const ratePerNight = s.actualRate ?? s.siteRate
    if (!ratePerNight) return sum
    const fees = s.actualRate != null ? (s.actualFees ?? 0) : 0
    return sum + ratePerNight * s.nights + fees
  }, 0)
  // Label switches to "camp total" once any booked stop has an actualRate
  // entered — the number now reflects real costs as the user records them
  // and "est." would understate that honesty.
  const anyActuals = sortedStops.some(s => s.actualRate != null)
  const totalLabel = anyActuals ? 'camp total' : 'est. camp total'

  // ── Home endpoint row: Start / Finish header, no campground card ──
  // Home stops are now visible on this page for symmetry with the Map and
  // Summary views. Booking doesn't apply here — render a subdued header so
  // users see the trip's structural endpoints without being prompted to book.
  function renderHomeRow(stop: Stop, badge: ReturnType<typeof buildStopBadges>[string]) {
    return (
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-400 text-white text-sm font-bold flex-shrink-0 shadow-sm">
          {formatStopBadgeMarker(badge)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {formatStopBadgeLabel(badge)}
          </p>
          <p className="text-sm text-gray-700 truncate">
            {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
          </p>
        </div>
      </div>
    )
  }

  // ── Per-stop content: recommended card + animated alternates list ──
  // B3 — the standalone destination header above the card was folded into
  // RecommendedCampgroundCard (and into the StopHeaderBlock used by the
  // fallback cards), and the standalone "See other campgrounds" toggle was
  // folded into the card's contact row. The animated alternates list still
  // renders here below the card, gated on the page-level expandedAlts state
  // that the in-card toggle button mutates.
  function renderStopContent(stop: Stop, prevStop?: Stop) {
    const cgs       = campgrounds[stop.id]
    const isLoaded  = cgs !== undefined
    const compatible = (cgs ?? []).filter(cg => cg.isCompatible !== false)
    const confirmed  = stop.bookingStatus === 'CONFIRMED'
    const showAlts   = expandedAlts[stop.id] ?? false

    // If the stop is already booked, surface the booked campground as the recommendation.
    const bookedCg = confirmed && stop.campgroundId
      ? (cgs ?? []).find(cg => cg.id === stop.campgroundId) ?? null
      : null
    // Reservation Honesty: while a draft is active we promote the user's gold-button choice
    // to the recommended slot so the form (which lives inside RecommendedCampgroundCard)
    // shows under the right campground — even when they picked an alt rather than the default.
    const draftCg = !confirmed && draftSelections[stop.id]
      ? (cgs ?? []).find(cg => cg.id === draftSelections[stop.id].id) ?? draftSelections[stop.id]
      : null
    const recommended = bookedCg ?? draftCg ?? compatible[0] ?? null
    const altOptions  = compatible.filter(cg => cg.id !== recommended?.id)
    const stopDraftMode = !!draftSelections[stop.id]

    // Was the first returned campground incompatible? (means we promoted an alternative)
    const originalWasIncompat = !confirmed && (cgs ?? []).length > 0 && cgs![0].isCompatible === false

    // B3 — marker for the numbered circle in the card header. Pulled from the
    // page-level stopDisplayNumbers map and formatted to the literal "1"–"N"
    // letter/number used everywhere else on this page.
    const marker = formatStopBadgeMarker(stopDisplayNumbers[stop.id])

    return (
      <>
        {/* Incompatibility promotion note — preserved from prior design;
            sits above the card as a one-time alert about how the AI ended
            up picking this alternative over its original (rig-incompatible)
            first choice. Not folded into the card itself because it's a
            meta-explanation about the recommendation, not content of it. */}
        {originalWasIncompat && recommended && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3 text-xs text-amber-700">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-amber-500" />
            Your original suggestion wasn't compatible with your rig — we found this alternative instead
          </div>
        )}

        {/* Recommended campground card OR booked collapsed row OR fallback —
            all three share the new visual language (StopHeaderBlock for the
            unbooked / fallback cases, dedicated pale-green collapsed layout
            for the booked case). */}
        {!isLoaded ? (
          <div className="rounded-xl border border-gray-100 bg-gray-50 h-[140px] animate-pulse mb-3" />
        ) : confirmed && bookedCg ? (
          // B4 — Booked stops collapse to a single pale-green row. Edit
          // expansion (inside BookedRowCard) hosts the pre-filled
          // ReservationSection, the alternates toggle, and the destructive
          // Unbook action.
          <BookedRowCard
            stop={stop}
            cg={bookedCg}
            marker={marker}
            onStopUpdated={handleStopUpdated}
            onUnbook={() => setUnbookTarget(stop)}
            altCount={altOptions.length}
            altsExpanded={showAlts}
            onToggleAlts={() => setExpandedAlts(prev => ({ ...prev, [stop.id]: !(prev[stop.id] ?? false) }))}
          />
        ) : recommended ? (
          <RecommendedCampgroundCard
            cg={recommended}
            stop={stop}
            prevStop={prevStop}
            marker={marker}
            draftMode={stopDraftMode}
            onSelectCampground={() => handleSelectCampground(stop, recommended)}
            onStopUpdated={handleStopUpdated}
            membershipLabels={membershipLabels}
            altCount={altOptions.length}
            altsExpanded={showAlts}
            onToggleAlts={() => setExpandedAlts(prev => ({ ...prev, [stop.id]: !(prev[stop.id] ?? false) }))}
          />
        ) : cgs?.length === 0 ? (
          // Reservation Honesty: when RIDB returns nothing for this location, surface
          // the gap honestly and link the user to Google Maps so they can keep moving.
          // Same card chrome as a populated card to avoid layout shift; the new
          // StopHeaderBlock keeps the city + dates + type visible.
          <div
            className="bg-white mb-3"
            style={{ border: '1px solid #E8E4DA', borderRadius: 8, padding: '16px 18px' }}
          >
            <StopHeaderBlock
              stop={stop}
              prevStop={prevStop}
              marker={marker}
              leadName={`No campgrounds found near ${stop.locationName}`}
            />
            <div style={{ marginLeft: 38, marginTop: 12 }}>
              <p className="text-xs text-gray-500 leading-relaxed">
                We couldn't find verified campgrounds near this stop. Try Google
                Maps for private RV parks, BLM dispersed camping, or other options.
              </p>
              <a
                href={`https://www.google.com/maps/search/${encodeURIComponent(`campgrounds near ${stop.locationName}${stop.locationState ? ', ' + stop.locationState : ''}`)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 transition-colors hover:bg-[#BA7517]/5 mt-3"
                style={{
                  color: '#BA7517',
                  border: '1px solid #BA7517',
                  background: 'transparent',
                  fontSize: 13,
                  fontWeight: 500,
                  padding: '7px 14px',
                  borderRadius: 6,
                }}
              >
                <MapPin size={13} /> Search Google Maps near {stop.locationName}
              </a>
            </div>
          </div>
        ) : (
          <div
            className="bg-white mb-3"
            style={{ border: '1px solid #E8E4DA', borderRadius: 8, padding: '16px 18px' }}
          >
            <StopHeaderBlock
              stop={stop}
              prevStop={prevStop}
              marker={marker}
              leadName="No compatible campgrounds found"
            />
            <div style={{ marginLeft: 38, marginTop: 12 }}>
              <p className="text-xs text-gray-500 leading-relaxed">
                None of the campgrounds we found near this stop are compatible
                with your rig (length, height, or other constraints). Update
                your rig profile or search Google Maps for alternatives.
              </p>
            </div>
          </div>
        )}

        {/* Animated alternates list — toggle button moved into the card's
            contact row; the list itself still renders here below the card
            so its expand/collapse animation has full content-area width.
            Visible whether or not the stop is booked: the user comment on
            the prior implementation noted that a user might commit to one
            campground then need to compare other options without unbooking
            first (e.g. Recreation.gov dates fall through). */}
        {isLoaded && altOptions.length > 0 && (
          <div className={`grid transition-all duration-300 ease-in-out ${showAlts ? 'grid-rows-[1fr] mb-3' : 'grid-rows-[0fr]'}`}>
            <div className="overflow-hidden">
              <div className="space-y-2">
                {altOptions.map(cg => (
                  <AlternateCampgroundCard
                    key={cg.id}
                    cg={cg}
                    stop={stop}
                    primary={recommended}
                    // Per-alt draft check (not stopDraftMode): only THIS alt should suppress
                    // its gold button while it's the active draft. Other alts in the list
                    // stay clickable so the user can switch drafts before committing.
                    draftMode={draftSelections[stop.id]?.id === cg.id}
                    onSelectCampground={() => handleSelectCampground(stop, cg)}
                    membershipLabels={membershipLabels}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    // Break out of layout padding, fill viewport like the map page
    <div className="-mx-4 -my-6 h-[calc(100dvh-3.5rem)] flex flex-col">

      {/* B1 — Consolidated header strip. Replaces the old breadcrumb-only
          strip and absorbs the right-column sticky header. Hosts:
            · Breadcrumb (Bookings › trip name)
            · Page title + trip-total estimate on the title row
            · Hairline + an info strip carrying the booked-progress count,
              the bed/tent legend that maps to the sidebar and card icons,
              and the "My rig info" + "Towing note" triggers that used to
              repeat under every unbooked campground card. */}
      <div className="flex-shrink-0 bg-white border-b border-gray-100">
        {/* Breadcrumb */}
        <div className="px-4 md:px-6 pt-3 pb-1 flex items-center gap-1.5 text-xs">
          <Link
            to="/dashboard?tab=reservations"
            className="text-[#1F6F8B] hover:text-[#134756] transition-colors"
          >
            Bookings
          </Link>
          <span className="text-gray-300">·</span>
          <Link
            to={`/trips/${id}/map`}
            className="text-[#1F6F8B] hover:text-[#134756] transition-colors truncate max-w-[260px]"
          >
            {trip.name}
          </Link>
        </div>

        {/* Title row */}
        <div className="px-4 md:px-6 pb-3 flex items-start justify-between gap-4">
          <h1 className="font-medium text-gray-900" style={{ fontSize: 20, lineHeight: 1.3 }}>
            Book your campgrounds
          </h1>
          {totalCampCost > 0 && (
            <div className="text-right flex-shrink-0">
              <p className="font-medium text-gray-900" style={{ fontSize: 16, lineHeight: 1.2 }}>
                ${totalCampCost.toLocaleString()}
              </p>
              <p className="text-[11px] text-gray-400 mt-0.5">{totalLabel}</p>
            </div>
          )}
        </div>

        {/* Hairline divider */}
        <div className="border-t border-gray-100" style={{ borderTopWidth: '0.5px' }} />

        {/* Info strip — progress, legend, references */}
        <div className="px-4 md:px-6 py-2 flex items-center gap-x-3 gap-y-1.5 flex-wrap text-xs">
          <span className="flex items-center gap-1.5 text-gray-500">
            <CheckCircle size={13} className="text-[#1F6F8B]" />
            <span>
              <span className="font-medium text-gray-800">{bookedCount}</span>
              <span className="text-gray-500"> of {bookableStops.length} booked</span>
            </span>
          </span>
          <span className="text-gray-300">·</span>
          <span className="flex items-center gap-1.5 text-gray-500" title="overnight stop">
            <Bed size={13} className="flex-shrink-0" style={{ color: '#5F5E5A' }} />
            <span>overnight stop</span>
          </span>
          <span className="text-gray-300">·</span>
          <span className="flex items-center gap-1.5 text-gray-500" title="multi-night stay">
            <Tent size={13} className="flex-shrink-0" style={{ color: '#BA7517' }} />
            <span>multi-night stay</span>
          </span>
          <span className="text-gray-300">·</span>
          <button
            type="button"
            onClick={() => setRigInfoOpen(true)}
            className="flex items-center gap-1.5 text-[#1F6F8B] hover:text-[#134756] transition-colors"
          >
            <BadgeInfo size={13} className="flex-shrink-0" />
            My rig info
          </button>
          {defaultRig?.isTowing && (
            <>
              <span className="text-gray-300">·</span>
              <button
                type="button"
                onClick={() => setTowingNoteOpen(true)}
                className="flex items-center gap-1.5 text-[#1F6F8B] hover:text-[#134756] transition-colors"
              >
                <AlertTriangle size={13} className="flex-shrink-0 text-amber-500" />
                Towing note
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── MOBILE: horizontal tab bar (hidden on md+) ── B2 — added the
          bed/tent icon next to each non-home tab so the icon-language
          stays consistent across the page-header legend, this mobile
          tab bar, the desktop sidebar, and the upcoming B3 cards. The
          active-state blue fill stays because the tab bar IS the only
          navigation on mobile — without it the user can't tell which
          stop they're viewing in the single-stop content area below. */}
      <div className="md:hidden flex-shrink-0 bg-white border-b border-gray-100 overflow-x-auto">
        <div className="flex gap-1.5 p-3">
          {sortedStops.map(stop => {
            const badge = stopDisplayNumbers[stop.id]
            const isHome = isHomeBadge(badge)
            const isActive = activeStop === stop.id
            const showTent = !isHome && stop.type !== 'OVERNIGHT_ONLY'
            return (
              <button
                key={stop.id}
                onClick={() => setActiveStop(stop.id)}
                className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border transition-colors ${
                  isActive
                    ? 'bg-[#1F6F8B] text-white border-[#1F6F8B]'
                    : isHome
                      ? 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
                      : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
                style={{ borderWidth: '0.5px' }}
              >
                <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-semibold ${
                  isActive ? 'bg-white/20' : 'bg-gray-100 text-gray-600'
                }`}>
                  {formatStopBadgeMarker(badge)}
                </span>
                {/* Bed/Tent icon — skipped on home tabs. White when the
                    tab is active so the icon reads against the blue fill. */}
                {!isHome && (
                  showTent
                    ? <Tent size={11} style={{ color: isActive ? '#FFFFFF' : '#BA7517' }} />
                    : <Bed size={11} style={{ color: isActive ? '#FFFFFF' : '#5F5E5A' }} />
                )}
                <span className="max-w-[90px] truncate">
                  {isHome ? formatStopBadgeLabel(badge) : stop.locationName}
                </span>
                {!isHome && stop.bookingStatus === 'CONFIRMED' && (
                  <CheckCircle size={10} className={isActive ? 'text-white' : 'text-[#3E5540]'} />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Main flex row: sidebar + content ── */}
      <div className="flex flex-1 min-h-0">

        {/* ── DESKTOP sidebar (hidden on mobile) ── B2 restyle.
            Calmer navigation rail: 200px wide, no active-state visual
            (URL ?stopId= sync + right-column scroll do the work),
            booking state communicated by an 8px green/gray dot instead
            of a "Booked / Not booked" text pill, bed/tent icon next to
            each non-home row to match the page header legend and the
            cards in B3, finish-row separated from the numbered stops
            by a hairline. Click handler unchanged — still calls
            scrollToStop, which now also updates ?stopId=. */}
        <aside className="hidden md:flex flex-col w-[200px] flex-shrink-0 border-r border-gray-100 bg-white overflow-hidden">
          {/* Sidebar header — "N stops" only. The trip name + "Campground
              Booking" subtitle moved to the page-level header strip in B1. */}
          <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
            <p
              className="text-[11px] font-semibold uppercase text-gray-400"
              style={{ letterSpacing: '0.04em' }}
            >
              {sortedStops.length} stops
            </p>
          </div>
          {/* Stop nav list */}
          <nav className="flex-1 overflow-y-auto py-1">
            {sortedStops.map(stop => {
              const stopBadge = stopDisplayNumbers[stop.id]
              const isHome    = isHomeBadge(stopBadge)
              const marker    = formatStopBadgeMarker(stopBadge)
              const isFinish  = marker === 'F'
              const isBooked  = stop.bookingStatus === 'CONFIRMED'
              const showTent  = !isHome && stop.type !== 'OVERNIGHT_ONLY'
              return (
                <button
                  key={stop.id}
                  onClick={() => scrollToStop(stop.id)}
                  className="w-full text-left flex items-center gap-2 hover:bg-gray-50 transition-colors"
                  style={{
                    padding: '7px 14px',
                    ...(isFinish ? { borderTop: '0.5px solid #E8E4DA', marginTop: 2, paddingTop: 9 } : {}),
                  }}
                >
                  {/* 8px booking-state dot — green when CONFIRMED, secondary
                      border gray otherwise. Skipped (held space) for home
                      rows since "booked" doesn't apply to a departure. */}
                  <span
                    className="flex-shrink-0 rounded-full"
                    style={{
                      width: 8,
                      height: 8,
                      background: isHome
                        ? 'transparent'
                        : isBooked
                          ? '#1D9E75'
                          : '#E8E4DA',
                    }}
                  />
                  {/* Marker — S / 1..N / F. 12px min-width keeps the column
                      aligned regardless of single- vs double-digit values. */}
                  <span
                    className="text-[11px] flex-shrink-0 text-gray-400"
                    style={{ minWidth: 12 }}
                  >
                    {marker}
                  </span>
                  {/* Bed/Tent icon — skipped on home rows so they read as
                      structural endpoints, not stays. */}
                  {!isHome && (
                    showTent
                      ? <Tent size={13} className="flex-shrink-0" style={{ color: '#BA7517' }} />
                      : <Bed size={13} className="flex-shrink-0" style={{ color: '#5F5E5A' }} />
                  )}
                  {/* City name — secondary tone on home rows since they're
                      structural endpoints, primary on real stops. */}
                  <span
                    className={`flex-1 text-[13px] truncate ${isHome ? 'text-gray-500' : 'text-gray-800'}`}
                  >
                    {isHome ? formatStopBadgeLabel(stopBadge) : stop.locationName}
                  </span>
                  {/* Night count — skipped on home rows. */}
                  {!isHome && (
                    <span className="text-[11px] text-gray-400 flex-shrink-0">
                      {stop.nights}n
                    </span>
                  )}
                  {/* Compatibility alert — preserved from prior design;
                      campgrounds.ts still flags rig-incompatibility per
                      stop, and that signal deserves to stay surfaced on
                      the rail. */}
                  {!isHome && !stop.isCompatible && (
                    <AlertTriangle size={11} className="text-red-400 flex-shrink-0" />
                  )}
                </button>
              )
            })}
          </nav>
        </aside>

        {/* ── Right content column ── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">

          {/* B1 — Sticky right-column header removed; its trip name, booked
              count, and trip-total estimate all moved into the new page-level
              header strip above the main row. Incompatibility count is now
              carried by the bottom sticky footer (until B5 removes that too).
              The scrollable content area is now the immediate first child. */}

          {/* Scrollable content area — onScroll handler removed in B2; see
              the comment on the removed handleContentScroll function. */}
          <div
            ref={contentRef}
            className="flex-1 overflow-y-auto min-h-0"
          >
            {/* DESKTOP: all stops as sections */}
            <div className="hidden md:block">
              {sortedStops.map((stop) => {
                const stopIdx = sortedStops.findIndex(s => s.id === stop.id)
                const badge   = stopDisplayNumbers[stop.id]
                return (
                <section
                  key={stop.id}
                  id={`stop-section-${stop.id}`}
                  data-stop-section={stop.id}
                  className={isHomeBadge(badge)
                    ? 'px-6 py-3 border-b border-gray-100 last:border-0 bg-gray-50/50'
                    : 'px-6 py-6 border-b border-gray-100 last:border-0'}
                >
                  {isHomeBadge(badge)
                    ? renderHomeRow(stop, badge)
                    : renderStopContent(stop, sortedStops[stopIdx - 1])}
                </section>
                )
              })}
            </div>

            {/* MOBILE: single active stop */}
            <div className="md:hidden p-4">
              {sortedStops
                .filter(s => s.id === activeStop)
                .map(stop => {
                  const stopIdx = sortedStops.findIndex(s => s.id === stop.id)
                  const badge   = stopDisplayNumbers[stop.id]
                  return (
                    <div key={stop.id}>
                      {isHomeBadge(badge)
                        ? renderHomeRow(stop, badge)
                        : renderStopContent(stop, sortedStops[stopIdx - 1])}
                    </div>
                  )
                })}
            </div>
          </div>

          {/* Sticky bottom summary bar */}
          <footer className="flex-shrink-0 border-t border-gray-100 bg-white px-4 md:px-6 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <CheckCircle size={12} className="text-[#3E5540]" />
                <span className="font-medium text-gray-700">{bookedCount}</span>/{bookableStops.length} booked
              </span>
              {incompatCount > 0 && (
                <span className="flex items-center gap-1 text-red-400">
                  <AlertTriangle size={11} />
                  {incompatCount} incompatible
                </span>
              )}
            </div>
            {totalCampCost > 0 && (
              <div className="text-xs text-gray-500">
                Camp est. <span className="font-semibold text-gray-800">${totalCampCost.toLocaleString()}</span>
              </div>
            )}
          </footer>
        </div>
      </div>

      <ConfirmModal
        isOpen={unbookTarget !== null}
        title="Unbook this stop?"
        message={`Your confirmation number, site number, check-in/out times, and notes for "${unbookTarget?.campgroundName || 'this campground'}" will be cleared. This can't be undone.`}
        confirmLabel="Unbook and clear details"
        cancelLabel="Keep it"
        onConfirm={handleUnbook}
        onCancel={() => !unbooking && setUnbookTarget(null)}
        isConfirming={unbooking}
      />

      <RigInfoModal
        rig={defaultRig}
        isOpen={rigInfoOpen}
        onClose={() => setRigInfoOpen(false)}
      />

      <TowingNoteModal
        isOpen={towingNoteOpen}
        onClose={() => setTowingNoteOpen(false)}
      />
    </div>
  )
}
