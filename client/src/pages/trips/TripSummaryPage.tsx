import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import {
  Download, Share2, Sparkles, Car, Tent, Star, Moon,
  MapPin, XCircle, Plus, Check, RefreshCw, ArrowRight,
} from 'lucide-react'
import { pdf } from '@react-pdf/renderer'
import { tripsApi } from '../../services/api'
import { Trip, Stop, ItineraryDay, ItineraryActivity } from '../../types'
import { format, addDays } from 'date-fns'
import { TripPDF } from '../../components/pdf/TripPDF'

// ─── Format helpers ───────────────────────────────────────────────────────────

/** "Mon Apr 14" */
function fmtDate(d?: Date): string {
  return d ? format(d, 'EEE MMM d') : '—'
}

/** "08:00" → "8:00am", "15:30" → "3:30pm" */
function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const period = h >= 12 ? 'pm' : 'am'
  const dH = h > 12 ? h - 12 : h === 0 ? 12 : h
  return `${dH}:${m.toString().padStart(2, '0')}${period}`
}

// ─── Arrival calculation ──────────────────────────────────────────────────────

interface ArrivalInfo {
  timeStr: string   // "10:30am"
  timeHHMM: string  // "10:30" — for cascade
  nextDay: boolean
  level: 'ok' | 'amber' | 'red'
}

function calcArrival(departureHHMM: string, driveHours: number): ArrivalInfo {
  const [h, m] = departureHHMM.split(':').map(Number)
  const totalMin = h * 60 + m + Math.round(driveHours * 60)
  const nextDay = totalMin >= 24 * 60
  const arrH24 = Math.floor(totalMin / 60) % 24
  const arrM = totalMin % 60
  const period = arrH24 >= 12 ? 'pm' : 'am'
  const dH = arrH24 > 12 ? arrH24 - 12 : arrH24 === 0 ? 12 : arrH24
  return {
    timeStr: `${dH}:${arrM.toString().padStart(2, '0')}${period}`,
    timeHHMM: `${arrH24.toString().padStart(2, '0')}:${arrM.toString().padStart(2, '0')}`,
    nextDay,
    level: arrH24 >= 21 ? 'red' : arrH24 >= 17 ? 'amber' : 'ok',
  }
}

// ─── Haversine distance ───────────────────────────────────────────────────────

function calcDistanceMiles(
  lat1?: number, lng1?: number, lat2?: number, lng2?: number
): number {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 0
  const R = 3958.8
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(a)))
}


function normalizeActivities(acts?: string[] | ItineraryActivity[] | null): ItineraryActivity[] {
  if (!acts?.length) return []
  return (acts as any[]).map(a => typeof a === 'string' ? { name: a, checked: false } : a)
}

// ─── Timeline entry ───────────────────────────────────────────────────────────

interface TimelineEntry {
  dayNum: number
  date?: Date
  type: 'DRIVE' | 'STAY' | 'ACTIVITY' | 'OVERNIGHT'
  stop?: Stop
  prevStop?: Stop
  miles?: number
  driveHours?: number
  nightNum?: number
  departureTime: string  // HH:MM — DRIVE / OVERNIGHT next-morning depart
  checkInTime: string    // HH:MM — STAY default 15:00, OVERNIGHT default 18:00
  checkOutTime: string   // HH:MM — STAY default 11:00
  highwayRoute?: string | null
  routeDescription?: string | null
  terrainSummary?: string | null
  pointsOfInterest?: string[] | null
  activities: ItineraryActivity[]
  transitNote?: string | null
}

// ─── Build timeline ───────────────────────────────────────────────────────────
// Rules:
//  • DRIVE and immediate STAY share the same calendar date (arrive same day)
//  • currentDate advances by `nights` AFTER processing a DESTINATION stop
//  • OVERNIGHT advances by 1

