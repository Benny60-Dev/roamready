import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { Star, DollarSign, Save, Plus, Trash2, Navigation, ImagePlus } from 'lucide-react'
import { tripsApi, journalApi } from '../../services/api'
import { Trip, Stop, JournalEntry, ItineraryDay, POI } from '../../types'
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
  const [deleting, setDeleting] = useState(false)
  // The entry's row id, if one exists. Seeded from the server-provided
  // stop.journalEntry and updated when an upsert creates a fresh row, so the
  // Delete button reflects the live state (and never targets a stale id).
  const [entryId, setEntryId] = useState<string | undefined>(stop.journalEntry?.id)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Photos go straight to the server (which stores them in S3) — no Save tap
  // needed. The server responds with the full entry, so we adopt its photos
  // array (and row id — a photo can be the first thing saved for a stop).
  async function uploadPhotos(files: FileList | null) {
    if (!files || files.length === 0) return
    if (!hasAccess('tripJournal')) {
      openPaywall('tripJournal')
      return
    }
    const form = new FormData()
    Array.from(files).slice(0, 10).forEach(f => form.append('photos', f))
    setUploading(true)
    setUploadError(null)
    try {
      const res = await journalApi.uploadPhotos(stop.id, form)
      if (res.data?.id) setEntryId(res.data.id)
      if (Array.isArray(res.data?.photos)) setEntry(v => ({ ...v, photos: res.data.photos }))
    } catch (e: any) {
      if (!(e?.response?.status === 403 && e?.response?.data?.code === 'FEATURE_GATED')) {
        console.error('[StopJournal] photo upload failed:', e)
        setUploadError(
          e?.response?.status === 503
            ? 'Photo uploads are temporarily unavailable.'
            : e?.response?.data?.error || 'Could not upload photos. Please try again.'
        )
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

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
      const res = await journalApi.upsert(stop.id, { title: entry.title, body: entry.body, rating: entry.rating, actualCost: entry.actualCost })
      // Capture the row id so a just-created entry becomes immediately deletable.
      if (res.data?.id) setEntryId(res.data.id)
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

  // Delete the JournalEntry row ONLY — the Stop is never touched (the FK lives
  // on the entry as onDelete:SetNull). After delete, reset the local form to an
  // empty composer so the card reverts to "no entry yet".
  async function deleteEntry() {
    if (!entryId) return
    if (!window.confirm("Delete this journal entry? This can't be undone.")) return
    setDeleting(true)
    try {
      await journalApi.delete(entryId)
      setEntry({})
      setEntryId(undefined)
    } catch (e: any) {
      if (!(e?.response?.status === 403 && e?.response?.data?.code === 'FEATURE_GATED')) {
        console.error('[StopJournal] delete failed:', e)
      }
    } finally {
      setDeleting(false)
    }
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

      {/* Photos — stored in S3 via POST /journal/:stopId/photos (Pro-gated,
          images only, 10MB each, up to 10 per upload). Uploads save
          immediately and are independent of the Save button. */}
      <div>
        <label className="label">Photos</label>
        <div className="flex flex-wrap gap-2 items-center">
          {(entry.photos || []).map((url, i) => (
            <a key={i} href={url} target="_blank" rel="noopener noreferrer" title="Open full size">
              <img src={url} alt={`Photo ${i + 1}`} className="w-20 h-20 object-cover rounded-lg border border-gray-200" style={{ borderWidth: '0.5px' }} />
            </a>
          ))}
          <button
            type="button"
            onClick={() => (hasAccess('tripJournal') ? fileInputRef.current?.click() : openPaywall('tripJournal'))}
            disabled={uploading}
            className="w-20 h-20 rounded-lg border border-dashed border-gray-300 text-gray-500 hover:border-[#1F6F8B] hover:text-[#1F6F8B] flex flex-col items-center justify-center gap-1 text-xs disabled:opacity-60"
            aria-label="Add photos"
          >
            <ImagePlus size={18} />
            {uploading ? 'Uploading…' : 'Add photos'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={e => uploadPhotos(e.target.files)}
          />
        </div>
        {uploadError && <p className="text-xs text-red-600 mt-1">{uploadError}</p>}
      </div>

      <div className="flex gap-2">
        {/* Delete only appears once a saved entry exists for this stop. It
            removes the JournalEntry row, never the stop. */}
        {entryId && (
          <button onClick={deleteEntry} disabled={deleting} className="btn-ghost flex items-center gap-1.5 text-sm text-red-600 hover:bg-red-50">
            <Trash2 size={14} /> {deleting ? 'Deleting...' : 'Delete entry'}
          </button>
        )}
        <button onClick={save} disabled={saving} className="btn-primary flex items-center gap-1.5 text-sm ml-auto">
          <Save size={14} /> {saving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// One journal card for an ADDED route POI (an itinerary "stop along the way").
// Route POIs aren't Stop rows — they're id-less JSON in Trip.itinerary that we
// gave a stable id — so the entry is keyed by routePoiId, never stopId. Minimal
// by design: name + duration badge + a note. Edit/delete of the note happen
// in-place here; the same entry can also be edited/deleted from the Freeform
// section if it later orphans. Uses the itinerary "Stops along the way" green
// palette for visual continuity with where the POI was added.
function RoutePoiJournal({
  tripId,
  poi,
  existing,
  onChanged,
}: {
  tripId: string
  poi: POI & { id: string }
  existing?: JournalEntry
  onChanged: () => void
}) {
  const hasAccess = useAuthStore(s => s.hasAccess)
  const openPaywall = useUIStore(s => s.openPaywall)
  const [body, setBody] = useState(existing?.body || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [entryId, setEntryId] = useState<string | undefined>(existing?.id)

  async function save() {
    if (!hasAccess('tripJournal')) {
      openPaywall('tripJournal')
      return
    }
    if (!body.trim()) return
    setSaving(true)
    try {
      const res = await journalApi.upsertRoutePoi(poi.id, { tripId, placeName: poi.name, body })
      if (res.data?.id) setEntryId(res.data.id)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      onChanged()
    } catch (e: any) {
      if (!(e?.response?.status === 403 && e?.response?.data?.code === 'FEATURE_GATED')) {
        console.error('[RoutePoiJournal] save failed:', e)
      }
    } finally {
      setSaving(false)
    }
  }

  // Delete the JournalEntry row only — there's no Stop or POI row to touch; the
  // POI itself stays in the itinerary. Reset the note so the card reverts to an
  // empty composer.
  async function del() {
    if (!entryId) return
    if (!window.confirm("Delete this journal entry? This can't be undone.")) return
    setDeleting(true)
    try {
      await journalApi.delete(entryId)
      setBody('')
      setEntryId(undefined)
      onChanged()
    } catch (e: any) {
      if (!(e?.response?.status === 403 && e?.response?.data?.code === 'FEATURE_GATED')) {
        console.error('[RoutePoiJournal] delete failed:', e)
      }
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="rounded-lg border px-3 py-2.5 space-y-2" style={{ backgroundColor: '#EDF3E6', borderColor: '#9FBF8A' }}>
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium" style={{ color: '#2F4030' }}>{poi.name}</p>
        <span className="text-[10px]" style={{ color: '#5F6B57' }}>({poi.durationMinutes} min stop)</span>
      </div>
      <textarea
        className="input min-h-[56px] resize-none text-sm"
        placeholder="Add a note about this stop along the way..."
        value={body}
        onChange={e => setBody(e.target.value)}
      />
      <div className="flex gap-2">
        {entryId && (
          <button onClick={del} disabled={deleting} className="btn-ghost flex items-center gap-1.5 text-xs text-red-600 hover:bg-red-50">
            <Trash2 size={13} /> {deleting ? 'Deleting...' : 'Delete'}
          </button>
        )}
        <button onClick={save} disabled={saving || !body.trim()} className="btn-primary flex items-center gap-1.5 text-xs ml-auto disabled:opacity-50">
          <Save size={13} /> {saving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
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
  // Edit mode reuses the same composer; non-null = editing that freeform entry.
  const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null)

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

  // Edit a freeform entry — same tap-time Pro gate, opens the shared modal in
  // edit mode (PUT /journal/:id under the hood).
  function handleEditFreeform(e: JournalEntry) {
    if (!hasAccess('tripJournal')) {
      openPaywall('tripJournal')
      return
    }
    setEditingEntry(e)
  }

  // Delete a freeform entry — confirm, DELETE /journal/:id (entry row only),
  // then reload the freeform list.
  async function handleDeleteFreeform(entryId: string) {
    if (!hasAccess('tripJournal')) {
      openPaywall('tripJournal')
      return
    }
    if (!window.confirm("Delete this journal entry? This can't be undone.")) return
    try {
      await journalApi.delete(entryId)
      loadFreeform()
    } catch (e: any) {
      if (e?.response?.status === 403 && e?.response?.data?.code === 'FEATURE_GATED') return
      console.error('[TripJournalPage] freeform delete failed:', e)
    }
  }

  if (loading) return <div className="flex justify-center py-20"><div className="w-6 h-6 border-2 border-[#1F6F8B] border-t-transparent rounded-full animate-spin" /></div>
  if (!trip) return null

  // ── Route POIs (JOURNAL-ROUTESTOP) ──────────────────────────────────────────
  // ADDED "stops along the way" live as id-bearing JSON on the itinerary's DRIVE
  // days, keyed by the arriving stop's order (the DRIVE entry's stop). Group them
  // by that order so each overnight stop card can show its leg's POIs beneath it.
  // POIs without an id (added before this shipped) are skipped — not journalable
  // until re-added. The AI "Suggested along this route" list is NOT here; only
  // POIs the user actually added land in pointsOfInterest.
  const itinerary: ItineraryDay[] = trip.itinerary ?? []
  const routePoisByStopOrder = new Map<number, (POI & { id: string })[]>()
  for (const day of itinerary) {
    if (day.type !== 'DRIVE') continue
    const pois = (day.pointsOfInterest ?? []).filter(
      (p): p is POI & { id: string } => typeof p.id === 'string' && p.id.length > 0,
    )
    if (pois.length) routePoisByStopOrder.set(day.stopOrder, pois)
  }
  const currentPoiIds = new Set<string>()
  routePoisByStopOrder.forEach(list => list.forEach(p => currentPoiIds.add(p.id)))

  // freeform holds every non-stop entry, which INCLUDES route-POI entries (they
  // have stopId null). Index them by routePoiId so each nested card seeds its
  // note from the matching entry...
  const routeEntriesByPoiId = new Map<string, JournalEntry>()
  for (const e of freeform) if (e.routePoiId) routeEntriesByPoiId.set(e.routePoiId, e)

  // ...and HIDE matched route entries from the Freeform list (they render nested
  // instead). A route entry whose POI no longer exists (removed / itinerary
  // regenerated) is NOT matched, so it falls through to Freeform and demotes via
  // the existing "from a removed stop" placeName label — no crash, no orphan card.
  const freeformVisible = freeform.filter(e => !e.routePoiId || !currentPoiIds.has(e.routePoiId))

  return (
    <div className="space-y-6 max-w-2xl">
      <Breadcrumb items={[
        { label: 'Dashboard', href: '/dashboard' },
        { label: trip.name, href: `/trips/${id}/map` },
        { label: 'Trip Journal' },
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
              .map(stop => {
                // ADDED route POIs on the leg ARRIVING at this stop (keyed by
                // stop.order). Render them as a nested "Stops along the way"
                // block beneath the stop's own journal card.
                const routePois = routePoisByStopOrder.get(stop.order) ?? []
                return (
                  <div key={stop.id} className="space-y-2">
                    <StopJournal stop={stop} badge={badges[stop.id]} />
                    {routePois.length > 0 && id && (
                      <div className="ml-4 pl-3 border-l-2 space-y-2" style={{ borderColor: '#9FBF8A' }}>
                        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: '#5F6B57' }}>
                          <Navigation size={11} /> Stops along the way
                        </h3>
                        {routePois.map(poi => (
                          <RoutePoiJournal
                            key={poi.id}
                            tripId={id}
                            poi={poi}
                            existing={routeEntriesByPoiId.get(poi.id)}
                            onChanged={loadFreeform}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
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
        ) : freeformVisible.length === 0 ? (
          <div className="card text-center py-8">
            <p className="text-sm text-gray-500">
              No freeform entries yet — capture a memory that isn't tied to a specific stop.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* showRemovedStopOrigin: an entry here with a placeName is an
                orphaned per-stop OR route-POI entry (its stop was deleted, or
                its route POI was removed/regenerated, so it fell out of the
                nested sections above) — label it instead of rendering an
                anonymous freeform card. */}
            {freeformVisible.map(e => (
              <EntryCard
                key={e.id}
                entry={e}
                showRemovedStopOrigin
                onEdit={handleEditFreeform}
                onDelete={handleDeleteFreeform}
              />
            ))}
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

      {editingEntry && (
        <AddEntryModal
          entry={editingEntry}
          onClose={() => setEditingEntry(null)}
          onCreated={() => {
            setEditingEntry(null)
            loadFreeform()
          }}
        />
      )}
    </div>
  )
}
