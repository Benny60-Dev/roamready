import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import {
  Download, Share2, Sparkles, Car, Tent, Star, Moon,
  MapPin, XCircle, Plus, Check, RefreshCw, ArrowRight, Clock,
  Pencil, Trash2, Wand2,
} from 'lucide-react'
import ModifyTripPanel from '../../components/trip/ModifyTripPanel'
import { pdf } from '@react-pdf/renderer'
import { tripsApi, aiApi } from '../../services/api'
import { Trip, Stop, ItineraryDay, ItineraryActivity, StopWeather } from '../../types'
import { format, addDays } from 'date-fns'
import { TripPDF } from '../../components/pdf/TripPDF'
import { StopWeatherCard } from '../../components/weather/StopWeatherCard'

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

// ─── Parse "3h 30min" / "45 min" → fractional hours ─────────────────────────

function parseDurationToHours(str?: string | null): number | undefined {
  if (!str) return undefined
  const hMatch = str.match(/(\d+)h/)
  const mMatch = str.match(/(\d+)\s*min/)
  const hours = hMatch ? parseInt(hMatch[1]) : 0
  const minutes = mMatch ? parseInt(mMatch[1]) : 0
  if (hours === 0 && minutes === 0) return undefined
  return hours + minutes / 60
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
  driveDuration?: string | null
  routeHighlights?: string | null
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
      // Prefer Routes API actual distance; fall back to Haversine straight-line
      const miles = stop.driveDistanceMiles
        ?? calcDistanceMiles(prevStop.latitude, prevStop.longitude, stop.latitude, stop.longitude)
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
        highwayRoute: stop.highwayRoute ?? null,
        driveDuration: stop.driveDuration ?? null,
        routeHighlights: stop.routeHighlights ?? null,
        activities: [],
      })
      dayNum++
      // ↑ DON'T advance date — arrival is the same calendar day as the drive
    }

    // ── Overnight transit stop ────────────────────────────────────────────────
    if (stop.type === 'OVERNIGHT_ONLY') {
      // Prefer stop.arrivalDate (kept in sync by the cascade save after every edit).
      // Fall back to currentDate when no DB date exists yet.
      entries.push({
        dayNum,
        date: stop.arrivalDate
          ? new Date(stop.arrivalDate)
          : currentDate ? new Date(currentDate) : undefined,
        type: 'OVERNIGHT',
        stop,
        departureTime: '06:00',
        checkInTime: '18:00',
        checkOutTime: '06:00',
        activities: [],
      })
      dayNum++
      if (currentDate) currentDate = addDays(currentDate, 1)

    // ── HOME stop — always render one STAY entry as the departure point ─────
    } else if (stop.type === 'HOME') {
      entries.push({
        dayNum,
        date: currentDate ? new Date(currentDate) : undefined,
        type: 'STAY',
        stop,
        nightNum: 1,
        departureTime: '08:00',
        checkInTime: '08:00',
        checkOutTime: '08:00',
        activities: [],
      })
      dayNum++
      // Do not advance date — the trip hasn't started yet

    // ── Destination ───────────────────────────────────────────────────────────
    } else {
      const nights = stop.nights ?? 0
      for (let n = 0; n < nights; n++) {
        // Prefer stop.arrivalDate + offset (authoritative after a cascade save).
        // Fall back to currentDate when no DB date exists yet.
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
      highwayRoute: entry.highwayRoute ?? ai.highwayRoute,
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
  if (field === 'driveDepart' && entry.type === 'DRIVE') {
    const driveHours = parseDurationToHours(entry.driveDuration) ?? entry.driveHours
    if (driveHours) {
      const arr = calcArrival(entry.departureTime, driveHours)
      if (idx + 1 < next.length && (next[idx + 1].type === 'STAY' || next[idx + 1].type === 'OVERNIGHT')) {
        next[idx + 1].checkInTime = arr.timeHHMM
      }
    }
  }

  // STAY check-out → update the next DRIVE departure (skipping ACTIVITY rows for same stop)
  if (field === 'stayCheckOut' && entry.type === 'STAY') {
    for (let j = idx + 1; j < next.length; j++) {
      if (next[j].type === 'DRIVE') {
        next[j].departureTime = entry.checkOutTime
        // Cascade the drive departure change too
        const driveHoursJ = parseDurationToHours(next[j].driveDuration) ?? next[j].driveHours
        if (driveHoursJ) {
          const arr = calcArrival(next[j].departureTime, driveHoursJ)
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
  const [weatherData, setWeatherData] = useState<Record<string, StopWeather | null | undefined>>({})
  const [editingStop, setEditingStop] = useState<Stop | null>(null)
  const [addAfterOrder, setAddAfterOrder] = useState<number | null>(null)
  const [mutating, setMutating] = useState(false)
  const [modifyPanelOpen, setModifyPanelOpen] = useState(false)
  const itinerarySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activityGenAttempted = useRef(false)

  const reloadTrip = useCallback(async () => {
    if (!id) return
    const res = await tripsApi.get(id)
    const t: Trip = res.data
    setTrip(t)
    const sorted = [...(t.stops || [])].sort((a, b) => a.order - b.order)
    const raw = buildTimeline(sorted, t.startDate ?? undefined)
    setEntries(t.itinerary ? mergeAI(raw, t.itinerary) : raw)
  }, [id])

  useEffect(() => {
    if (!id) return
    reloadTrip().finally(() => setLoading(false))
  }, [id])

  // Load weather once trip is ready
  useEffect(() => {
    if (!trip?.stops?.length || !id) return
    const initial: Record<string, StopWeather | null | undefined> = {}
    for (const s of trip.stops) {
      if (s.latitude && s.longitude) initial[s.id] = undefined
    }
    setWeatherData(initial)
    tripsApi.getWeather(id)
      .then(res => setWeatherData(prev => ({ ...prev, ...res.data })))
      .catch(() => {
        setWeatherData(prev => {
          const next = { ...prev }
          for (const k of Object.keys(next)) if (next[k] === undefined) next[k] = null
          return next
        })
      })
  }, [trip?.id])

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
    console.log('Starting PDF download')
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

      // Fetch static map image from server and convert to blob URL
      // (react-pdf v4 uses Buffer to decode data: URLs in the browser — passing a blob URL avoids that)
      console.log('Fetching map image...')
      let mapBlobUrl: string | null = null
      try {
        const mapRes = await tripsApi.getMapImage(trip.id)
        const dataUrl: string | null = mapRes.data?.base64 ?? null
        console.log('Map image fetched:', dataUrl ? `${dataUrl.length} chars` : 'null')
        if (dataUrl) {
          const fetchRes = await fetch(dataUrl)
          const imgBlob = await fetchRes.blob()
          mapBlobUrl = URL.createObjectURL(imgBlob)
          console.log('Map blob URL created:', mapBlobUrl)
        }
      } catch (mapErr) {
        console.error('[PDF] map image fetch failed:', mapErr)
        // Map image is optional — proceed without it
      }

      const blob = await pdf(<TripPDF trip={tripWithEntries} mapImageBase64={mapBlobUrl} />).toBlob()
      if (mapBlobUrl) URL.revokeObjectURL(mapBlobUrl)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `RoamReady-${trip.name.replace(/[^a-zA-Z0-9]+/g, '-')}-Itinerary.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('[PDF] generation failed:', err)
      alert('PDF generation failed. Please try again.')
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

  // ── Date cascade ────────────────────────────────────────────────────────────
  // Walks every stop in order, computes correct arrivalDate / departureDate from
  // the anchor (trip.startDate if set, otherwise today), saves each one to the DB,
  // then updates trip.totalNights and trip.endDate.
  // Always runs — never skipped for missing startDate.

  const cascadeAndSaveDates = useCallback(async (stops: Stop[]) => {
    if (!id) return
    const sorted = [...stops].sort((a, b) => a.order - b.order)

    // Use trip.startDate as anchor; fall back to today if trip has no start date.
    const anchor = trip?.startDate ? new Date(trip.startDate) : new Date()
    let current = new Date(anchor)

    let totalNights = 0

    console.log('[cascade] Starting date cascade for', sorted.length, 'stops, anchor =', current.toISOString())

    for (const s of sorted) {
      const nights = s.type === 'OVERNIGHT_ONLY' ? 1 : (s.nights || 0)
      const arrivalISO   = new Date(current).toISOString()
      const departureISO = addDays(new Date(current), nights).toISOString()

      await tripsApi.updateStop(id, s.id, { arrivalDate: arrivalISO, departureDate: departureISO })
      console.log(`[cascade] Updated stop "${s.locationName}" arrivalDate to ${arrivalISO} (${nights} night${nights !== 1 ? 's' : ''})`)

      totalNights += nights
      current = addDays(current, nights)
    }

    const endDate = current.toISOString()
    await tripsApi.update(id, { totalNights, endDate })
    console.log(`[cascade] Updated trip totalNights=${totalNights} endDate=${endDate}`)
  }, [id, trip?.startDate])

  // ── Stop mutation handlers ──────────────────────────────────────────────────

  const handleDeleteStop = async (stop: Stop) => {
    if (!id || !trip) return
    if (!window.confirm(`Remove this stop from your trip? This cannot be undone.`)) return
    setMutating(true)
    try {
      await tripsApi.deleteStop(id, stop.id)
      // Renumber remaining stops 1…N in order
      const remaining = (trip.stops || [])
        .filter(s => s.id !== stop.id)
        .sort((a, b) => a.order - b.order)
        .map((s, i) => ({ ...s, order: i + 1 }))
      await Promise.all(remaining.map(s => tripsApi.updateStop(id, s.id, { order: s.order })))
      // Recascade all dates with the updated stop list
      await cascadeAndSaveDates(remaining as Stop[])
      await reloadTrip()
    } finally {
      setMutating(false)
    }
  }

  const handleInsertStop = async (data: { locationName: string; type: string; nights: number; notes?: string }) => {
    if (!id || !trip || addAfterOrder === null) return
    setMutating(true)
    try {
      // Create stop (server appends at maxOrder+1)
      const res = await tripsApi.createStop(id, { ...data, bookingStatus: 'NOT_BOOKED' })
      const newStop: Stop = res.data
      const sorted = [...(trip.stops || [])].sort((a, b) => a.order - b.order)
      const insertOrder = addAfterOrder + 1

      // Build final stop list: shift existing stops ≥ insertOrder up by 1, place new stop
      const finalStops = [
        ...sorted.map(s => s.order >= insertOrder ? { ...s, order: s.order + 1 } : s),
        { ...newStop, order: insertOrder, nights: data.nights || 1 },
      ].sort((a, b) => a.order - b.order)

      await Promise.all(finalStops.map(s => tripsApi.updateStop(id, s.id, { order: s.order })))
      await cascadeAndSaveDates(finalStops as Stop[])
      setAddAfterOrder(null)
      await reloadTrip()
    } finally {
      setMutating(false)
    }
  }

  const handleSaveEditStop = async (stop: Stop, data: Partial<Stop>) => {
    if (!id || !trip) return
    setMutating(true)
    try {
      // Step 1: persist the field changes (locationName, campgroundName, nights, etc.)
      await tripsApi.updateStop(id, stop.id, data)
      console.log(`[handleSaveEditStop] Saved stop "${stop.locationName}" — nights:`, data.nights ?? '(unchanged)')

      // Step 2: if nights changed, recascade every stop's arrivalDate/departureDate
      if (data.nights !== undefined) {
        // Build in-memory list with the new nights value applied
        const updatedStops = (trip.stops || []).map(s =>
          s.id === stop.id ? { ...s, nights: data.nights! } : s
        )
        await cascadeAndSaveDates(updatedStops)
      }

      setEditingStop(null)

      // Step 3: reload fresh data from DB — timeline rebuilds from the new arrivalDates
      await reloadTrip()
    } finally {
      setMutating(false)
    }
  }

  // Highway routes are now extracted by TripMapPage from the Google Maps Routes API
  // and saved directly to each stop record. buildTimeline reads stop.highwayRoute,
  // so routes appear automatically once the map page has been visited.

  // ── Time change handlers ────────────────────────────────────────────────────

  const updateDriveDepart = (idx: number, time: string) => {
    setEntries(prev => {
      const updated = prev.map((e, i) => i === idx ? { ...e, departureTime: time } : e)
      const cascaded = cascadeChange(updated, idx, 'driveDepart')
      persistItinerary(cascaded)
      return cascaded
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
  const stopDisplayNumbers: Record<string, number> = {}
  let _dn = 1
  sortedStops.forEach(s => { if (s.type !== 'HOME') stopDisplayNumbers[s.id] = _dn++ })
  const totalCamp = sortedStops.reduce((sum, s) => sum + (s.siteRate || 0) * s.nights, 0)
  const grandTotal = totalCamp + (trip.estimatedFuel || 0)

  // Live total miles: prefer Routes API driveDistanceMiles per stop, fall back to Haversine.
  const liveTotalMiles = sortedStops.slice(1).reduce((sum, stop, i) => {
    const prev = sortedStops[i]
    const segMiles = stop.driveDistanceMiles
      ?? calcDistanceMiles(prev.latitude, prev.longitude, stop.latitude, stop.longitude)
    return sum + segMiles
  }, 0)

  return (
    <div className="space-y-6 max-w-3xl">
      <Breadcrumb items={[
        { label: 'My Trips', href: '/trips' },
        { label: trip.name, href: `/trips/${id}/map` },
        { label: 'Full Itinerary' },
      ]} />

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-medium text-gray-900">{trip.name}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{trip.startLocation} → {trip.endLocation}</p>
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
          <button
            onClick={() => setModifyPanelOpen(true)}
            className="btn-outline text-sm flex items-center gap-1.5 border-[#1D9E75] text-[#1D9E75] hover:bg-[#E1F5EE]"
          >
            <Wand2 size={14} /> Modify with AI
          </button>
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
          <StatCell value={liveTotalMiles > 0 ? liveTotalMiles.toLocaleString() : (trip.totalMiles?.toLocaleString() || '–')} label="Total miles" />
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
            { color: 'bg-blue-500',   icon: Car,  label: 'Drive day' },
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
          {(() => {
            // Group consecutive entries that share the same stop.id
            type Group = { stopId: string | null; stopOrder: number; isHome: boolean; entries: TimelineEntry[] }
            const groups: Group[] = []
            for (const entry of entries) {
              const sid = entry.stop?.id ?? null
              const last = groups[groups.length - 1]
              if (!last || last.stopId !== sid) {
                groups.push({
                  stopId: sid,
                  stopOrder: entry.stop?.order ?? 0,
                  isHome: entry.stop?.type === 'HOME',
                  entries: [entry],
                })
              } else {
                last.entries.push(entry)
              }
            }

            const rendered: JSX.Element[] = []
            // Track flat index for handlers
            let flatIdx = 0
            groups.forEach((group, gi) => {
              group.entries.forEach(entry => {
                const idx = flatIdx++
                const isEditable = (entry.type === 'STAY' || entry.type === 'OVERNIGHT') && entry.stop?.type !== 'HOME'
                const isDeletable = isEditable && (sortedStops.length > 2) // keep at least 2 stops (start + end)
                rendered.push(
                  <TimelineRow
                    key={`entry-${idx}`}
                    entry={entry}
                    generatingActivities={generatingActivities}
                    weather={entry.stop ? weatherData[entry.stop.id] : undefined}
                    onDriveDepart={time => updateDriveDepart(idx, time)}
                    onToggleActivity={actIdx => toggleActivity(idx, actIdx)}
                    onDeleteActivity={actIdx => deleteActivity(idx, actIdx)}
                    addingText={addingActivity[idx] ?? ''}
                    onAddingChange={text => setAddingActivity(prev => ({ ...prev, [idx]: text }))}
                    onAddActivity={() => addActivity(idx)}
                    onEdit={isEditable ? () => setEditingStop(entry.stop!) : undefined}
                    onDelete={isDeletable ? () => handleDeleteStop(entry.stop!) : undefined}
                  />
                )
              })
              // Insert "Add stop" button after each non-last group (and not after HOME groups)
              if (gi < groups.length - 1 && !group.isHome) {
                const afterOrder = group.stopOrder
                rendered.push(
                  <button
                    key={`insert-${gi}`}
                    onClick={() => setAddAfterOrder(afterOrder)}
                    disabled={mutating}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs text-gray-400 hover:text-[#1D9E75] hover:bg-green-50 rounded-lg border border-dashed border-gray-200 hover:border-green-300 transition-colors disabled:opacity-40"
                  >
                    <Plus size={11} /> Add stop here
                  </button>
                )
              }
            })

            if (entries.length === 0) {
              rendered.push(
                <p key="empty" className="text-sm text-gray-400 text-center py-8">No stops added yet.</p>
              )
            }
            return rendered
          })()}
        </div>

        {/* Add stop at end */}
        <button
          onClick={() => setAddAfterOrder(sortedStops.length > 0 ? sortedStops[sortedStops.length - 1].order : 0)}
          disabled={mutating}
          className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 text-sm text-[#1D9E75] hover:bg-green-50 rounded-lg border border-dashed border-green-200 hover:border-green-300 transition-colors disabled:opacity-40"
        >
          <Plus size={13} /> Add stop
        </button>
      </div>

      {/* Cost Breakdown */}
      <div className="card-lg">
        <h2 className="font-medium text-gray-900 mb-4">Cost Breakdown</h2>
        <div className="space-y-2">
          {sortedStops.filter(s => s.siteRate || s.estimatedFuel).map(stop => (
            <div key={stop.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
              <div className="flex items-center gap-2">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${stop.type === 'HOME' ? 'bg-gray-100 text-gray-500' : 'bg-[#E1F5EE] text-[#1D9E75]'}`}>
                  {stop.type === 'HOME' ? 'H' : stopDisplayNumbers[stop.id]}
                </div>
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

      {/* Modals */}
      {editingStop && (
        <EditStopModal
          stop={editingStop}
          onSave={data => handleSaveEditStop(editingStop, data)}
          onClose={() => setEditingStop(null)}
          saving={mutating}
        />
      )}
      {addAfterOrder !== null && (
        <AddStopModal
          afterOrder={addAfterOrder}
          surroundingStops={sortedStops}
          onAdd={handleInsertStop}
          onClose={() => setAddAfterOrder(null)}
          saving={mutating}
        />
      )}

      {/* Modify Trip AI panel */}
      <ModifyTripPanel
        trip={trip}
        isOpen={modifyPanelOpen}
        onClose={() => setModifyPanelOpen(false)}
        onTripUpdated={async (_updated) => {
          await reloadTrip()
        }}
      />
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
  weather?: StopWeather | null
  onDriveDepart: (t: string) => void
  onToggleActivity: (actIdx: number) => void
  onDeleteActivity: (actIdx: number) => void
  addingText: string
  onAddingChange: (text: string) => void
  onAddActivity: () => void
  onEdit?: () => void
  onDelete?: () => void
}

function TimelineRow({
  entry, generatingActivities, weather,
  onDriveDepart,
  onToggleActivity, onDeleteActivity, addingText, onAddingChange, onAddActivity,
  onEdit, onDelete,
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
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <Icon size={13} className={cfg.text} />
              <span className={`text-xs font-semibold uppercase tracking-wide ${cfg.text}`}>
                {entry.type === 'STAY' && entry.stop?.type === 'HOME'
                  ? 'Departure Point'
                  : entry.type === 'ACTIVITY' && entry.stop
                    ? `Day ${entry.nightNum} at ${entry.stop.locationName}`
                    : cfg.label}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {entry.type === 'DRIVE' && entry.driveDuration && (
                <span className="flex items-center gap-1 text-xs font-semibold text-blue-600 bg-blue-100 px-2 py-0.5 rounded-full">
                  <Clock size={10} />
                  {entry.driveDuration}
                </span>
              )}
              {onEdit && (
                <button
                  onClick={onEdit}
                  title="Edit stop"
                  className="p-1 text-gray-300 hover:text-gray-600 transition-colors rounded"
                >
                  <Pencil size={12} />
                </button>
              )}
              {onDelete && (
                <button
                  onClick={onDelete}
                  title="Remove stop"
                  className="p-1 text-gray-300 hover:text-red-500 transition-colors rounded"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          </div>

          {entry.type === 'DRIVE' && (
            <DriveContent entry={entry} onDepart={onDriveDepart} />
          )}
          {entry.type === 'STAY' && entry.stop && (
            <StayContent entry={entry} weather={weather} />
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
            <OvernightContent entry={entry} weather={weather} />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── DriveContent ─────────────────────────────────────────────────────────────

function DriveContent({ entry, onDepart }: { entry: TimelineEntry; onDepart: (t: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [highlights, setHighlights] = useState<string | null>(entry.routeHighlights ?? null)
  const [loadingHighlights, setLoadingHighlights] = useState(false)

  const fromName = entry.prevStop
    ? `${entry.prevStop.locationName}${entry.prevStop.locationState ? ', ' + entry.prevStop.locationState : ''}`
    : '—'
  const toName = entry.stop
    ? `${entry.stop.locationName}${entry.stop.locationState ? ', ' + entry.stop.locationState : ''}`
    : '—'

  const driveHours = parseDurationToHours(entry.driveDuration) ?? entry.driveHours
  const arrival = driveHours ? calcArrival(entry.departureTime, driveHours) : null

  const handleToggle = async () => {
    const opening = !expanded
    setExpanded(opening)
    if (opening && !highlights && entry.stop) {
      setLoadingHighlights(true)
      try {
        const res = await tripsApi.generateRouteHighlights(entry.stop.tripId, entry.stop.id)
        setHighlights(res.data.routeHighlights ?? null)
      } catch {
        setHighlights('Could not load points of interest.')
      } finally {
        setLoadingHighlights(false)
      }
    }
  }

  // Parse response into individual bullet lines, strip leading punctuation
  const bullets = highlights
    ? highlights.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    : []

  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-1.5">
        <MapPin size={12} className="text-gray-400 flex-shrink-0" />
        <span className="truncate">{fromName}</span>
        <ArrowRight size={12} className="text-gray-400 flex-shrink-0" />
        <span className="truncate">{toName}</span>
      </div>
      {entry.highwayRoute && (
        <p className="text-xs text-gray-400 mb-1.5 ml-4">{entry.highwayRoute}</p>
      )}
      {/* Depart / arrive row */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500">Depart</span>
          <TimePicker value={entry.departureTime} onChange={onDepart} />
        </div>
        {arrival && (
          <>
            <ArrowRight size={12} className="text-gray-400 flex-shrink-0" />
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-500">Arrive</span>
              <span className="text-sm font-semibold text-gray-700">{arrival.timeStr}</span>
              {arrival.nextDay && <span className="text-xs text-gray-400">(+1 day)</span>}
            </div>
            {arrival.level === 'amber' && (
              <span className="text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full whitespace-nowrap">
                Late arrival — confirm after-hours check-in
              </span>
            )}
            {arrival.level === 'red' && (
              <span className="text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded-full whitespace-nowrap">
                Very late arrival — consider an earlier departure
              </span>
            )}
          </>
        )}
      </div>

      {/* Tell me more */}
      <button
        onClick={handleToggle}
        className="mt-2 text-xs text-[#1D9E75] hover:text-[#178a65] transition-colors font-medium"
      >
        {expanded ? 'Show less ↑' : 'Tell me more about this route ↓'}
      </button>

      {expanded && (
        <div className="mt-2 pl-3 border-l-2 border-green-200">
          {loadingHighlights ? (
            <div className="space-y-1.5 py-1">
              {[60, 80, 70].map((w, i) => (
                <div key={i} className={`h-3 bg-blue-100 rounded animate-pulse`} style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : (
            <ul className="space-y-1.5 py-0.5">
              {bullets.map((line, i) => (
                <li key={i} className="flex gap-2 text-xs text-gray-600 leading-snug">
                  <span className="text-[#1D9E75] flex-shrink-0 mt-0.5">•</span>
                  <span>{line.replace(/^[-•*\d.]+\s*/, '')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ─── StayContent ──────────────────────────────────────────────────────────────

function StayContent({ entry, weather }: { entry: TimelineEntry; weather?: StopWeather | null }) {
  const stop = entry.stop!
  const navigate = useNavigate()

  const [notesOpen, setNotesOpen] = useState(false)
  const [notesText, setNotesText] = useState(stop.notes ?? '')
  const [savedNotes, setSavedNotes] = useState(stop.notes ?? '')
  const [savingNotes, setSavingNotes] = useState(false)
  const [saveConfirm, setSaveConfirm] = useState(false)

  const handleSaveNotes = async () => {
    setSavingNotes(true)
    try {
      await tripsApi.updateStop(stop.tripId, stop.id, { notes: notesText })
      setSavedNotes(notesText)
      setNotesOpen(false)
      setSaveConfirm(true)
      setTimeout(() => setSaveConfirm(false), 2500)
    } finally {
      setSavingNotes(false)
    }
  }

  return (
    <div className="space-y-2.5">
      {/* Location + campground name */}
      <div className="space-y-0.5">
        <div className="text-sm font-semibold text-gray-800">
          {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
        </div>
        {stop.campgroundName && (
          <div className="text-sm text-gray-500">{stop.campgroundName}</div>
        )}
      </div>

      {/* Reserve Now / Confirmed — not shown for HOME (departure) stops */}
      {stop.type !== 'HOME' && (stop.confirmationNum ? (
        <div className="flex items-center gap-1.5 text-xs font-semibold text-green-700 bg-green-100 px-2.5 py-1 rounded-full w-fit">
          <Check size={11} />
          Confirmed · #{stop.confirmationNum}
        </div>
      ) : (
        <button
          onClick={() => navigate(`/trips/${stop.tripId}/booking?stopId=${stop.id}`)}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-[#1D9E75] hover:bg-[#178a65] px-3 py-1.5 rounded-lg transition-colors"
        >
          Reserve Now →
        </button>
      ))}

      {/* Notes */}
      <div>
        {notesOpen ? (
          <div className="space-y-1.5">
            <textarea
              value={notesText}
              onChange={e => setNotesText(e.target.value)}
              placeholder="Gate codes, special instructions, reminders…"
              rows={3}
              autoFocus
              className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-2 focus:outline-none focus:border-[#1D9E75] resize-none bg-white"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveNotes}
                disabled={savingNotes}
                className="text-xs font-semibold text-white bg-[#1D9E75] hover:bg-[#178a65] px-3 py-1 rounded-lg disabled:opacity-60 transition-colors"
              >
                {savingNotes ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => { setNotesText(savedNotes); setNotesOpen(false) }}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setNotesText(savedNotes); setNotesOpen(true) }}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              {savedNotes ? 'Edit notes' : '+ Add notes (gate codes, instructions…)'}
            </button>
            {saveConfirm && (
              <span className="text-xs text-green-600 font-medium">Saved ✓</span>
            )}
          </div>
        )}
      </div>

      {/* Weather card */}
      {stop.latitude && stop.longitude && (
        <StopWeatherCard stop={stop} weather={weather} compact />
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
        {entry.date && (
          <span className="text-base font-semibold text-gray-800">{fmtDate(entry.date)}</span>
        )}
        {stop.campgroundName && (
          <span className="text-sm text-gray-500">Staying at {stop.campgroundName}</span>
        )}
        {!stop.campgroundName && (
          <span className="text-sm text-gray-500">
            {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
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

function OvernightContent({ entry, weather }: { entry: TimelineEntry; weather?: StopWeather | null }) {
  const stop = entry.stop!
  return (
    <div className="space-y-1">
      <div className="text-sm font-semibold text-gray-800">
        {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
      </div>
      {stop.campgroundName && <div className="text-sm text-gray-500">{stop.campgroundName}</div>}
      {stop.siteRate != null && (
        <div className="text-xs text-gray-400">${stop.siteRate}/night</div>
      )}
      <p className="text-xs text-gray-400 italic">Early departure planned</p>

      {/* Weather card */}
      {stop.latitude && stop.longitude && (
        <StopWeatherCard stop={stop} weather={weather} compact />
      )}
    </div>
  )
}

// ─── Modal overlay wrapper ─────────────────────────────────────────────────────

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        {children}
      </div>
    </div>
  )
}

// ─── EditStopModal ─────────────────────────────────────────────────────────────

function EditStopModal({ stop, onSave, onClose, saving }: {
  stop: Stop
  onSave: (data: Partial<Stop>) => void
  onClose: () => void
  saving: boolean
}) {
  const [locationName, setLocationName] = useState(stop.locationName)
  const [campgroundName, setCampgroundName] = useState(stop.campgroundName ?? '')
  const [nights, setNights] = useState(stop.nights)
  const [type, setType] = useState<string>(stop.type)
  const [hookupType, setHookupType] = useState(stop.hookupType ?? '')
  const [notes, setNotes] = useState(stop.notes ?? '')

  const isHome = stop.type === 'HOME'

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({
      locationName: locationName.trim(),
      campgroundName: campgroundName.trim() || undefined,
      nights: Number(nights),
      type: type as Stop['type'],
      hookupType: hookupType || undefined,
      notes: notes.trim() || undefined,
    })
  }

  return (
    <ModalOverlay onClose={onClose}>
      <h2 className="text-base font-semibold text-gray-900 mb-4">Edit Stop</h2>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="label">Location name</label>
          <input
            className="input"
            value={locationName}
            onChange={e => setLocationName(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label">Campground name</label>
          <input
            className="input"
            value={campgroundName}
            onChange={e => setCampgroundName(e.target.value)}
            placeholder="Optional"
          />
        </div>
        {!isHome && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Stop type</label>
                <select className="input" value={type} onChange={e => setType(e.target.value)}>
                  <option value="DESTINATION">Destination</option>
                  <option value="OVERNIGHT_ONLY">Overnight only</option>
                </select>
              </div>
              <div>
                <label className="label">Nights</label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  className="input"
                  value={nights}
                  onChange={e => setNights(Number(e.target.value))}
                />
              </div>
            </div>
            <div>
              <label className="label">Hookup preference</label>
              <select className="input" value={hookupType} onChange={e => setHookupType(e.target.value)}>
                <option value="">Any / not specified</option>
                <option value="Full hookup">Full hookup</option>
                <option value="Water & Electric">Water &amp; Electric</option>
                <option value="Electric only">Electric only</option>
                <option value="Dry camping">Dry camping</option>
              </select>
            </div>
          </>
        )}
        <div>
          <label className="label">Notes</label>
          <textarea
            className="input resize-none"
            rows={3}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Gate codes, instructions, reminders…"
          />
        </div>
        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={saving || !locationName.trim()}
            className="btn-primary flex-1 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" onClick={onClose} className="btn-outline flex-1">
            Cancel
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}

// ─── AddStopModal ──────────────────────────────────────────────────────────────

function AddStopModal({ afterOrder, surroundingStops, onAdd, onClose, saving }: {
  afterOrder: number
  surroundingStops: Stop[]
  onAdd: (data: { locationName: string; type: string; nights: number; notes?: string }) => void
  onClose: () => void
  saving: boolean
}) {
  const [locationName, setLocationName] = useState('')
  const [type, setType] = useState('DESTINATION')
  const [nights, setNights] = useState(1)
  const [notes, setNotes] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([])

  const prevStop = surroundingStops.find(s => s.order === afterOrder)
  const nextStop = surroundingStops.find(s => s.order === afterOrder + 1)

  const handleAISuggest = async () => {
    setAiLoading(true)
    setAiSuggestions([])
    try {
      const prevName = prevStop?.locationName ?? 'the trip start'
      const nextName = nextStop?.locationName ?? 'the trip end'
      const prompt = `I'm planning an RV road trip and need stop suggestions between ${prevName} and ${nextName}. Suggest exactly 3 campground or overnight stops that would work well at this point in the route. Reply with ONLY a numbered list of location names (city, state format), nothing else. Example: 1. Flagstaff, AZ`
      const res = await aiApi.chat([{ role: 'user', content: prompt }])
      const text: string = res.data?.content ?? res.data?.message ?? ''
      const lines = text.split('\n')
        .map((l: string) => l.replace(/^\d+\.\s*/, '').trim())
        .filter((l: string) => l.length > 0)
        .slice(0, 3)
      setAiSuggestions(lines)
    } catch {
      setAiSuggestions(['Could not load suggestions — try typing a location manually.'])
    } finally {
      setAiLoading(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!locationName.trim()) return
    onAdd({
      locationName: locationName.trim(),
      type,
      nights: type === 'OVERNIGHT_ONLY' ? 1 : Number(nights),
      notes: notes.trim() || undefined,
    })
  }

  const insertLabel = prevStop && nextStop
    ? `after ${prevStop.locationName}`
    : prevStop
      ? `after ${prevStop.locationName}`
      : 'at the beginning'

  return (
    <ModalOverlay onClose={onClose}>
      <h2 className="text-base font-semibold text-gray-900 mb-1">Add stop</h2>
      <p className="text-xs text-gray-400 mb-4">Inserting {insertLabel}</p>

      {/* AI Suggestions */}
      <div className="mb-4">
        <button
          type="button"
          onClick={handleAISuggest}
          disabled={aiLoading}
          className="flex items-center gap-1.5 text-xs text-[#1D9E75] hover:text-[#178a65] font-medium disabled:opacity-50 transition-colors"
        >
          <Sparkles size={12} />
          {aiLoading ? 'Asking AI…' : 'Ask AI to suggest a stop here'}
        </button>
        {aiSuggestions.length > 0 && (
          <div className="mt-2 space-y-1">
            {aiSuggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setLocationName(s)}
                className={`w-full text-left text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                  locationName === s
                    ? 'border-[#1D9E75] bg-green-50 text-[#1D9E75] font-medium'
                    : 'border-gray-200 bg-gray-50 text-gray-700 hover:border-[#1D9E75] hover:bg-green-50'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="label">Location name</label>
          <input
            className="input"
            value={locationName}
            onChange={e => setLocationName(e.target.value)}
            placeholder="e.g. Flagstaff, AZ"
            required
            autoFocus
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Stop type</label>
            <select className="input" value={type} onChange={e => setType(e.target.value)}>
              <option value="DESTINATION">Destination</option>
              <option value="OVERNIGHT_ONLY">Overnight only</option>
            </select>
          </div>
          {type !== 'OVERNIGHT_ONLY' && (
            <div>
              <label className="label">Nights</label>
              <input
                type="number"
                min={1}
                max={30}
                className="input"
                value={nights}
                onChange={e => setNights(Number(e.target.value))}
              />
            </div>
          )}
        </div>
        <div>
          <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
          <textarea
            className="input resize-none"
            rows={2}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Gate codes, instructions…"
          />
        </div>
        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={saving || !locationName.trim()}
            className="btn-primary flex-1 disabled:opacity-60"
          >
            {saving ? 'Adding…' : 'Add stop'}
          </button>
          <button type="button" onClick={onClose} className="btn-outline flex-1">
            Cancel
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}
