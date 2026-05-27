import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import {
  CheckCircle, AlertTriangle, ExternalLink,
  Phone, MapPin, Globe, ChevronDown, ChevronUp, Loader, Check,
  Calendar, BadgeInfo, Bed, Tent, X,
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

function formatDate(iso?: string): string {
  if (!iso) return '—'
  // Routes through parseTripDate so the displayed calendar day matches the
  // stored UTC date instead of shifting back a day in negative-offset TZs.
  return formatTripDate(iso, 'MMM d, yyyy') || '—'
}

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
          <button
            onClick={save}
            disabled={saving}
            className="btn-primary text-xs w-full flex items-center justify-center gap-1.5"
          >
            {saving
              ? <><Loader size={12} className="animate-spin" /> Saving…</>
              : <><Check size={12} /> Save reservation info</>
            }
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Recommended campground card (primary recommendation per stop) ───────────

function RecommendedCampgroundCard({
  cg,
  stop,
  draftMode,
  onSelectCampground,
  onStopUpdated,
  onUnbook,
  membershipLabels,
}: {
  cg: Campground
  stop: Stop
  draftMode: boolean
  onSelectCampground: () => void
  onStopUpdated: (stopId: string, data: Partial<Stop>) => void
  onUnbook: (stop: Stop) => void
  // Human-readable labels for the user's active, non-expired memberships
  // (e.g. ["Good Sam Club", "Thousand Trails"]). Computed at the page level
  // from user.memberships and MEMBERSHIP_TYPES; passed in here so this card
  // doesn't need its own auth dependency. Empty array → nudge is hidden.
  membershipLabels: string[]
  // B1 — onOpenRigInfo and isTowing dropped from the props: the per-card
  // "My rig info" trigger and the towing advisory both lifted to the new
  // page-level header strip so they're stated once, not repeated under
  // every campground card.
}) {
  const isConfirmed = stop.campgroundId === cg.id && stop.bookingStatus === 'CONFIRMED'
  const mapQuery = [cg.name, cg.address].filter(Boolean).join(' ')
  const mapUrl = cg.latitude && cg.longitude
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cg.name)}&ll=${cg.latitude},${cg.longitude}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`

  return (
    <div className={`card mb-3 transition-colors ${
      isConfirmed ? 'border-[#3E5540]/40 bg-[#DCE5D5]/20' : 'border-[#1F6F8B]/20 bg-[#E0F0F4]/10'
    }`}>
      {/* Booked banner — single-state pill driven only by bookingStatus. The gray
          "Enter confirmation to book" interim state is gone: until the user clicks Save,
          the stop is genuinely not booked and the pill stays absent. */}
      {isConfirmed && (
        <div className="flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-2 mb-3 border text-[#2F4030] bg-[#DCE5D5] border-[#3E5540]/30">
          <CheckCircle size={13} />
          <span>Booked</span>
          <button
            onClick={() => onUnbook(stop)}
            className="ml-auto underline underline-offset-2 font-medium text-[#2F4030]/70 hover:text-[#2F4030]"
          >
            Unbook
          </button>
        </div>
      )}

      {/* Name + rate */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-gray-900 leading-snug">{cg.name}</h4>
          {cg.rating != null && (
            <div className="text-xs text-amber-500 mt-0.5">
              {'★'.repeat(Math.round(cg.rating))}
              <span className="text-gray-400 ml-1">{cg.rating.toFixed(1)}</span>
            </div>
          )}
          {cg.address && (
            <div className="flex items-center gap-1 mt-1 text-xs text-gray-400">
              <MapPin size={10} className="flex-shrink-0" />{cg.address}
            </div>
          )}
        </div>
        {cg.siteRate != null && (
          <div className="text-right flex-shrink-0">
            <p className="text-sm font-semibold text-gray-900">
              ${cg.siteRate}<span className="text-xs font-normal text-gray-400">/nt</span>
            </p>
            <p className="text-[11px] text-gray-400">${cg.siteRate * stop.nights} total</p>
          </div>
        )}
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {cg.hookupTypes?.map(h => <span key={h} className="badge-green text-xs">{h}</span>)}
        {cg.isPetFriendly && <span className="badge-blue text-xs">🐾 Pets OK</span>}
        {cg.maxRigLength && <span className="badge text-xs bg-gray-100 text-gray-600">Max {cg.maxRigLength}ft</span>}
        {cg.isMilitaryOnly && <span className="badge text-xs bg-blue-50 text-blue-700">🎖️ Military</span>}
      </div>

      {/* Reservation Honesty: split into two distinct actions so users see the truth —
          (1) the gold button opens Recreation.gov in a new tab and does NOT touch local
          state; the actual booking happens on Recreation.gov, not here. (2) the subtle
          link below it opens the local form so users can record a confirmation # AFTER
          they've booked elsewhere. Both hidden when already booked or while the form is
          already open. */}
      {!isConfirmed && !draftMode && (
        <div className="space-y-2">
          {cg.reservationUrl && (
            <div>
              <button
                onClick={() => window.open(cg.reservationUrl!, '_blank', 'noopener,noreferrer')}
                className="bg-rr-gold hover:bg-rr-gold-dark text-white rounded-lg font-medium transition-colors text-sm w-full flex items-center justify-center gap-1.5 py-2.5"
              >
                <ExternalLink size={13} /> Book at {truncateName(cg.name)}
              </button>
              {/* Reservation Honesty: always-visible subtext under the gold button so first-time
                  users see the truth before they click. The fuller line lives inside the expanded
                  ReservationSection ("RoamReady doesn't make reservations for you...") and stays
                  there as the more thorough explanation when they come back to record a conf #. */}
              <p className="text-xs text-gray-500 text-center mt-1.5 leading-snug">
                Opens the campground's site — you book directly with them.
              </p>
              {/* Reservation Honesty: membership reminder. Names what the user has
                  saved but never claims the discount applies — that's the
                  campground's call, not ours. No price math touches this line. */}
              {membershipLabels.length > 0 && (
                <p className="text-xs text-gray-500 text-center mt-1 leading-snug">
                  {formatMembershipNudge(membershipLabels)}
                </p>
              )}
            </div>
          )}
          <button
            onClick={onSelectCampground}
            className="text-xs text-[#1F6F8B] hover:text-[#134756] underline underline-offset-2 transition-colors w-full text-center py-1"
          >
            Already booked? Record your confirmation #
          </button>
          {/* B1 — per-card "My rig info" and towing advisory both lifted to
              the page-level header strip so they're stated once on the page,
              not repeated under every campground card. */}
        </div>
      )}
      <ReservationSection
        key={stop.id}
        stop={stop}
        cg={cg}
        draftMode={draftMode}
        onSaved={data => onStopUpdated(stop.id, data)}
      />

      {/* Links */}
      <div className="flex items-center gap-4 mt-3 pt-2.5 border-t border-gray-100" style={{ borderTopWidth: '0.5px' }}>
        {cg.phone && (
          <a href={`tel:${cg.phone}`} className="flex items-center gap-1 text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors">
            <Phone size={11} />{cg.phone}
          </a>
        )}
        {cg.website && (
          <a href={cg.website} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors">
            <Globe size={11} /> Website
          </a>
        )}
        {cg.reservationUrl && (
          <a href={cg.reservationUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors">
            <ExternalLink size={11} /> {reservationLinkLabel(cg.reservationUrl)}
          </a>
        )}
        <a href={mapUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-gray-400 hover:text-[#1F6F8B] transition-colors ml-auto">
          <MapPin size={11} /> Map
        </a>
      </div>
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
  const totalCampCost = sortedStops.reduce((sum, s) => s.siteRate ? sum + s.siteRate * s.nights : sum, 0)

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

  // ── Per-stop content: destination header + recommended card + expandable alts ──
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

    // Drive distance from previous stop
    const driveDistance = prevStop
      ? calcDistance(prevStop.latitude, prevStop.longitude, stop.latitude, stop.longitude)
      : null

    return (
      <>
        {/* ── Destination header ── */}
        <div className="flex items-start gap-3 mb-4">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0 shadow-sm ${
            stop.type === 'HOME' ? 'bg-gray-400' :
            stop.type === 'OVERNIGHT_ONLY' ? 'bg-[#7F77DD]' : 'bg-[#1F6F8B]'
          }`}>
            {formatStopBadgeMarker(stopDisplayNumbers[stop.id])}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-gray-900 leading-tight">
              {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
            </h3>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-xs text-gray-400">
              {stop.arrivalDate && (
                <span className="flex items-center gap-1">
                  <Calendar size={10} />
                  {formatDate(stop.arrivalDate)}{stop.departureDate ? ` → ${formatDate(stop.departureDate)}` : ''}
                </span>
              )}
              {stop.type !== 'HOME' && <span>{stop.nights} night{stop.nights !== 1 ? 's' : ''}</span>}
              {driveDistance && <span>~{driveDistance} mi from previous stop</span>}
            </div>
          </div>
          {stop.type === 'HOME' ? (
            <span className="badge text-xs flex-shrink-0 bg-gray-100 text-gray-500">Departure</span>
          ) : confirmed ? (
            // Single-state header pill — green "Booked" whenever bookingStatus is CONFIRMED.
            // Reservation Honesty: there's no longer a half-state where the stop is "booked"
            // without a user-saved commit, so the pill no longer needs the gray interim copy.
            <span className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-semibold rounded-lg px-2 py-0.5 border text-[#2F4030] bg-[#DCE5D5] border-[#3E5540]/30">
              <CheckCircle size={11} />
              Booked
            </span>
          ) : (
            <span className={`badge text-xs flex-shrink-0 ${
              stop.bookingStatus === 'PENDING' || stop.bookingStatus === 'WAITLISTED' ? 'badge-amber' :
              stop.type === 'OVERNIGHT_ONLY' ? 'bg-purple-100 text-purple-700' :
              'bg-gray-100 text-gray-500'
            }`}>
              {stop.bookingStatus === 'PENDING' ? 'Pending' :
               stop.type === 'OVERNIGHT_ONLY' ? 'Overnight' : 'Not booked'}
            </span>
          )}
        </div>

        {/* ── Incompatibility promotion note ── */}
        {originalWasIncompat && recommended && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3 text-xs text-amber-700">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-amber-500" />
            Your original suggestion wasn't compatible with your rig — we found this alternative instead
          </div>
        )}

        {/* ── Recommended campground card ── */}
        {!isLoaded ? (
          <div className="rounded-xl border border-gray-100 bg-gray-50 h-[140px] animate-pulse mb-3" />
        ) : recommended ? (
          <RecommendedCampgroundCard
            cg={recommended}
            stop={stop}
            draftMode={stopDraftMode}
            onSelectCampground={() => handleSelectCampground(stop, recommended)}
            onStopUpdated={handleStopUpdated}
            onUnbook={(stop) => setUnbookTarget(stop)}
            membershipLabels={membershipLabels}
          />
        ) : cgs?.length === 0 ? (
          // Reservation Honesty: when RIDB returns nothing for this location, surface
          // the gap honestly and link the user to Google Maps so they can keep moving.
          // Same card chrome as a populated card to avoid layout shift.
          <div className="card mb-3 border-[#1F6F8B]/20 bg-[#E0F0F4]/10">
            <h4 className="text-sm font-semibold text-gray-900 leading-snug">
              No campgrounds found near {stop.locationName}
            </h4>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">
              We couldn't find verified campgrounds near this stop. Try Google
              Maps for private RV parks, BLM dispersed camping, or other options.
            </p>
            <a
              href={`https://www.google.com/maps/search/${encodeURIComponent(`campgrounds near ${stop.locationName}${stop.locationState ? ', ' + stop.locationState : ''}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-rr-gold hover:bg-rr-gold-dark text-white rounded-lg font-medium transition-colors text-sm w-full flex items-center justify-center gap-1.5 py-2.5 mt-3"
            >
              <MapPin size={13} /> Search Google Maps for campgrounds near {stop.locationName}
            </a>
          </div>
        ) : (
          <div className="card py-6 text-center text-xs text-gray-400 mb-3">
            No campgrounds compatible with your rig were found near this stop.
          </div>
        )}

        {/* ── See other campgrounds link + animated alternatives ── */}
        {/* Visible whether or not the stop is booked: a user might commit to one campground,
            then call Recreation.gov, find their dates aren't available, and need to compare
            other options without unbooking first. */}
        {isLoaded && altOptions.length > 0 && (
          <div>
            <button
              onClick={() => setExpandedAlts(prev => ({ ...prev, [stop.id]: !(prev[stop.id] ?? false) }))}
              className="text-xs text-[#1F6F8B] underline underline-offset-2 hover:text-[#134756] transition-colors"
            >
              {showAlts
                ? 'Hide other options'
                : `See other campgrounds near ${stop.locationName} (${altOptions.length} option${altOptions.length !== 1 ? 's' : ''})`
              }
            </button>

            {/* Smooth expand/collapse via CSS grid trick */}
            <div className={`grid transition-all duration-300 ease-in-out ${showAlts ? 'grid-rows-[1fr] mt-3' : 'grid-rows-[0fr]'}`}>
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
              <p className="text-[11px] text-gray-400 mt-0.5">est. camp total</p>
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