function buildTimeline(stops: Stop[], startDate?: string): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let dayNum = 1
  let currentDate = startDate ? new Date(startDate) : undefined

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i]
    const prevStop = i > 0 ? stops[i - 1] : undefined

    // ── Drive segment (every stop except the first) ──────────────────────────
    if (prevStop) {
      const miles = calcDistanceMiles(
        prevStop.latitude, prevStop.longitude, stop.latitude, stop.longitude
      )
      entries.push({
        dayNum,
        date: currentDate ? new Date(currentDate) : undefined,
        type: 'DRIVE',
        stop, prevStop,
        miles: miles || undefined,
        driveHours: miles > 0 ? Math.round((miles / 55) * 10) / 10 : undefined,
        departureTime: '08:00',
        checkInTime: '15:00',
        checkOutTime: '11:00',
        activities: [],
      })
      dayNum++
      // ↑ DON'T advance date — arrival is the same calendar day as the drive
    }

    // ── Overnight transit stop ────────────────────────────────────────────────
    if (stop.type === 'OVERNIGHT_ONLY') {
      entries.push({
        dayNum,
        date: stop.arrivalDate
          ? new Date(stop.arrivalDate)
          : currentDate ? new Date(currentDate) : undefined,
        type: 'OVERNIGHT',
        stop,
        departureTime: '06:00',   // early next-morning departure (editable)
        checkInTime: '18:00',     // evening arrival (editable)
        checkOutTime: '06:00',
        activities: [],
      })
      dayNum++
      if (currentDate) currentDate = addDays(currentDate, 1)

    // ── Destination / home ────────────────────────────────────────────────────
    } else {
      const nights = stop.nights ?? 0
      for (let n = 0; n < nights; n++) {
        let entryDate: Date | undefined
        if (stop.arrivalDate) {
          entryDate = addDays(new Date(stop.arrivalDate), n)
        } else if (currentDate) {
          entryDate = n === 0 ? new Date(currentDate) : addDays(new Date(currentDate), n)
        }
        entries.push({
          dayNum,
          date: entryDate,
          type: n === 0 ? 'STAY' : 'ACTIVITY',
          stop,
          nightNum: n + 1,
          departureTime: '08:00',
          checkInTime: '15:00',
          checkOutTime: '11:00',
          activities: [],
        })
        dayNum++
      }
      if (currentDate && nights > 0) currentDate = addDays(currentDate, nights)
    }
  }

  return entries
}

// ─── Merge AI content into entries ────────────────────────────────────────────

function mergeAI(entries: TimelineEntry[], aiDays: ItineraryDay[]): TimelineEntry[] {
  if (!aiDays?.length) return entries
  return entries.map((entry, idx) => {
    const ai = aiDays[idx]
    if (!ai) return entry
    return {
      ...entry,
      departureTime: ai.departureTime ?? entry.departureTime,
      checkInTime: ai.checkInTime ?? entry.checkInTime,
      checkOutTime: ai.checkOutTime ?? entry.checkOutTime,
      highwayRoute: ai.highwayRoute ?? entry.highwayRoute,
      routeDescription: ai.routeDescription ?? entry.routeDescription,
      terrainSummary: ai.terrainSummary ?? entry.terrainSummary,
      pointsOfInterest: ai.pointsOfInterest ?? entry.pointsOfInterest,
      activities: normalizeActivities(ai.activities) || entry.activities,
      transitNote: ai.transitNote ?? entry.transitNote,
    }
  })
}

// ─── Cascade time changes forward ─────────────────────────────────────────────

type CascadeField = 'driveDepart' | 'stayCheckOut' | 'overnightDepart'

