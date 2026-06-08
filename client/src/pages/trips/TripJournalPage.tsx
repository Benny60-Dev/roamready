import { useEffect, useState, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { Camera, Star, DollarSign, Save, Plus } from 'lucide-react'
import { tripsApi, journalApi } from '../../services/api'
import { Trip, Stop, JournalEntry } from '../../types'
import { useAuthStore } from '../../store/authStore'
import { useUIStore } from '../../store/uiStore'
import { AddEntryModal, EntryCard } from '../../components/JournalTabContent'
import { buildStopBadges, formatStopBadgeMarker } from '../../utils/stopBadge'

function StarRating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hover, setHover] = useState(0)
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} type="button" onClick={() => onChange(n)} onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(0)}>
          <Star size={18} className={n <= (hover || value) ? 'text-amber-400 fill-amber-400' : 'text-gray-300'} />
        </button>
      ))}
    </div>
  )
}

function StopJournal({ stop, badge }: { stop: Stop; badge: 'S' | 'H' | 'F' | number }) {
  const hasAccess = useAuthStore(s => s.hasAccess)
  const openPaywall = useUIStore(s => s.openPaywall)
  const [entry, setEntry] = useState<Partial<JournalEntry>>(stop.journalEntry || {})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function save() {
    // Gate at Save-tap, client-side, so a non-Pro user sees the paywall
    // immediately instead of composing then hitting a server 403 (the
    // gate-too-late bug fixed app-wide). Server still enforces this via
    // requireFeature('tripJournal') on POST /journal/:stopId.
    if (!hasAccess('tripJournal')) {
      openPaywall('tripJournal')
      return
    }
    setSaving(true)
    try {
      await journalApi.upsert(stop.id, { title: entry.title, body: entry.body, rating: entry.rating, actualCost: entry.actualCost })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      // Safety net for stale client state: the global interceptor opens the
      // paywall on a 403 FEATURE_GATED; swallow that so it isn't double-narrated.
      if (!(e?.response?.status === 403 && e?.response?.data?.code === 'FEATURE_GATED')) {
        console.error('[StopJournal] save failed:', e)
      }
    } finally {
      setSaving(false)
    }
  }

  function handleAddPhotosClick() {
    // Same tap-time gate as Save — don't let a non-Pro user pick files only to
    // have the upload 403.
    if (!hasAccess('tripJournal')) {
      openPaywall('tripJournal')
      return
    }
    fileRef.current?.click()
  }

  async function uploadPhotos(files: FileList) {
    const fd = new FormData()
    Array.from(files).forEach(f => fd.append('photos', f))
    const res = await journalApi.uploadPhotos(stop.id, fd)
    setEntry(e => ({ ...e, photos: res.data.photos }))
  }

  return (
    <div className="card-lg space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs bg-[#1F6F8B]">
          {formatStopBadgeMarker(badge)}
        </div>
        <div>
          <h3 className="font-medium text-gray-900">{stop.locationName}</h3>
          {stop.campgroundName && <p className="text-xs text-gray-500">{stop.campgroundName}</p>}
        </div>
      </div>

      <div>
        <label className="label">Title</label>
        <input className="input" placeholder="How was this stop?" value={entry.title || ''} onChange={e => setEntry(v => ({ ...v, title: e.target.value }))} />
      </div>

      <div>
        <label className="label">Notes</label>
        <textarea className="input min-h-[100px] resize-none" placeholder="Write about your experience..." value={entry.body || ''} onChange={e => setEntry(v => ({ ...v, body: e.target.value }))} />
      </div>

      <div className="flex items-center gap-6">
        <div>
          <label className="label">Rating</label>
          <StarRating value={entry.rating || 0} onChange={r => setEntry(v => ({ ...v, rating: r }))} />
        </div>
        <div className="flex-1">
          <label className="label">Actual cost</label>
          <div className="relative">
            <DollarSign size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input type="number" className="input pl-7" placeholder="0.00" value={entry.actualCost || ''} onChange={e => setEntry(v => ({ ...v, actualCost: parseFloat(e.target.value) }))} />
          </div>
        </div>
      </div>

      {/* Photos */}
      {entry.photos && entry.photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {entry.photos.map((url, i) => (
            <img key={i} src={url} alt={`Photo ${i + 1}`} className="w-20 h-20 object-cover rounded-lg border border-gray-200" style={{ borderWidth: '0.5px' }} />
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={handleAddPhotosClick} className="btn-ghost flex items-center gap-1.5 text-sm">
          <Camera size={14} /> Add photos
        </button>
        <input ref={fileRef} type="file" multiple accept="image/*" className="hidden" onChange={e => e.target.files && uploadPhotos(e.target.files)} />
        <button onClick={save} disabled={saving} className="btn-primary flex items-center gap-1.5 text-sm ml-auto">
          <Save size={14} /> {saving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export default function TripJournalPage() {
  const { user } = useAuthStore()
  const hasAccess = useAuthStore(s => s.hasAccess)
  const openPaywall = useUIStore(s => s.openPaywall)
  const { id } = useParams<{ id: string }>()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [loading, setLoading] = useState(true)

  // Trip-level freeform entries (tripId set, stopId null) — written via the new
  // diary endpoint. Per-stop entries (stopId != null) are rendered by the
  // StopJournal cards below from trip.stops, so we filter them out here to
  // avoid double-rendering.
  const [freeform, setFreeform] = useState<JournalEntry[]>([])
  const [ffLoading, setFfLoading] = useState(true)
  const [ffError, setFfError] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)

  useEffect(() => {
    if (!id) return
    tripsApi.get(id).then(res => { setTrip(res.data); setLoading(false) })
  }, [id])

  function loadFreeform() {
    if (!id) return
    setFfLoading(true)
    setFfError(false)
    journalApi
      .list({ tripId: id })
      .then(res => {
        setFreeform((res.data as JournalEntry[]).filter(e => !e.stopId))
        setFfLoading(false)
      })
      .catch(() => {
        setFfError(true)
        setFfLoading(false)
      })
  }
  useEffect(() => { loadFreeform() }, [id])

  // Gate the freeform write entry-point at TAP, not submit (matches the
  // Dashboard composer + per-stop Save). Reading stays open to all.
  function handleAddFreeform() {
    if (!hasAccess('tripJournal')) {
      openPaywall('tripJournal')
      return
    }
    setComposerOpen(true)
  }

  if (loading) return <div className="flex justify-center py-20"><div className="w-6 h-6 border-2 border-[#1F6F8B] border-t-transparent rounded-full animate-spin" /></div>
  if (!trip) return null

  return (
    <div className="space-y-6 max-w-2xl">
      <Breadcrumb items={[
        { label: 'Dashboard', href: '/dashboard' },
        { label: trip.name, href: `/trips/${id}/map` },
        { label: 'Journal' },
      ]} />
      <div>
        <h1 className="text-xl font-medium text-gray-900">Trip Journal</h1>
        <p className="text-sm text-gray-500">{trip.name}</p>
      </div>

      {/* Top freeform CTA — surfaced above the stop cards so freeform
          journaling is discoverable without scrolling past every stop. Opens
          the SAME composer as the list below (shared handleAddFreeform handler,
          same tap-time gating). The freeform entries themselves still render in
          their section at the bottom. */}
      <div className="card flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">Freeform journal entry</p>
          <p className="text-xs text-gray-500">Capture the drive or the day — not tied to a stop.</p>
        </div>
        <button
          onClick={handleAddFreeform}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors bg-[#F7A829] hover:bg-[#C9851A] flex-shrink-0"
        >
          <Plus size={16} /> Add a freeform journal entry
        </button>
      </div>

      {/* Per-stop entries (legacy upsert path — keeps actualCost + photos). */}
      <div className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Stop entries
        </h2>
        <div className="space-y-4">
          {(() => {
            const sorted = [...(trip.stops || [])].sort((a, b) => a.order - b.order)
            const badges = buildStopBadges(sorted, user)
            // Journal entries are for travel experiences, not home time.
            // Home stops are intentionally excluded here even though other pages
            // (Map, Bookings, Summary, Shared) show them as "Start" / "Finish".
            // If we ever want home journal entries (e.g. "made it back!"), this
            // is the only place to flip.
            return sorted
              .filter(s => s.type !== 'HOME')
              .map(stop => (
                <StopJournal key={stop.id} stop={stop} badge={badges[stop.id]} />
              ))
          })()}
        </div>
      </div>

      {/* Freeform entries (new diary endpoint — tripId set, no stopId). The
          "+ Add" button lives in the top CTA above; this section is the list. */}
      <div className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Freeform entries
        </h2>

        {ffLoading ? (
          <div className="space-y-2">
            {[1, 2].map(i => <div key={i} className="card h-20 animate-pulse bg-gray-50" />)}
          </div>
        ) : ffError ? (
          <div className="card text-center py-8">
            <p className="text-sm text-gray-500 mb-3">Couldn't load freeform entries.</p>
            <button onClick={loadFreeform} className="text-sm font-medium text-[#1F6F8B] hover:underline">
              Try again
            </button>
          </div>
        ) : freeform.length === 0 ? (
          <div className="card text-center py-8">
            <p className="text-sm text-gray-500">
              No freeform entries yet — capture a memory that isn't tied to a specific stop.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {freeform.map(e => <EntryCard key={e.id} entry={e} />)}
          </div>
        )}
      </div>

      {composerOpen && id && (
        <AddEntryModal
          link={{ tripId: id, stopId: null }}
          onClose={() => setComposerOpen(false)}
          onCreated={() => {
            setComposerOpen(false)
            loadFreeform()
          }}
        />
      )}
    </div>
  )
}
