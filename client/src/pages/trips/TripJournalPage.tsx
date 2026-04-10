import { useEffect, useState, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import { Camera, Star, DollarSign, Save } from 'lucide-react'
import { tripsApi, journalApi } from '../../services/api'
import { Trip, Stop, JournalEntry } from '../../types'

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

function StopJournal({ stop }: { stop: Stop }) {
  const [entry, setEntry] = useState<Partial<JournalEntry>>(stop.journalEntry || {})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function save() {
    setSaving(true)
    await journalApi.upsert(stop.id, { title: entry.title, body: entry.body, rating: entry.rating, actualCost: entry.actualCost })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
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
        <div className="w-7 h-7 bg-[#1D9E75] rounded-full flex items-center justify-center text-white text-xs">{stop.order}</div>
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
        <button onClick={() => fileRef.current?.click()} className="btn-ghost flex items-center gap-1.5 text-sm">
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
  const { id } = useParams<{ id: string }>()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    tripsApi.get(id).then(res => { setTrip(res.data); setLoading(false) })
  }, [id])

  if (loading) return <div className="flex justify-center py-20"><div className="w-6 h-6 border-2 border-[#1D9E75] border-t-transparent rounded-full animate-spin" /></div>
  if (!trip) return null

  return (
    <div className="space-y-4 max-w-2xl">
      <Breadcrumb items={[
        { label: 'My Trips', href: '/trips' },
        { label: trip.name, href: `/trips/${id}` },
        { label: 'Journal' },
      ]} />
      <div>
        <h1 className="text-xl font-medium text-gray-900">Trip Journal</h1>
        <p className="text-sm text-gray-500">{trip.name}</p>
      </div>
      <div className="space-y-4">
        {trip.stops?.sort((a, b) => a.order - b.order).map(stop => (
          <StopJournal key={stop.id} stop={stop} />
        ))}
      </div>
    </div>
  )
}