function cascadeChange(entries: TimelineEntry[], idx: number, field: CascadeField): TimelineEntry[] {
  const next = entries.map(e => ({ ...e }))
  const entry = next[idx]

  // DRIVE departure → update the immediately-following STAY/OVERNIGHT checkIn
  if (field === 'driveDepart' && entry.type === 'DRIVE' && entry.driveHours) {
    const arr = calcArrival(entry.departureTime, entry.driveHours)
    if (idx + 1 < next.length && (next[idx + 1].type === 'STAY' || next[idx + 1].type === 'OVERNIGHT')) {
      next[idx + 1].checkInTime = arr.timeHHMM
    }
  }

  // STAY check-out → update the next DRIVE departure (skipping ACTIVITY rows for same stop)
  if (field === 'stayCheckOut' && entry.type === 'STAY') {
    for (let j = idx + 1; j < next.length; j++) {
      if (next[j].type === 'DRIVE') {
        next[j].departureTime = entry.checkOutTime
        // Cascade the drive departure change too
        if (next[j].driveHours) {
          const arr = calcArrival(next[j].departureTime, next[j].driveHours!)
          if (j + 1 < next.length && (next[j + 1].type === 'STAY' || next[j + 1].type === 'OVERNIGHT')) {
            next[j + 1].checkInTime = arr.timeHHMM
          }
        }
        break
      }
    }
  }

  // OVERNIGHT departure → update the immediately-following DRIVE departure
  if (field === 'overnightDepart' && entry.type === 'OVERNIGHT') {
    if (idx + 1 < next.length && next[idx + 1].type === 'DRIVE') {
      next[idx + 1].departureTime = entry.departureTime
      if (next[idx + 1].driveHours) {
        const arr = calcArrival(next[idx + 1].departureTime, next[idx + 1].driveHours!)
        if (idx + 2 < next.length && (next[idx + 2].type === 'STAY' || next[idx + 2].type === 'OVERNIGHT')) {
          next[idx + 2].checkInTime = arr.timeHHMM
        }
      }
    }
  }

  return next
}

// ─── Row config ───────────────────────────────────────────────────────────────

