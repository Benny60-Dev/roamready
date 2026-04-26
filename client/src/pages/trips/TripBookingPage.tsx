import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import {
  CheckCircle, AlertTriangle, ExternalLink,
  Phone, MapPin, Globe, ChevronDown, ChevronUp, Loader, Check,
  X, Users, PawPrint, Tag, Calendar,
} from 'lucide-react'
import { tripsApi, campgroundsApi, bookingsApi } from '../../services/api'
import { Trip, Stop, Campground } from '../../types'
import { useAuthStore } from '../../store/authStore'
import { buildStopBadges } from '../../utils/stopBadge'
import { useUIStore } from '../../store/uiStore'
import ConfirmModal from '../../components/ui/ConfirmModal'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcDistance(lat1?: number, lng1?: number, lat2?: number, lng2?: number): string | null {
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
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ─── Reservation & Notes collapsible section ─────────────────────────────────

interface ReservationForm {
  confirmationNum: string
  siteNumber: string
  checkInTime: string
  checkOutTime: string
  notes: string
}

function ReservationSection({
  stop,
  onSaved,
}: {
  stop: Stop
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
  })

  const hasData =
    form.confirmationNum || form.siteNumber || form.checkInTime || form.checkOutTime || form.notes

  function set(field: keyof ReservationForm, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  async function save() {
    setSaving(true)
    try {
      const payload: Partial<Stop> = {
        confirmationNum: form.confirmationNum || undefined,
        siteNumber: form.siteNumber || undefined,
        checkInTime: form.checkInTime || undefined,
        checkOutTime: form.checkOutTime || undefined,
        notes: form.notes || undefined,
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

  return (
    <div className="border-t border-gray-100 mt-3 pt-3" style={{ borderTopWidth: '0.5px' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-xs font-medium text-gray-600 hover:text-gray-800 transition-colors"
      >
        <span>Reservation &amp; Notes</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      {!open && hasData && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
          {form.confirmationNum && (
            <span>Conf # <span className="font-medium text-gray-700">{form.confirmationNum}</span></span>
          )}
          {form.siteNumber && (
            <span>Site <span className="font-medium text-gray-700">{form.siteNumber}</span></span>
          )}
          {form.checkInTime && (
            <span>Check-in <span className="text-gray-700">{form.checkInTime}</span></span>
          )}
          {form.checkOutTime && (
            <span>Check-out <span className="text-gray-700">{form.checkOutTime}</span></span>
          )}
          {form.notes && (
            <span className="text-gray-400 truncate max-w-[240px]" title={form.notes}>
              📝 {form.notes}
            </span>
          )}
        </div>
      )}

      {justSaved && !open && (
        <p className="mt-1.5 text-xs text-[#0F766E] flex items-center gap-1">
          <Check size={11} /> Saved
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Confirmation #</label>
              <input
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

// ─── Reservation confirm modal ────────────────────────────────────────────────

function ReservationConfirmModal({
  cg,
  stop,
  confirming,
  onConfirm,
  onCancel,
}: {
  cg: Campground
  stop: Stop
  confirming: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { user } = useAuthStore()
  const profile = user?.travelProfile
  const activeMemberships = user?.memberships?.filter(m => m.isActive && m.autoApply) ?? []
  const totalCost = cg.siteRate ? cg.siteRate * stop.nights : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Confirm campground</h2>
            <p className="text-xs text-gray-500 mt-0.5">Review and confirm your booking</p>
          </div>
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 transition-colors -mt-0.5 -mr-0.5"
          >
            <X size={18} />
          </button>
        </div>

        {/* Campground details */}
        <div className="p-4 space-y-3">
          {/* Campground name + tags */}
          <div>
            <h3 className="font-medium text-gray-900">{cg.name}</h3>
            {cg.address && (
              <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                <MapPin size={10} />
                {cg.address}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {cg.maxRigLength && (
                <span className="badge text-xs bg-gray-100 text-gray-600">Max {cg.maxRigLength} ft</span>
              )}
              {cg.hookupTypes?.map(h => (
                <span key={h} className="badge-green text-xs">{h}</span>
              ))}
              {cg.isPetFriendly && <span className="badge-blue text-xs">🐾 Pets OK</span>}
              {cg.rating != null && (
                <span className="badge text-xs bg-amber-50 text-amber-700">★ {cg.rating.toFixed(1)}</span>
              )}
            </div>
          </div>

          {/* Dates */}
          <div className="bg-gray-50 rounded-lg px-3 py-2.5 space-y-1.5 text-xs text-gray-600">
            <div className="flex justify-between">
              <span className="text-gray-500">Check-in</span>
              <span className="font-medium">{formatDate(stop.arrivalDate)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Check-out</span>
              <span className="font-medium">{formatDate(stop.departureDate)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Nights</span>
              <span className="font-medium">{stop.nights}</span>
            </div>
          </div>

          {/* Cost */}
          {cg.siteRate && (
            <div className="bg-[#DCE5D5]/30 border border-[#3E5540]/20 rounded-lg px-3 py-2.5 text-xs">
              <div className="flex justify-between text-gray-600">
                <span>${cg.siteRate}/night × {stop.nights} nights</span>
                <span className="font-semibold text-gray-900">${totalCost}</span>
              </div>
              {activeMemberships.length > 0 && (
                <div className="mt-1.5 flex items-center gap-1 text-[#0F766E]">
                  <Tag size={10} />
                  <span>Membership discounts may apply: {activeMemberships.map(m => m.type).join(', ')}</span>
                </div>
              )}
            </div>
          )}

          {/* Party */}
          {profile && (
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <Users size={12} />
                {profile.adults} adult{profile.adults !== 1 ? 's' : ''}
                {profile.children > 0 ? `, ${profile.children} child${profile.children !== 1 ? 'ren' : ''}` : ''}
              </span>
              {profile.hasPets && (
                <span className="flex items-center gap-1 text-[#0F766E]">
                  <PawPrint size={12} />
                  Pets
                </span>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 p-4 pt-0">
          <button
            onClick={onCancel}
            disabled={confirming}
            className="flex-1 btn-outline text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirming}
            className="flex-1 btn-primary text-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {confirming
              ? <><Loader size={13} className="animate-spin" /> Booking…</>
              : <><Check size={13} /> Confirm booking</>
            }
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Recommended campground card (primary recommendation per stop) ───────────

function RecommendedCampgroundCard({
  cg,
  stop,
  onReserve,
  onStopUpdated,
  onUnbook,
}: {
  cg: Campground
  stop: Stop
  onReserve: () => void
  onStopUpdated: (stopId: string, data: Partial<Stop>) => void
  onUnbook: (stop: Stop) => void
}) {
  const isConfirmed = stop.campgroundId === cg.id && stop.bookingStatus === 'CONFIRMED'
  const mapQuery = [cg.name, cg.address].filter(Boolean).join(' ')
  const mapUrl = cg.latitude && cg.longitude
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cg.name)}&ll=${cg.latitude},${cg.longitude}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`

  return (
    <div className={`card mb-3 transition-colors ${
      isConfirmed ? 'border-[#3E5540]/40 bg-[#DCE5D5]/20' : 'border-[#1E3A8A]/20 bg-[#EFF6FF]/10'
    }`}>
      {/* Booked banner */}
      {isConfirmed && (
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#2F4030] bg-[#DCE5D5] border border-[#3E5540]/30 rounded-lg px-3 py-2 mb-3">
          <CheckCircle size={13} />
          <span>Selected campground — booked</span>
          <button
            onClick={() => onUnbook(stop)}
            className="ml-auto text-[#2F4030]/70 hover:text-[#2F4030] underline underline-offset-2 font-medium"
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

      {/* Reserve button (full-width, green) or booked state */}
      {!isConfirmed ? (
        <button
          onClick={onReserve}
          className="btn-primary text-sm w-full flex items-center justify-center gap-1.5 py-2.5"
        >
          {cg.siteRate ? `Reserve · $${cg.siteRate}/nt` : 'Reserve this campground'}
        </button>
      ) : (
        <ReservationSection
          key={stop.id}
          stop={stop}
          onSaved={data => onStopUpdated(stop.id, data)}
        />
      )}

      {/* Links */}
      <div className="flex items-center gap-4 mt-3 pt-2.5 border-t border-gray-100" style={{ borderTopWidth: '0.5px' }}>
        {cg.phone && (
          <a href={`tel:${cg.phone}`} className="flex items-center gap-1 text-xs text-[#1E3A8A] hover:text-[#1E40AF] transition-colors">
            <Phone size={11} />{cg.phone}
          </a>
        )}
        {cg.website && (
          <a href={cg.website} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-[#1E3A8A] hover:text-[#1E40AF] transition-colors">
            <Globe size={11} /> Website
          </a>
        )}
        {cg.reservationUrl && (
          <a href={cg.reservationUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-[#1E3A8A] hover:text-[#1E40AF] transition-colors">
            <ExternalLink size={11} /> Recreation.gov
          </a>
        )}
        <a href={mapUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-gray-400 hover:text-[#1E3A8A] transition-colors ml-auto">
          <MapPin size={11} /> Map
        </a>
      </div>
    </div>
  )
}

// ─── Compact alternative card (shown in collapsed alternatives list) ──────────

function CompactAltCard({
  cg,
  stop,
  originLat,
  originLng,
  onReserve,
}: {
  cg: Campground
  stop: Stop
  originLat?: number
  originLng?: number
  onReserve: () => void
}) {
  const isConfirmed = stop.campgroundId === cg.id && stop.bookingStatus === 'CONFIRMED'
  const dist = calcDistance(originLat, originLng, cg.latitude, cg.longitude)

  return (
    <div className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 bg-white transition-colors ${
      isConfirmed ? 'border-[#3E5540]/30 bg-[#DCE5D5]/20' : 'border-gray-200'
    }`} style={{ borderWidth: '0.5px' }}>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-gray-800 truncate">{cg.name}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
          {dist && <span className="text-[11px] text-gray-400">{dist} mi</span>}
          {cg.hookupTypes?.[0] && <span className="text-[11px] text-gray-400">{cg.hookupTypes[0]}</span>}
          {cg.siteRate != null && <span className="text-[11px] font-medium text-gray-600">${cg.siteRate}/nt</span>}
          {cg.isPetFriendly && <span className="text-[11px] text-gray-400">🐾</span>}
          {cg.rating != null && <span className="text-[11px] text-amber-500">★ {cg.rating.toFixed(1)}</span>}
          {isConfirmed && (
            <span className="text-[11px] font-semibold text-[#2F4030] flex items-center gap-0.5">
              <CheckCircle size={10} /> Booked
            </span>
          )}
        </div>
      </div>
      {!isConfirmed && (
        <button
          onClick={onReserve}
          className="btn-outline text-xs flex-shrink-0 whitespace-nowrap"
        >
          Reserve
        </button>
      )}
    </div>
  )
}

// ─── Sidebar stop item status config ─────────────────────────────────────────

function statusBadge(status: string) {
  if (status === 'CONFIRMED')  return { label: 'Booked',      cls: 'bg-[#DCE5D5] text-[#2F4030]' }
  if (status === 'PENDING')    return { label: 'Pending',     cls: 'bg-amber-100 text-amber-700' }
  if (status === 'CANCELLED')  return { label: 'Cancelled',   cls: 'bg-red-100 text-red-500' }
  if (status === 'WAITLISTED') return { label: 'Pending',     cls: 'bg-amber-100 text-amber-700' }
  return { label: 'Not booked', cls: 'bg-gray-100 text-gray-500' }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TripBookingPage() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [campgrounds, setCampgrounds] = useState<Record<string, Campground[]>>({})
  const [loading, setLoading] = useState(true)
  const [activeStop, setActiveStop] = useState<string | null>(null)
  // per-stop expand/collapse alternatives
  const [expandedAlts, setExpandedAlts] = useState<Record<string, boolean>>({})
  // pendingAlt carries both the campground choice AND which stop it belongs to
  const [pendingAlt, setPendingAlt] = useState<{ cg: Campground; stop: Stop } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [unbookTarget, setUnbookTarget] = useState<Stop | null>(null)
  const [unbooking, setUnbooking] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const { hasAccess, user } = useAuthStore()
  const { openPaywall } = useUIStore()

  // Load trip — honor ?stopId param from incoming navigation
  useEffect(() => {
    if (!hasAccess('campgroundBooking')) { openPaywall('campgroundBooking'); return }
    if (!id) return
    const targetStopId = searchParams.get('stopId')
    tripsApi.get(id).then(res => {
      setTrip(res.data)
      setActiveStop(targetStopId ?? res.data.stops?.find((s: any) => s.type !== 'HOME')?.id ?? null)
      setLoading(false)
      // Scroll to the target stop after React renders the sections
      if (targetStopId) setTimeout(() => scrollToStop(targetStopId), 80)
    })
  }, [id])

  // Load campgrounds for ALL stops in parallel when trip loads
  useEffect(() => {
    if (!trip?.stops?.length) return
    trip.stops.forEach(stop => {
      if (stop.type === 'HOME') return
      campgroundsApi.search({
        q: stop.locationName,
        lat: stop.latitude,
        lng: stop.longitude,
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

  // Scroll right panel to a stop section and update active highlight
  function scrollToStop(stopId: string) {
    setActiveStop(stopId)
    requestAnimationFrame(() => {
      const section = document.getElementById(`stop-section-${stopId}`)
      const panel   = contentRef.current
      if (section && panel) {
        const offset = section.getBoundingClientRect().top - panel.getBoundingClientRect().top
        panel.scrollBy({ top: offset - 12, behavior: 'smooth' })
      }
    })
  }

  // Update sidebar highlight as user scrolls right panel
  function handleContentScroll(e: React.UIEvent<HTMLDivElement>) {
    const panel    = e.currentTarget
    const panelTop = panel.getBoundingClientRect().top
    const sections = Array.from(panel.querySelectorAll<HTMLElement>('[data-stop-section]'))
    for (const el of sections) {
      const { top, bottom } = el.getBoundingClientRect()
      if (top <= panelTop + 100 && bottom > panelTop + 20) {
        const sid = el.getAttribute('data-stop-section')
        if (sid && sid !== activeStop) setActiveStop(sid)
        break
      }
    }
  }

  async function handleBook(stopId: string, campgroundId: string, campgroundName: string, siteRate?: number) {
    await bookingsApi.create({ stopId, campgroundId, campgroundName, siteRate })
    setTrip(prev => {
      if (!prev) return prev
      const updatedStops = prev.stops?.map(s =>
        s.id === stopId
          ? { ...s, bookingStatus: 'CONFIRMED' as any, campgroundName, campgroundId, isCompatible: true, incompatibilityReasons: [], ...(siteRate !== undefined ? { siteRate } : {}) }
          : s
      )
      const estimatedCamp = updatedStops?.reduce((sum, s) => s.siteRate ? sum + s.siteRate * s.nights : sum, 0)
      return { ...prev, stops: updatedStops, ...(estimatedCamp ? { estimatedCamp } : {}) }
    })
  }

  function handleStopUpdated(stopId: string, data: Partial<Stop>) {
    setTrip(prev => prev ? { ...prev, stops: prev.stops?.map(s => s.id === stopId ? { ...s, ...data } : s) } : prev)
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
            ? { ...s, bookingStatus: 'NOT_BOOKED' as any }
            : s
        )
        const estimatedCamp = updatedStops?.reduce(
          (sum, s) => s.bookingStatus === 'CONFIRMED' && s.siteRate ? sum + s.siteRate * s.nights : sum,
          0
        )
        return { ...prev, stops: updatedStops, estimatedCamp }
      })
      setUnbookTarget(null)
    } catch (err) {
      console.error('Failed to unbook stop', err)
      alert('Could not unbook. Please try again.')
    } finally {
      setUnbooking(false)
    }
  }

  async function handleConfirmAlt() {
    if (!pendingAlt) return
    setConfirming(true)
    try {
      await handleBook(pendingAlt.stop.id, pendingAlt.cg.id, pendingAlt.cg.name, pendingAlt.cg.siteRate)
      setPendingAlt(null)
    } finally {
      setConfirming(false)
    }
  }

  if (loading) return (
    <div className="flex justify-center py-20">
      <div className="w-6 h-6 border-2 border-[#1E3A8A] border-t-transparent rounded-full animate-spin" />
    </div>
  )
  if (!trip) return null

  const sortedStops        = [...(trip.stops ?? [])].sort((a, b) => a.order - b.order)
  const stopDisplayNumbers = buildStopBadges(sortedStops, user)
  const bookableStops = sortedStops.filter(s => s.type !== 'HOME')
  const bookedCount   = sortedStops.filter(s => s.bookingStatus === 'CONFIRMED').length
  const incompatCount = sortedStops.filter(s => !s.isCompatible).length
  const totalCampCost = sortedStops.reduce((sum, s) => s.siteRate ? sum + s.siteRate * s.nights : sum, 0)

  // ── Per-stop content: destination header + recommended card + expandable alts ──
  function renderStopContent(stop: Stop, prevStop?: Stop) {
    const cgs       = campgrounds[stop.id]
    const isLoaded  = cgs !== undefined
    const compatible = (cgs ?? []).filter(cg => cg.isCompatible !== false)
    const confirmed  = stop.bookingStatus === 'CONFIRMED'
    const showAlts   = expandedAlts[stop.id] ?? false

    // If the stop is already booked, surface the booked campground as the recommendation
    const bookedCg   = confirmed && stop.campgroundId
      ? (cgs ?? []).find(cg => cg.id === stop.campgroundId) ?? null
      : null
    const recommended = bookedCg ?? compatible[0] ?? null
    const altOptions  = compatible.filter(cg => cg.id !== recommended?.id)

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
            stop.type === 'OVERNIGHT_ONLY' ? 'bg-[#7F77DD]' : 'bg-[#1E3A8A]'
          }`}>
            {String(stopDisplayNumbers[stop.id] ?? '')}
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
          <span className={`badge text-xs flex-shrink-0 ${
            stop.type === 'HOME' ? 'bg-gray-100 text-gray-500' :
            confirmed ? 'badge-green' :
            stop.bookingStatus === 'PENDING' || stop.bookingStatus === 'WAITLISTED' ? 'badge-amber' :
            stop.type === 'OVERNIGHT_ONLY' ? 'bg-purple-100 text-purple-700' :
            'bg-gray-100 text-gray-500'
          }`}>
            {stop.type === 'HOME' ? 'Departure' :
             confirmed ? 'Booked' :
             stop.bookingStatus === 'PENDING' ? 'Pending' :
             stop.type === 'OVERNIGHT_ONLY' ? 'Overnight' : 'Not booked'}
          </span>
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
            onReserve={() => setPendingAlt({ cg: recommended, stop })}
            onStopUpdated={handleStopUpdated}
            onUnbook={(stop) => setUnbookTarget(stop)}
          />
        ) : (
          <div className="card py-6 text-center text-xs text-gray-400 mb-3">
            {cgs?.length === 0
              ? 'No campgrounds found near this stop. Try Recreation.gov directly.'
              : 'No campgrounds compatible with your rig were found near this stop.'}
          </div>
        )}

        {/* ── See other campgrounds link + animated alternatives ── */}
        {isLoaded && altOptions.length > 0 && !confirmed && (
          <div>
            <button
              onClick={() => setExpandedAlts(prev => ({ ...prev, [stop.id]: !(prev[stop.id] ?? false) }))}
              className="text-xs text-[#1E3A8A] underline underline-offset-2 hover:text-[#1E40AF] transition-colors"
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
                    <CompactAltCard
                      key={cg.id}
                      cg={cg}
                      stop={stop}
                      originLat={stop.latitude}
                      originLng={stop.longitude}
                      onReserve={() => setPendingAlt({ cg, stop })}
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
    <div className="-mx-4 -my-6 h-[calc(100vh-3.5rem)] flex flex-col">

      {/* Breadcrumb strip */}
      <div className="flex-shrink-0 bg-white border-b border-gray-100 px-4 py-2 flex items-center gap-1.5">
        <Link to="/reservations" className="text-xs text-[#1E3A8A] hover:text-[#1E40AF] transition-colors">Bookings</Link>
        <span className="text-gray-300 text-xs">›</span>
        <span className="text-xs text-gray-700 font-medium truncate max-w-[200px]">{trip.name}</span>
      </div>

      {/* Reservation confirm modal */}
      {pendingAlt && (
        <ReservationConfirmModal
          cg={pendingAlt.cg}
          stop={pendingAlt.stop}
          confirming={confirming}
          onConfirm={handleConfirmAlt}
          onCancel={() => setPendingAlt(null)}
        />
      )}

      {/* ── MOBILE: horizontal tab bar (hidden on md+) ── */}
      <div className="md:hidden flex-shrink-0 bg-white border-b border-gray-100 overflow-x-auto">
        <div className="flex gap-1.5 p-3">
          {sortedStops.filter(s => s.type !== 'HOME').map(stop => (
            <button
              key={stop.id}
              onClick={() => setActiveStop(stop.id)}
              className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border transition-colors ${
                activeStop === stop.id
                  ? 'bg-[#1E3A8A] text-white border-[#1E3A8A]'
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
              style={{ borderWidth: '0.5px' }}
            >
              <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-semibold ${
                activeStop === stop.id ? 'bg-white/20' : 'bg-gray-100 text-gray-600'
              }`}>
                {String(stopDisplayNumbers[stop.id] ?? '')}
              </span>
              <span className="max-w-[90px] truncate">{stop.locationName}</span>
              {stop.bookingStatus === 'CONFIRMED' && (
                <CheckCircle size={10} className={activeStop === stop.id ? 'text-white' : 'text-[#3E5540]'} />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main flex row: sidebar + content ── */}
      <div className="flex flex-1 min-h-0">

        {/* ── DESKTOP sidebar (hidden on mobile) ── */}
        <aside className="hidden md:flex flex-col w-[260px] flex-shrink-0 border-r border-gray-100 bg-white overflow-hidden">
          {/* Sidebar header */}
          <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
            <p className="text-xs font-semibold text-gray-900 truncate">{trip.name}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">Campground Booking</p>
          </div>
          {/* Stop nav list */}
          <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {sortedStops.filter(s => s.type !== 'HOME').map(stop => {
              const badge    = statusBadge(stop.bookingStatus)
              const isActive = activeStop === stop.id
              return (
                <button
                  key={stop.id}
                  onClick={() => scrollToStop(stop.id)}
                  className={`w-full text-left flex items-start gap-2.5 px-2.5 py-2.5 rounded-lg transition-colors group ${
                    isActive
                      ? 'bg-[#1E3A8A]/10 border-l-[3px] border-[#1E3A8A] pl-[7px]'
                      : 'hover:bg-gray-50 border-l-[3px] border-transparent'
                  }`}
                >
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0 mt-0.5 ${
                    stop.type === 'HOME' ? 'bg-gray-400' :
                    stop.type === 'OVERNIGHT_ONLY' ? 'bg-[#7F77DD]' : 'bg-[#1E3A8A]'
                  }`}>
                    {String(stopDisplayNumbers[stop.id] ?? '')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium truncate ${isActive ? 'text-[#1E3A8A]' : 'text-gray-800'}`}>
                      {stop.locationName}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {stop.type === 'HOME' ? (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                          Starting point
                        </span>
                      ) : (
                        <>
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${badge.cls}`}>
                            {badge.label}
                          </span>
                          <span className="text-[10px] text-gray-400">{stop.nights}n</span>
                        </>
                      )}
                    </div>
                  </div>
                  {!stop.isCompatible && <AlertTriangle size={12} className="text-red-400 flex-shrink-0 mt-1" />}
                </button>
              )
            })}
          </nav>
        </aside>

        {/* ── Right content column ── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">

          {/* Sticky right header (desktop only) */}
          <header className="hidden md:flex flex-shrink-0 items-center justify-between px-6 py-3 bg-white border-b border-gray-100 z-10">
            <div>
              <h1 className="text-sm font-semibold text-gray-900">{trip.name}</h1>
              <p className="text-xs text-gray-400 mt-0.5">
                {bookedCount} of {bookableStops.length} stop{bookableStops.length !== 1 ? 's' : ''} booked
                {incompatCount > 0 && <span className="text-red-400 ml-2">· {incompatCount} incompatible</span>}
              </p>
            </div>
            {totalCampCost > 0 && (
              <div className="text-right">
                <p className="text-sm font-semibold text-gray-900">${totalCampCost.toLocaleString()}</p>
                <p className="text-[10px] text-gray-400">est. camp total</p>
              </div>
            )}
          </header>

          {/* Scrollable content area */}
          <div
            ref={contentRef}
            className="flex-1 overflow-y-auto min-h-0"
            onScroll={handleContentScroll}
          >
            {/* DESKTOP: all stops as sections */}
            <div className="hidden md:block">
              {sortedStops.filter(s => s.type !== 'HOME').map((stop) => {
                const stopIdx = sortedStops.findIndex(s => s.id === stop.id)
                return (
                <section
                  key={stop.id}
                  id={`stop-section-${stop.id}`}
                  data-stop-section={stop.id}
                  className="px-6 py-6 border-b border-gray-100 last:border-0"
                >
                  {renderStopContent(stop, sortedStops[stopIdx - 1])}
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
                  return <div key={stop.id}>{renderStopContent(stop, sortedStops[stopIdx - 1])}</div>
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
        message={`This will mark "${unbookTarget?.campgroundName || 'this campground'}" as not booked. Your campground details and confirmation number will be preserved — you can re-book at any time.`}
        confirmLabel="Unbook"
        cancelLabel="Keep it"
        onConfirm={handleUnbook}
        onCancel={() => !unbooking && setUnbookTarget(null)}
        isConfirming={unbooking}
      />
    </div>
  )
}