const ROW_CONFIG = {
  DRIVE:     { bg: 'bg-blue-50',   border: 'border-blue-200',   text: 'text-blue-700',   icon: Car,  label: 'Drive Day' },
  STAY:      { bg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-700',  icon: Tent, label: 'Arrival & Check-in' },
  ACTIVITY:  { bg: 'bg-amber-50',  border: 'border-amber-200',  text: 'text-amber-700',  icon: Star, label: 'Explore Day' },
  OVERNIGHT: { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-700', icon: Moon, label: 'Overnight Stop' },
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TripSummaryPage() {
  const { id } = useParams<{ id: string }>()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [generatingActivities, setGeneratingActivities] = useState(false)
  const [entries, setEntries] = useState<TimelineEntry[]>([])
  const [addingActivity, setAddingActivity] = useState<Record<number, string>>({})
  const itinerarySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const activityGenAttempted = useRef(false)

  useEffect(() => {
    if (!id) return
    tripsApi.get(id).then(res => {
      const t: Trip = res.data
      setTrip(t)
      const sorted = [...(t.stops || [])].sort((a, b) => a.order - b.order)
      const raw = buildTimeline(sorted, t.startDate ?? undefined)
      setEntries(t.itinerary ? mergeAI(raw, t.itinerary) : raw)
      setLoading(false)
    })
  }, [id])

  // Auto-generate activities when page loads (once, if any ACTIVITY rows have no activities)
  useEffect(() => {
    if (loading || !id || activityGenAttempted.current) return
    const needsActivities = entries.some(e => e.type === 'ACTIVITY' && e.activities.length === 0)
    if (!needsActivities) return
    activityGenAttempted.current = true
    setGeneratingActivities(true)
    tripsApi.generateActivities(id)
      .then(res => {
        const results = res.data as { stopId: string; activities: string[] }[]
        setEntries(prev => {
          const updated = prev.map(e => {
            if (e.type !== 'ACTIVITY' || !e.stop || e.activities.length > 0) return e
            const match = results.find(r => r.stopId === e.stop!.id)
            if (!match) return e
            return { ...e, activities: match.activities.map(name => ({ name, checked: false })) }
          })
          if (id) {
            const payload: ItineraryDay[] = updated.map((e, i) => ({
              dayNum: i + 1, type: e.type, stopOrder: e.stop?.order ?? 0,
              departureTime: e.departureTime, checkInTime: e.checkInTime,
              checkOutTime: e.checkOutTime, highwayRoute: e.highwayRoute,
              routeDescription: e.routeDescription, terrainSummary: e.terrainSummary,
              pointsOfInterest: e.pointsOfInterest,
              activities: e.activities?.length ? e.activities : null,
              transitNote: e.transitNote,
            }))
            tripsApi.saveItinerary(id, payload).catch(() => {})
          }
          return updated
        })
      })
      .catch(() => {})
      .finally(() => setGeneratingActivities(false))
  }, [loading, id, entries.length])

  const handleGenerate = async () => {
    if (!id) return
    setGenerating(true)
    try {
      const res = await tripsApi.generateItinerary(id)
      setEntries(prev => mergeAI(prev, res.data as ItineraryDay[]))
    } finally {
      setGenerating(false)
    }
  }

  const hasAI = entries.some(e =>
    e.routeDescription || e.terrainSummary || (e.activities?.length && e.type === 'ACTIVITY') || e.transitNote
  )

  const handleDownloadPDF = async () => {
    if (!trip) return
    setDownloadingPdf(true)
    try {
      const tripWithEntries = {
        ...trip,
        stops: [...(trip.stops || [])].sort((a, b) => a.order - b.order),
        itinerary: entries.map((e, i) => ({
          dayNum: i + 1,
          type: e.type,
          stopOrder: e.stop?.order ?? 0,
          departureTime: e.departureTime,
          checkInTime: e.checkInTime,
          checkOutTime: e.checkOutTime,
          highwayRoute: e.highwayRoute,
          routeDescription: e.routeDescription,
          terrainSummary: e.terrainSummary,
          pointsOfInterest: e.pointsOfInterest,
          activities: e.activities?.length ? e.activities : null,
          transitNote: e.transitNote,
        })),
      }
      const blob = await pdf(<TripPDF trip={tripWithEntries} />).toBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `RoamReady-${trip.name.replace(/[^a-zA-Z0-9]+/g, '-')}-Itinerary.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } finally {
      setDownloadingPdf(false)
    }
  }

  // Save all times + AI content to itinerary JSON (debounced)
  const persistItinerary = useCallback((updated: TimelineEntry[]) => {
    if (!id) return
    if (itinerarySaveTimer.current) clearTimeout(itinerarySaveTimer.current)
    itinerarySaveTimer.current = setTimeout(() => {
      const payload: ItineraryDay[] = updated.map((e, i) => ({
        dayNum: i + 1,
        type: e.type,
        stopOrder: e.stop?.order ?? 0,
        departureTime: e.departureTime,
        checkInTime: e.checkInTime,
        checkOutTime: e.checkOutTime,
        highwayRoute: e.highwayRoute,
        routeDescription: e.routeDescription,
        terrainSummary: e.terrainSummary,
        pointsOfInterest: e.pointsOfInterest,
        activities: e.activities?.length ? e.activities : null,
        transitNote: e.transitNote,
      }))
      tripsApi.saveItinerary(id, payload).catch(() => {})
    }, 600)
  }, [id])

  // Persist checkInTime / checkOutTime to stop record (debounced per stop)
  const persistStop = useCallback((stop: Stop, data: { checkInTime?: string; checkOutTime?: string }) => {
    const existing = stopSaveTimers.current.get(stop.id)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      tripsApi.updateStop(stop.tripId, stop.id, data).catch(() => {})
      stopSaveTimers.current.delete(stop.id)
    }, 600)
    stopSaveTimers.current.set(stop.id, t)
  }, [])

  // ── Time change handlers ────────────────────────────────────────────────────

  const updateOvernightDepart = (idx: number, time: string) => {
    setEntries(prev => {
      const updated = prev.map((e, i) => i === idx ? { ...e, departureTime: time } : e)
      const cascaded = cascadeChange(updated, idx, 'overnightDepart')
      persistItinerary(cascaded)
      return cascaded
    })
  }

  const updateOvernightCheckIn = (idx: number, time: string) => {
    setEntries(prev => {
      const updated = prev.map((e, i) => i === idx ? { ...e, checkInTime: time } : e)
      persistItinerary(updated)
      if (updated[idx].stop) persistStop(updated[idx].stop!, { checkInTime: time })
      return updated
    })
  }

  const toggleActivity = (entryIdx: number, actIdx: number) => {
    setEntries(prev => {
      const next = prev.map((e, i) => i !== entryIdx ? e : {
        ...e,
        activities: e.activities.map((a, j) => j === actIdx ? { ...a, checked: !a.checked } : a),
      })
      persistItinerary(next)
      return next
    })
  }

  const addActivity = (entryIdx: number) => {
    const name = (addingActivity[entryIdx] || '').trim()
    if (!name) return
    setEntries(prev => {
      const next = prev.map((e, i) =>
        i !== entryIdx ? e : { ...e, activities: [...e.activities, { name, checked: false, isCustom: true }] }
      )
      persistItinerary(next)
      return next
    })
    setAddingActivity(prev => ({ ...prev, [entryIdx]: '' }))
  }

  const deleteActivity = (entryIdx: number, actIdx: number) => {
    setEntries(prev => {
      const next = prev.map((e, i) =>
        i !== entryIdx ? e : { ...e, activities: e.activities.filter((_, j) => j !== actIdx) }
      )
      persistItinerary(next)
      return next
    })
  }

  if (loading) return (
    <div className="flex justify-center py-20">
      <div className="w-6 h-6 border-2 border-[#1D9E75] border-t-transparent rounded-full animate-spin" />
    </div>
  )
  if (!trip) return null

  const sortedStops = [...(trip.stops || [])].sort((a, b) => a.order - b.order)
  const totalCamp = sortedStops.reduce((sum, s) => sum + (s.siteRate || 0) * s.nights, 0)
  const grandTotal = totalCamp + (trip.estimatedFuel || 0)

  return (
    <div className="space-y-6 max-w-3xl">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-medium text-gray-900">{trip.name}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{trip.startLocation} → {trip.endLocation}</p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button className="btn-outline text-sm flex items-center gap-1.5"><Share2 size={14} /> Share</button>
          <button
            onClick={handleDownloadPDF}
            disabled={downloadingPdf}
            className="btn-primary text-sm flex items-center gap-1.5 disabled:opacity-60"
          >
            {downloadingPdf
              ? <><RefreshCw size={14} className="animate-spin" /> Generating…</>
              : <><Download size={14} /> PDF</>
            }
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="card-lg">
        <h2 className="font-medium text-gray-900 mb-4">Trip at a Glance</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCell value={trip.totalMiles?.toLocaleString() || '–'} label="Total miles" />
          <StatCell value={String(trip.totalNights || sortedStops.reduce((s, st) => s + st.nights, 0))} label="Nights" />
          <StatCell value={String(sortedStops.length)} label="Stops" />
          <StatCell value={`$${grandTotal.toLocaleString()}`} label="Est. total" />
        </div>
      </div>

      {/* Timeline */}
      <div className="card-lg">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-medium text-gray-900">Day-by-Day Itinerary</h2>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-1.5 text-sm text-[#1D9E75] hover:text-[#178a65] disabled:opacity-50 transition-colors"
          >
            {generating ? <RefreshCw size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {generating ? 'Generating…' : hasAI ? 'Regenerate' : 'Generate AI Itinerary'}
          </button>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 flex-wrap mb-4 px-1">
          {[
            { color: 'bg-blue-500',   icon: Car,  label: 'Drive segment' },
            { color: 'bg-green-500',  icon: Tent, label: 'Campground stay' },
            { color: 'bg-amber-500',  icon: Star, label: 'Activity day' },
            { color: 'bg-purple-500', icon: Moon, label: 'Overnight stop' },
          ].map(({ color, icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-1.5">
              <div className={`w-3.5 h-3.5 rounded-sm ${color} flex items-center justify-center flex-shrink-0`}>
                <Icon size={9} className="text-white" />
              </div>
              <span className="text-xs text-gray-500">{label}</span>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          {entries.map((entry, idx) => (
            <TimelineRow
              key={idx}
              entry={entry}
              generatingActivities={generatingActivities}
              onOvernightDepart={time => updateOvernightDepart(idx, time)}
              onOvernightCheckIn={time => updateOvernightCheckIn(idx, time)}
              onToggleActivity={actIdx => toggleActivity(idx, actIdx)}
              onDeleteActivity={actIdx => deleteActivity(idx, actIdx)}
              addingText={addingActivity[idx] ?? ''}
              onAddingChange={text => setAddingActivity(prev => ({ ...prev, [idx]: text }))}
              onAddActivity={() => addActivity(idx)}
            />
          ))}
          {entries.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">No stops added yet.</p>
          )}
        </div>
      </div>

      {/* Cost Breakdown */}
      <div className="card-lg">
        <h2 className="font-medium text-gray-900 mb-4">Cost Breakdown</h2>
        <div className="space-y-2">
          {sortedStops.filter(s => s.siteRate || s.estimatedFuel).map(stop => (
            <div key={stop.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 bg-[#E1F5EE] rounded-full flex items-center justify-center text-[#1D9E75] text-xs">{stop.order}</div>
                <span className="text-sm text-gray-700">{stop.locationName}</span>
              </div>
              <div className="text-right text-sm space-x-2">
                {stop.siteRate && <span className="text-gray-600">${(stop.siteRate * stop.nights).toLocaleString()} camp</span>}
                {stop.estimatedFuel && <span className="text-gray-400">${stop.estimatedFuel.toLocaleString()} fuel</span>}
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2 font-medium">
            <span className="text-gray-900">Total</span>
            <span className="text-[#1D9E75]">${grandTotal.toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── TimePicker ───────────────────────────────────────────────────────────────

function TimePicker({ value, onChange, className }: {
  value: string
  onChange: (v: string) => void
  className?: string
}) {
  const options: { v: string; label: string }[] = []
  for (let h = 5; h <= 23; h++) {
    for (const m of [0, 30]) {
      if (h === 23 && m === 30) continue
      const hh = h.toString().padStart(2, '0')
      const mm = m.toString().padStart(2, '0')
      const period = h >= 12 ? 'pm' : 'am'
      const dH = h > 12 ? h - 12 : h === 0 ? 12 : h
      options.push({ v: `${hh}:${mm}`, label: `${dH}:${mm}${period}` })
    }
  }
  // Ensure current value is in list even if outside range
  if (!options.find(o => o.v === value)) {
    options.unshift({ v: value, label: fmtTime(value) })
  }
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={`text-sm font-semibold border border-gray-200 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:border-[#1D9E75] cursor-pointer ${className ?? ''}`}
    >
      {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
    </select>
  )
}

// ─── StatCell ─────────────────────────────────────────────────────────────────

function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <div className="text-2xl font-medium text-[#1D9E75]">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  )
}

// ─── TimelineRow ──────────────────────────────────────────────────────────────

interface TimelineRowProps {
  entry: TimelineEntry
  generatingActivities: boolean
  onOvernightDepart: (t: string) => void
  onOvernightCheckIn: (t: string) => void
  onToggleActivity: (actIdx: number) => void
  onDeleteActivity: (actIdx: number) => void
  addingText: string
  onAddingChange: (text: string) => void
  onAddActivity: () => void
}

function TimelineRow({
  entry, generatingActivities,
  onOvernightDepart, onOvernightCheckIn,
  onToggleActivity, onDeleteActivity, addingText, onAddingChange, onAddActivity,
}: TimelineRowProps) {
  const cfg = ROW_CONFIG[entry.type]
  const Icon = cfg.icon

  return (
    <div className={`rounded-lg border ${cfg.bg} ${cfg.border} overflow-hidden`}>
      <div className="flex items-start gap-3 px-4 py-3">

        {/* Date column */}
        <div className="flex-shrink-0 w-16 text-center">
          {entry.date ? (
            <>
              <div className="text-xs text-gray-400">{format(entry.date, 'EEE')}</div>
              <div className="text-sm font-semibold text-gray-700">{format(entry.date, 'MMM d')}</div>
            </>
          ) : (
            <div className={`text-xs font-medium ${cfg.text}`}>Day {entry.dayNum}</div>
          )}
        </div>

        <div className={`w-px self-stretch border-l ${cfg.border}`} />

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Row header */}
          <div className="flex items-center gap-1.5 mb-2">
            <Icon size={13} className={cfg.text} />
            <span className={`text-xs font-semibold uppercase tracking-wide ${cfg.text}`}>
              {entry.type === 'ACTIVITY' && entry.stop
                ? `Day ${entry.nightNum} at ${entry.stop.locationName}`
                : cfg.label}
            </span>
          </div>

          {entry.type === 'DRIVE' && (
            <DriveContent entry={entry} />
          )}
          {entry.type === 'STAY' && entry.stop && (
            <StayContent entry={entry} />
          )}
          {entry.type === 'ACTIVITY' && entry.stop && (
            <ActivityContent
              entry={entry}
              generatingActivities={generatingActivities}
              onToggleActivity={onToggleActivity}
              onDeleteActivity={onDeleteActivity}
              addingText={addingText}
              onAddingChange={onAddingChange}
              onAddActivity={onAddActivity}
            />
          )}
          {entry.type === 'OVERNIGHT' && entry.stop && (
            <OvernightContent
              entry={entry}
              onCheckIn={onOvernightCheckIn}
              onDepart={onOvernightDepart}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── DriveContent ─────────────────────────────────────────────────────────────

function DriveContent({ entry }: { entry: TimelineEntry }) {
  const fromName = entry.prevStop
    ? `${entry.prevStop.locationName}${entry.prevStop.locationState ? ', ' + entry.prevStop.locationState : ''}`
    : '—'
  const toName = entry.stop
    ? `${entry.stop.locationName}${entry.stop.locationState ? ', ' + entry.stop.locationState : ''}`
    : '—'

  return (
    <div className="flex items-center gap-1.5 text-sm font-medium text-gray-700">
      <MapPin size={12} className="text-gray-400 flex-shrink-0" />
      <span className="truncate">{fromName}</span>
      <ArrowRight size={12} className="text-gray-400 flex-shrink-0" />
      <span className="truncate">{toName}</span>
    </div>
  )
}

// ─── StayContent ──────────────────────────────────────────────────────────────

function StayContent({ entry }: { entry: TimelineEntry }) {
  const stop = entry.stop!
  return (
    <div className="space-y-0.5">
      <div className="text-sm font-semibold text-gray-800">
        {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
      </div>
      {stop.campgroundName && (
        <div className="text-sm text-gray-500">{stop.campgroundName}</div>
      )}
    </div>
  )
}

// ─── ActivityContent ──────────────────────────────────────────────────────────

function ActivityContent({ entry, generatingActivities, onToggleActivity, onDeleteActivity, addingText, onAddingChange, onAddActivity }: {
  entry: TimelineEntry
  generatingActivities: boolean
  onToggleActivity: (actIdx: number) => void
  onDeleteActivity: (actIdx: number) => void
  addingText: string
  onAddingChange: (text: string) => void
  onAddActivity: () => void
}) {
  const stop = entry.stop!
  return (
    <div className="space-y-2">
      {/* Date + staying-at */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-base font-semibold text-gray-800">{fmtDate(entry.date)}</span>
        {stop.campgroundName && (
          <span className="text-sm text-gray-500">· Staying at {stop.campgroundName}</span>
        )}
        {!stop.campgroundName && (
          <span className="text-sm text-gray-500">
            · {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
          </span>
        )}
      </div>

      {/* Activities list */}
      {entry.activities.length > 0 ? (
        <ul className="space-y-1.5">
          {entry.activities.map((act, i) => (
            <li key={i} className="flex items-start gap-2 group">
              <button
                onClick={() => onToggleActivity(i)}
                className={`mt-0.5 w-4 h-4 rounded flex-shrink-0 flex items-center justify-center border transition-colors ${
                  act.checked ? 'bg-amber-500 border-amber-500 text-white' : 'border-gray-300 bg-white hover:border-amber-400'
                }`}
              >
                {act.checked && <Check size={10} />}
              </button>
              <span className={`flex-1 text-sm leading-snug ${act.checked ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                {act.name}
              </span>
              <button
                onClick={() => onDeleteActivity(i)}
                className="opacity-0 group-hover:opacity-100 flex-shrink-0 text-gray-300 hover:text-red-400 transition-all mt-0.5"
                aria-label="Remove activity"
              >
                <XCircle size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : generatingActivities ? (
        <div className="space-y-2 py-1">
          {[1, 2, 3].map(n => (
            <div key={n} className="flex items-center gap-2">
              <div className="w-4 h-4 rounded border border-gray-200 bg-gray-100 flex-shrink-0 animate-pulse" />
              <div className={`h-3 bg-gray-100 rounded animate-pulse ${n === 1 ? 'w-48' : n === 2 ? 'w-40' : 'w-44'}`} />
            </div>
          ))}
        </div>
      ) : null}

      {/* Add activity input */}
      <div className="flex items-center gap-2 pt-1">
        <input
          type="text"
          value={addingText}
          onChange={e => onAddingChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onAddActivity() }}
          placeholder="Add activity…"
          className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-amber-400 bg-white"
        />
        <button
          onClick={onAddActivity}
          disabled={!addingText.trim()}
          className="flex items-center gap-1 text-xs text-amber-600 hover:text-amber-700 disabled:opacity-40"
        >
          <Plus size={12} /> Add
        </button>
      </div>
    </div>
  )
}

// ─── OvernightContent ─────────────────────────────────────────────────────────

function OvernightContent({ entry, onCheckIn, onDepart }: {
  entry: TimelineEntry
  onCheckIn: (t: string) => void
  onDepart: (t: string) => void
}) {
  const stop = entry.stop!
  const departureDate = entry.date ? addDays(entry.date, 1) : undefined

  return (
    <div className="space-y-2.5">
      <div className="text-base font-semibold text-gray-800">
        {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
      </div>
      {stop.campgroundName && <div className="text-sm text-gray-500">{stop.campgroundName}</div>}

      {/* Arrive / Depart side by side */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-2 bg-white border border-purple-100 rounded-lg px-3 py-1.5">
          <span className="text-xs text-gray-500 font-medium">Arrive</span>
          <span className="text-sm font-semibold text-gray-700">{fmtDate(entry.date)}</span>
          <span className="text-gray-300">·</span>
          <TimePicker value={entry.checkInTime} onChange={onCheckIn} />
        </div>
        <div className="flex items-center gap-2 bg-white border border-purple-100 rounded-lg px-3 py-1.5">
          <span className="text-xs text-gray-500 font-medium">Depart</span>
          <span className="text-sm font-semibold text-gray-700">{fmtDate(departureDate)}</span>
          <span className="text-gray-300">·</span>
          <TimePicker value={entry.departureTime} onChange={onDepart} />
        </div>
      </div>

      {entry.transitNote
        ? <p className="text-sm text-gray-600">{entry.transitNote}</p>
        : <p className="text-xs text-gray-400">Transit stop — continuing tomorrow morning</p>
      }
    </div>
  )
}
