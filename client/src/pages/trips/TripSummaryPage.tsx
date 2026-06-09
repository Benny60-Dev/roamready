import { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Breadcrumb } from '../../components/ui/Breadcrumb'
import {
  Download, Share2, Sparkles, Car, Tent, Star, Bed,
  MapPin, XCircle, Plus, Check, RefreshCw, ArrowRight, Clock,
  Pencil, Trash2, Wand2, Fuel, ChevronDown, ChevronRight, Info,
  Loader2,
} from 'lucide-react'
const ModifyTripPanel = lazy(() => import('../../components/trip/ModifyTripPanel'))
import ConfirmModal from '../../components/ui/ConfirmModal'
import { tripsApi, aiApi, usersApi } from '../../services/api'
import { Trip, Stop, ItineraryDay, ItineraryActivity, StopWeather, POI, TripFuelEstimate } from '../../types'
import { useAuthStore } from '../../store/authStore'
import { buildStopBadges, formatStopBadgeLabel, formatStopBadgeMarker, isHomeBadge, StopBadge } from '../../utils/stopBadge'
import { format, addDays } from 'date-fns'
import { parseTripDate, toYmd } from '../../utils/dates'
import { computeTripTotals } from '../../utils/tripTotals'
import { StopWeatherCard } from '../../components/weather/StopWeatherCard'
import { useScrollResetOnReady } from '../../hooks/useScrollResetOnReady'

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
  // Marks a STAY entry whose stop is a 0-night DESTINATION at the trip's home
  // city — i.e. the round-trip return-home arrival. StayContent uses this to
  // render "Arrived home in {city}" instead of the bare city label.
  isReturnHome?: boolean
  departureTime: string  // HH:MM — DRIVE / OVERNIGHT next-morning depart
  checkInTime: string    // HH:MM — STAY default 15:00, OVERNIGHT default 18:00
  checkOutTime: string   // HH:MM — STAY default 11:00
  highwayRoute?: string | null
  driveDuration?: string | null
  routeHighlights?: string | null
  routeDescription?: string | null
  terrainSummary?: string | null
  pointsOfInterest?: POI[] | null
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
  // parseTripDate normalizes ISO/date-only inputs to a Date whose local-time
  // accessors return the UTC calendar day. addDays + date-fns format() below
  // all then render the intended date regardless of viewer timezone.
  //
  // currentDate is the running fallback for any stop whose stored arrivalDate
  // is null (notably AI-added stops, which arrive with both date columns
  // null until the server's recomputeStopDates fills them in). It used to
  // be Date | undefined, which meant the fallback branch in every entry
  // pushed produced `undefined` when startDate was missing — buildGroups
  // then couldn't merge null-dated entries onto a calendar day, and the
  // stop's cards silently dropped from the rendered itinerary. Seeding
  // with `new Date()` when startDate is missing guarantees every pushed
  // entry has a real Date, so the day-grouping always has something to
  // hang it on. The server recompute is the primary fix; this is the
  // belt-and-suspenders so a future regression on the write side can't
  // make stops invisible again.
  let currentDate: Date = parseTripDate(startDate) ?? new Date()

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
        // Prefer stop.arrivalDate (cascade keeps it in sync) so DRIVE day shares
        // the same date as the STAY/OVERNIGHT entry that buildGroups merges in
        // at the bottom of the same TRAVEL_DAY card. When DRIVE.date and
        // STAY.date diverge, buildGroups' .toDateString() equality check fails
        // and the arrival entry orphans into its own card — no "Arrive {time}"
        // pill, no date in the day header. Falls back to currentDate when no
        // DB arrivalDate exists yet (matches the OVERNIGHT branch below).
        // currentDate is now guaranteed-Date (see seed at top of function),
        // so this fallback always produces a valid Date — never undefined.
        date: parseTripDate(stop.arrivalDate) ?? new Date(currentDate),
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
        date: parseTripDate(stop.arrivalDate) ?? new Date(currentDate),
        type: 'OVERNIGHT',
        stop,
        departureTime: '06:00',
        checkInTime: '18:00',
        checkOutTime: '06:00',
        activities: [],
      })
      dayNum++
      currentDate = addDays(currentDate, 1)

    // ── HOME stop — always render one STAY entry as the departure point ─────
    } else if (stop.type === 'HOME') {
      entries.push({
        dayNum,
        // Prefer stop.arrivalDate (cascade-populated) so the Day 1 header has a
        // date even when trip.startDate is null. Same fallback shape as the
        // DRIVE branch above and the OVERNIGHT branch below — keeping all
        // entries on a consistent date source preserves buildGroups' merge.
        date: parseTripDate(stop.arrivalDate) ?? new Date(currentDate),
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
      if (nights === 0) {
        // Final-destination / return-home stop. The nights >= 1 loop below
        // never fires when nights=0, which left a 0-night DESTINATION (the
        // round-trip return-home convention) with a DRIVE-in entry but no
        // arrival STAY card afterward — the timeline appeared to end mid-route.
        // Push a single STAY entry so the arrival is visible. currentDate is
        // intentionally NOT advanced since 0 nights contributes 0 days.
        const homeStop = stops.find(s => s.type === 'HOME')
        const isReturnHome =
          !!homeStop &&
          homeStop.locationName.trim().toLowerCase() ===
            stop.locationName.trim().toLowerCase()
        const entryDate = parseTripDate(stop.arrivalDate) ?? new Date(currentDate)
        entries.push({
          dayNum,
          date: entryDate,
          type: 'STAY',
          stop,
          nightNum: 1,
          isReturnHome,
          departureTime: '08:00',
          checkInTime: '15:00',
          checkOutTime: '11:00',
          activities: [],
        })
        dayNum++
      } else {
        for (let n = 0; n < nights; n++) {
          // Prefer stop.arrivalDate + offset (authoritative after a cascade save).
          // Fall back to currentDate when no DB date exists yet.
          // currentDate is guaranteed-Date now, so the fallback branch always
          // produces a Date. Previously `entryDate` could remain undefined
          // when both stored arrivalDate and currentDate were null — that's
          // the path that produced the silent-drop bug on AI-added stops.
          const parsedArrival = parseTripDate(stop.arrivalDate)
          const entryDate: Date = parsedArrival
            ? addDays(parsedArrival, n)
            : (n === 0 ? new Date(currentDate) : addDays(new Date(currentDate), n))
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
        currentDate = addDays(currentDate, nights)
      }
    }
  }

  return entries
}

// ─── Day Group ────────────────────────────────────────────────────────────────

interface DayGroup {
  type: 'TRAVEL_DAY' | 'STAY_GROUP' | 'HOME' | 'OVERNIGHT_SOLO'
  entries: TimelineEntry[]
  indices: number[]
  stopId: string | null
  stopOrder: number
}

function buildGroups(
  entries: TimelineEntry[],
  badges?: Record<string, StopBadge>,
): DayGroup[] {
  const groups: DayGroup[] = []
  let i = 0
  while (i < entries.length) {
    const e = entries[i]
    const stopId = e.stop?.id ?? null
    const stopOrder = e.stop?.order ?? 0

    if (e.stop?.type === 'HOME') {
      const next = entries[i + 1]
      if (next?.type === 'DRIVE') {
        // Merge HOME departure into the first travel day card
        const grpE: TimelineEntry[] = [e, entries[i + 1]]
        const grpI: number[] = [i, i + 1]
        i++ // consume DRIVE
        const next2 = entries[i + 1]
        if (next2 && (next2.type === 'STAY' || next2.type === 'OVERNIGHT') &&
            next2.date?.toDateString() === entries[i].date?.toDateString()) {
          i++
          grpE.push(entries[i])
          grpI.push(i)
        }
        const dest = grpE[grpE.length - 1]
        groups.push({
          type: 'TRAVEL_DAY',
          entries: grpE,
          indices: grpI,
          stopId: dest.stop?.id ?? null,
          stopOrder: dest.stop?.order ?? 0,
        })
      } else {
        groups.push({ type: 'HOME', entries: [e], indices: [i], stopId, stopOrder })
      }
    } else if (e.type === 'DRIVE') {
      const grpE: TimelineEntry[] = [e]
      const grpI: number[] = [i]
      const next = entries[i + 1]
      if (next && (next.type === 'STAY' || next.type === 'OVERNIGHT') &&
          next.date?.toDateString() === e.date?.toDateString()) {
        i++
        grpE.push(entries[i])
        grpI.push(i)
      }
      const dest = grpE[grpE.length - 1]
      groups.push({
        type: 'TRAVEL_DAY',
        entries: grpE,
        indices: grpI,
        stopId: dest.stop?.id ?? null,
        stopOrder: dest.stop?.order ?? 0,
      })
    } else if (e.type === 'ACTIVITY') {
      const grpE: TimelineEntry[] = [e]
      const grpI: number[] = [i]
      while (entries[i + 1]?.type === 'ACTIVITY' && entries[i + 1].stop?.id === stopId) {
        i++
        grpE.push(entries[i])
        grpI.push(i)
      }
      groups.push({ type: 'STAY_GROUP', entries: grpE, indices: grpI, stopId, stopOrder })
    } else if (e.type === 'OVERNIGHT') {
      groups.push({ type: 'OVERNIGHT_SOLO', entries: [e], indices: [i], stopId, stopOrder })
    } else {
      groups.push({ type: 'TRAVEL_DAY', entries: [e], indices: [i], stopId, stopOrder })
    }
    i++
  }

  // Append a closing "Finish" group when the last entry is a home stop. Return-home
  // loops type the final stop as DESTINATION (not HOME), so the standalone HOME
  // group above only fires for the departure side. The badge helper is the
  // reliable signal for "is this a home stop" — 'H' means last-stop-matches-home.
  const lastEntry = entries[entries.length - 1]
  const lastStopId = lastEntry?.stop?.id
  if (badges && lastStopId && badges[lastStopId] === 'H') {
    groups.push({
      type: 'HOME',
      entries: [lastEntry],
      indices: [entries.length - 1],
      stopId: lastStopId,
      stopOrder: lastEntry.stop?.order ?? 0,
    })
  }

  return groups
}

// ─── Merge AI content into entries ────────────────────────────────────────────

function mergeAI(entries: TimelineEntry[], aiDays: ItineraryDay[]): TimelineEntry[] {
  if (!aiDays?.length) return entries
  return entries.map((entry) => {
    const ai = aiDays.find(d =>
      d.type === entry.type && d.stopOrder === (entry.stop?.order ?? entry.prevStop?.order)
    )
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

// ─── Page ─────────────────────────────────────────────────────────────────────

// Accessibility banner predicate. A person "has accessibility needs" when at
// least one of the six AccessibilityPage flags is true, OR the free-form notes
// string is non-empty. Mirrors the exact shape AccessibilityPage writes onto
// the self person's accessibilityNeeds JSON.
const ACCESSIBILITY_FLAGS = [
  'wheelchair', 'paved_path', 'accessible_restroom',
  'near_facility', 'level_site', 'low_elevation',
] as const
function hasAccessibilityNeeds(an: any): boolean {
  if (!an || typeof an !== 'object') return false
  if (ACCESSIBILITY_FLAGS.some(k => an[k] === true)) return true
  return typeof an.notes === 'string' && an.notes.trim().length > 0
}

export default function TripSummaryPage() {
  const { user } = useAuthStore()
  const { id } = useParams<{ id: string }>()
  const [trip, setTrip] = useState<Trip | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  // Block 15 — confirmation gate for the destructive Regenerate path. The
  // POST /trips/:id/itinerary/generate controller overwrites Trip.itinerary
  // and every qualifying Stop.stayActivities, wiping checked states, custom
  // user-added activities, and curated edits. Only the "Regenerate" click on
  // an existing itinerary opens this modal — the first-time generate (no
  // itinerary yet) and the post-error Retry button skip it.
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [generatingActivities, setGeneratingActivities] = useState(false)
  const [entries, setEntries] = useState<TimelineEntry[]>([])
  const [addingActivity, setAddingActivity] = useState<Record<number, string>>({})
  // Block 15 — per-stop "add activity" draft text for the new-shape shared
  // stay-activities list. Keyed by stopId (vs. entryIdx for addingActivity
  // above) because the shared list is per-stop, not per-day.
  const [addingStayActivity, setAddingStayActivity] = useState<Record<string, string>>({})
  const [addingPOI, setAddingPOI] = useState<Record<number, string>>({})
  const [addingPOIDuration, setAddingPOIDuration] = useState<Record<number, number>>({})
  const [weatherData, setWeatherData] = useState<Record<string, StopWeather | null | undefined>>({})
  // editingStop state retired with the Edit Stop modal.
  const [pendingDeleteStop, setPendingDeleteStop] = useState<Stop | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [addAfterOrder, setAddAfterOrder] = useState<number | null>(null)
  const [mutating, setMutating] = useState(false)
  const [modifyPanelOpen, setModifyPanelOpen] = useState(false)
  // Per-leg actual-fuel editor state. Identifies which leg is currently
  // being edited by its arriving-stop `order` (leg.toOrder), so opening a
  // second editor naturally closes any prior one without bookkeeping. The
  // legacy single trip.actualFuel input was retired here — actuals now
  // live per-leg on Stop.actualFuel (Pass 1 added the column) and the
  // per-leg blend in computeTripTotals (Pass 2) drives the displayed total.
  const [editingLegToOrder, setEditingLegToOrder] = useState<number | null>(null)
  const [legInput, setLegInput] = useState('')
  const [savingLeg, setSavingLeg] = useState(false)
  // Pass-3: regional fuel-cost estimate fetched async from GET /trips/:id/fuel-estimate.
  // null = still loading / not yet attempted. Successful response sets the
  // full object (including the noEstimate flag for when no rig MPG is set);
  // we never block the page render on this fetch.
  const [fuelEstimate, setFuelEstimate] = useState<TripFuelEstimate | null>(null)
  // Per-instance collapse toggles for the two Cost-Breakdown groups —
  // Camping (per-stop site costs) and Fuel (per-leg drive costs). Both
  // default to collapsed so the breakdown card stays compact at first
  // paint; the user expands a group to drill into per-row detail (and,
  // in the Fuel group's case, log per-leg actuals via the 3-state row
  // editor — that behavior is unchanged by the group collapse).
  const [campGroupExpanded, setCampGroupExpanded] = useState(false)
  const [fuelGroupExpanded, setFuelGroupExpanded] = useState(false)
  const itinerarySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Block 15 — one debounce timer per stopId for stayActivities saves. Keyed
  // by stopId so simultaneous edits to two different stops don't clobber each
  // other's pending PUT. Mirrors the 600ms cadence of itinerarySaveTimer.
  const stopActivitySaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const activityGenAttempted = useRef(false)
  const [itineraryPending, setItineraryPending] = useState(false)
  const [itineraryError, setItineraryError] = useState(false)
  const itineraryPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (itineraryPollRef.current) {
      clearInterval(itineraryPollRef.current)
      itineraryPollRef.current = null
    }
  }, [])

  const reloadTrip = useCallback(async () => {
    if (!id) return
    const res = await tripsApi.get(id)
    const t: Trip = res.data
    setTrip(t)
    const sorted = [...(t.stops || [])].sort((a, b) => a.order - b.order)
    const raw = buildTimeline(sorted, t.startDate ?? undefined)
    setEntries(t.itinerary ? mergeAI(raw, t.itinerary) : raw)
    if (!t.itinerary) {
      setItineraryPending(true)
      setItineraryError(false)
      if (!itineraryPollRef.current) {
        const started = Date.now()
        itineraryPollRef.current = setInterval(async () => {
          if (Date.now() - started > 60_000) {
            stopPolling()
            setItineraryPending(false)
            setItineraryError(true)
            return
          }
          try {
            const poll = await tripsApi.get(id)
            if (poll.data.itinerary) {
              stopPolling()
              setItineraryPending(false)
              const pollSorted = [...(poll.data.stops || [])].sort((a: Stop, b: Stop) => a.order - b.order)
              const pollRaw = buildTimeline(pollSorted, poll.data.startDate ?? undefined)
              setTrip(poll.data)
              setEntries(mergeAI(pollRaw, poll.data.itinerary))
            }
          } catch { /* ignore */ }
        }, 3000)
      }
    } else {
      stopPolling()
      setItineraryPending(false)
    }
  }, [id, stopPolling])

  useEffect(() => {
    if (!id) return
    reloadTrip().finally(() => setLoading(false))
  }, [id])

  // Reset window scroll to the top on the loading→ready edge when the tall
  // itinerary timeline first mounts. See hooks/useScrollResetOnReady.
  useScrollResetOnReady(!loading)

  // Accessibility disclaimer banner — shown deterministically whenever the
  // user's effective party has a traveling person with accessibility needs.
  // This does NOT depend on the AI: the trip-gen prompt is JSON-only with no
  // slot for a user-facing note, so the disclaimer must come from the UI.
  // getTrip doesn't return the trip's party, so we read the default party —
  // the live source AccessibilityPage writes to, and the source the trip-scoped
  // clone (trip.party) is copied from. Non-fatal: on error the banner hides.
  const [showAccessibilityBanner, setShowAccessibilityBanner] = useState(false)
  useEffect(() => {
    let cancelled = false
    usersApi.getDefaultParty()
      .then(res => {
        const people = (res.data?.people ?? []) as any[]
        const applies = people.some(
          p => p.isTraveling !== false && hasAccessibilityNeeds(p.accessibilityNeeds),
        )
        if (!cancelled) setShowAccessibilityBanner(applies)
      })
      .catch(() => { /* non-fatal — banner stays hidden */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => () => stopPolling(), [stopPolling])

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

  // Fetch the regional fuel-cost estimate once the trip is loaded. Async,
  // non-blocking — the page renders immediately with fuelEstimate=null (the
  // Cost Breakdown shows "—" until this resolves). Errors silently log;
  // a failed fetch leaves fuelEstimate null which the UI treats the same
  // as still-loading (safer than rendering $NaN). Re-runs only when the
  // trip id changes — fuel pricing is stable within a session.
  useEffect(() => {
    if (!id || !trip?.id) return
    tripsApi.getFuelEstimate(id)
      .then(res => setFuelEstimate(res.data))
      .catch(err => {
        console.warn('[TripSummaryPage] fuel estimate fetch failed:', err?.message ?? err)
        setFuelEstimate(null)
      })
  }, [id, trip?.id])

  // Auto-generate activities when page loads (once, if any ACTIVITY rows have no activities)
  useEffect(() => {
    if (loading || !id || activityGenAttempted.current || itineraryPending) return
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
      .catch((err: any) => {
        // FEATURE_GATED 403 → paywall already opened by the central axios
        // interceptor (services/api.ts). Other errors are silently swallowed
        // — this surface auto-runs in the background on trip view, so noisy
        // toasts on transient failures would be worse than a quiet log.
        if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') {
          return
        }
        console.error('[TripSummaryPage] generateActivities failed:', err)
      })
      .finally(() => setGeneratingActivities(false))
  }, [loading, id, entries.length, itineraryPending])

  const handleGenerate = async () => {
    if (!id) return
    setGenerating(true)
    try {
      const res = await tripsApi.generateItinerary(id)
      setEntries(prev => mergeAI(prev, res.data as ItineraryDay[]))
    } catch (err: any) {
      // FEATURE_GATED 403 → paywall opened by the interceptor; just clear
      // loading via the finally below. Other errors are logged but not
      // user-surfaced here — the prior code had no catch at all and let
      // the rejection go unhandled; this preserves that silent posture
      // for non-paywall failures while preventing the unhandled noise.
      if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') {
        return
      }
      console.error('[TripSummaryPage] handleGenerate failed:', err)
    } finally {
      setGenerating(false)
    }
  }

  const hasAI = entries.some(e =>
    e.routeDescription || e.terrainSummary || (e.activities?.length && e.type === 'ACTIVITY') || e.transitNote
  )

  // Block 15 — destructive-action guard for the Regenerate button. When there's
  // an existing AI itinerary (hasAI), route the click through ConfirmModal so the
  // user sees what will be destroyed before the POST fires. First-time generate
  // (hasAI === false: nothing to lose) and the Retry button after an error (the
  // user has already opted in) call handleGenerate directly. The actual destruction
  // logic lives in handleGenerate; this just gates entry.
  const requestRegenerate = () => {
    if (hasAI) {
      setShowRegenerateConfirm(true)
    } else {
      handleGenerate()
    }
  }
  const confirmRegenerate = async () => {
    await handleGenerate()
    setShowRegenerateConfirm(false)
  }

  const handleDownloadPDF = async () => {
    console.log('Starting PDF download')
    if (!trip) return
    setDownloadingPdf(true)
    try {
      // Block 15 — entries[].stop.stayActivities is the live in-memory edit
      // target for the per-stay shared list; trip.stops[] is whatever came
      // back from the last fetch and goes stale after edits (the
      // stayActivities handlers above mutate entries[].stop, not
      // trip.stops). Merge the latest in-memory value into the stops array
      // so TripPDF reads the user's current edits, not the last server
      // payload.
      const liveStayActivities = new Map<string, Stop['stayActivities']>()
      for (const e of entries) {
        if (e.stop) liveStayActivities.set(e.stop.id, e.stop.stayActivities)
      }

      const tripWithEntries = {
        ...trip,
        stops: [...(trip.stops || [])]
          .sort((a, b) => a.order - b.order)
          .map(s => liveStayActivities.has(s.id)
            ? { ...s, stayActivities: liveStayActivities.get(s.id) ?? null }
            : s),
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

      // Dynamic import so the ~1.5MB @react-pdf/renderer chunk only loads on click.
      const [{ pdf }, { TripPDF }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('../../components/pdf/TripPDF'),
      ])
      const blob = await pdf(<TripPDF trip={tripWithEntries} mapImageBase64={mapBlobUrl} fuelEstimate={fuelEstimate} />).toBlob()
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

  // Block 15 — debounced persistence for Stop.stayActivities edits. Keyed by
  // stopId so two-stop edits don't clobber. Sends only the stayActivities
  // field through the partial-update PUT — StopUpdateSchema on the server
  // accepts it via the new field added to schemas/stop.ts. Old-path saves
  // (persistItinerary above) continue to write Trip.itinerary verbatim and
  // are NOT affected by this helper.
  const persistStopStayActivities = useCallback((stopId: string, activities: ItineraryActivity[]) => {
    if (!id) return
    const timers = stopActivitySaveTimers.current
    if (timers[stopId]) clearTimeout(timers[stopId])
    timers[stopId] = setTimeout(() => {
      tripsApi.updateStop(id, stopId, { stayActivities: activities }).catch(() => {})
      delete timers[stopId]
    }, 600)
  }, [id])

  // ── Date cascade ────────────────────────────────────────────────────────────
  // Walks every stop in order, computes correct arrivalDate / departureDate
  // from the anchor (trip.startDate if set, otherwise today), and saves each
  // one to the DB. Trip.totalNights and Trip.endDate are NOT written from the
  // client — every tripsApi.updateStop call triggers the server's
  // recomputeStopDates side-effect (server/src/controllers/trips.ts:90), which
  // walks the stops transactionally and persists the recomputed totals to the
  // Trip row. Each call site of this function follows up with reloadTrip(), so
  // the UI picks up the server-recomputed endDate / totalNights without any
  // explicit client write to the Trip row.
  // Always runs — never skipped for missing startDate.

  const cascadeAndSaveDates = useCallback(async (stops: Stop[]) => {
    if (!id) return
    const sorted = [...stops].sort((a, b) => a.order - b.order)

    // Use trip.startDate as anchor; fall back to today if trip has no start date.
    // parseTripDate normalizes ISO/date-only to a local-noon Date whose local
    // accessors return the UTC calendar day, so toYmd below writes the calendar
    // day the user sees on screen — round-tripping correctly through storage.
    const anchor = parseTripDate(trip?.startDate) ?? new Date()
    let current = new Date(anchor)

    console.log('[cascade] Starting date cascade for', sorted.length, 'stops, anchor =', toYmd(current))

    for (const s of sorted) {
      const nights = s.type === 'OVERNIGHT_ONLY' ? 1 : (s.nights || 0)
      // Write YYYY-MM-DD strings (not full ISO timestamps) so the server stores
      // the calendar day the user sees, not a timestamp whose UTC date may
      // differ from the displayed local date. Prisma's z.coerce.date() accepts
      // "YYYY-MM-DD" and produces a Date at UTC midnight — matching what the
      // AI emits and what parseTripDate normalizes on read.
      const arrivalYmd   = toYmd(current)
      const departureYmd = toYmd(addDays(current, nights))

      await tripsApi.updateStop(id, s.id, { arrivalDate: arrivalYmd, departureDate: departureYmd })
      console.log(`[cascade] Updated stop "${s.locationName}" arrivalDate to ${arrivalYmd} (${nights} night${nights !== 1 ? 's' : ''})`)

      current = addDays(current, nights)
    }
  }, [id, trip?.startDate])

  // First-time auto-cascade for trips just promoted from a session.
  // SessionPage.buildItinerary creates stops from the AI's itinerary JSON
  // without any arrival/departure dates — those used to stay null until the
  // user manually edited a stop, which caused the FINISH stop to show no
  // arrival info on first view. Detect the all-null state once on mount and
  // run cascade to fill them in. The ref guard prevents re-entry on the
  // re-fetch we trigger after cascade settles.
  const initialCascadeAttempted = useRef(false)
  useEffect(() => {
    if (!trip || initialCascadeAttempted.current) return
    const tripStops = trip.stops as Stop[] | undefined
    if (!tripStops || tripStops.length === 0) return
    const allNullArrival = tripStops.every(s => !s.arrivalDate)
    initialCascadeAttempted.current = true
    if (!allNullArrival) return
    cascadeAndSaveDates(tripStops)
      .then(() => reloadTrip())
      .catch(err => console.warn('[TripSummaryPage] auto-cascade failed:', err))
  }, [trip, cascadeAndSaveDates, reloadTrip])

  // ── Stop mutation handlers ──────────────────────────────────────────────────

  // Step 1 of the manual-delete flow: queue the stop for confirmation.
  // ConfirmModal asks first and surfaces any cascading-delete warnings
  // (e.g. confirmed booking).
  const requestDeleteStop = (stop: Stop) => {
    setDeleteError(null)
    setPendingDeleteStop(stop)
  }

  // Step 2: user clicked Confirm in the ConfirmModal. Fire the actual delete,
  // surface any server-side guard errors (HOME_STOP_PROTECTED / MIN_STOPS_VIOLATION
  // — UI guards prevent these in normal use, but the AI modify-mode path can
  // still hit them; downstream callers of this method may also reach the codepath).
  const confirmDeleteStop = async () => {
    if (!id || !trip || !pendingDeleteStop) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await tripsApi.deleteStop(id, pendingDeleteStop.id)
      // Renumber remaining stops 1…N in order
      const remaining = (trip.stops || [])
        .filter(s => s.id !== pendingDeleteStop.id)
        .sort((a, b) => a.order - b.order)
        .map((s, i) => ({ ...s, order: i + 1 }))
      await Promise.all(remaining.map(s => tripsApi.updateStop(id, s.id, { order: s.order })))
      // Recascade all dates with the updated stop list
      await cascadeAndSaveDates(remaining as Stop[])
      await reloadTrip()
      setPendingDeleteStop(null)
    } catch (err: any) {
      // Surface the structured server error message when present (errorHandler
      // emits { error, code? }) — the modal stays open so the user sees why.
      const message = err?.response?.data?.error || err?.message || 'Could not delete the stop. Please try again.'
      setDeleteError(message)
    } finally {
      setDeleting(false)
    }
  }

  // Build the ConfirmModal body, including any cascading-delete warnings the
  // user should be aware of before confirming.
  const buildDeleteConfirmMessage = (stop: Stop): string => {
    const parts = [`Remove ${stop.locationName} from your trip? This cannot be undone.`]
    if (stop.bookingStatus === 'CONFIRMED') {
      const cgName = stop.campgroundName ? ` at ${stop.campgroundName}` : ''
      parts.push(`This stop has a confirmed booking${cgName}. Deleting will remove the booking from your trip.`)
    }
    if (deleteError) parts.push(`\n${deleteError}`)
    return parts.join('\n\n')
  }

  // canDeleteStop helper retired with the Edit Stop modal. The DayCard
  // call site below computes canDelete inline (canEdit && length > 2)
  // for the row's trash icon, which is the only remaining consumer of
  // the min-stops + HOME guard logic in this file.

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

  // handleSaveEditStop retired with the Edit Stop modal. Per the audit:
  // every field the modal edited had a canonical writer elsewhere
  // (booking page for campgroundName/notes/conf, inline notes editor for
  // notes, TripMapPage's nights stepper + server's recomputeStopDates for
  // nights), and locationName edits silently desynced lat/lng/
  // driveDistanceMiles from the displayed string. The server's nights-
  // change → recomputeStopDates cascade still fires on any nights edit
  // routed through updateStop, so removing this client-side cascade
  // doesn't break the data path — it just removes the duplicate trigger.

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

  // Block 15 — handlers for the new-shape shared stayActivities list. They
  // mutate the in-memory `stop` object inside every entry that shares that
  // stopId (so all per-day timeline rows for the stay see the same updated
  // list), then debounce-persist via Stop.stayActivities. They do NOT touch
  // entry.activities or Trip.itinerary — the old per-day shape stays exactly
  // as the AI generated it, which keeps the PDF export and any other reader
  // that still walks the day-by-day arrays from regressing on new trips.
  const toggleStayActivity = (stopId: string, actIdx: number) => {
    setEntries(prev => {
      const target = prev.find(e => e.stop?.id === stopId)
      if (!target?.stop) return prev
      const current = normalizeActivities(target.stop.stayActivities as any)
      const next = current.map((a, i) => i === actIdx ? { ...a, checked: !a.checked } : a)
      persistStopStayActivities(stopId, next)
      return prev.map(e => e.stop?.id === stopId
        ? { ...e, stop: { ...e.stop!, stayActivities: next } }
        : e)
    })
  }

  const addStayActivity = (stopId: string) => {
    const name = (addingStayActivity[stopId] ?? '').trim()
    if (!name) return
    setEntries(prev => {
      const target = prev.find(e => e.stop?.id === stopId)
      if (!target?.stop) return prev
      const current = normalizeActivities(target.stop.stayActivities as any)
      const next = [...current, { name, checked: false, isCustom: true }]
      persistStopStayActivities(stopId, next)
      return prev.map(e => e.stop?.id === stopId
        ? { ...e, stop: { ...e.stop!, stayActivities: next } }
        : e)
    })
    setAddingStayActivity(prev => ({ ...prev, [stopId]: '' }))
  }

  const deleteStayActivity = (stopId: string, actIdx: number) => {
    setEntries(prev => {
      const target = prev.find(e => e.stop?.id === stopId)
      if (!target?.stop) return prev
      const current = normalizeActivities(target.stop.stayActivities as any)
      const next = current.filter((_, i) => i !== actIdx)
      persistStopStayActivities(stopId, next)
      return prev.map(e => e.stop?.id === stopId
        ? { ...e, stop: { ...e.stop!, stayActivities: next } }
        : e)
    })
  }

  const deletePOI = (entryIdx: number, poiIdx: number) => {
    setEntries(prev => {
      const next = prev.map((e, i) =>
        i !== entryIdx ? e : { ...e, pointsOfInterest: (e.pointsOfInterest ?? []).filter((_, j) => j !== poiIdx) }
      )
      persistItinerary(next)
      return next
    })
  }

  const addPOI = (entryIdx: number) => {
    const name = (addingPOI[entryIdx] || '').trim()
    if (!name) return
    const durationMinutes = addingPOIDuration[entryIdx] ?? 30
    setEntries(prev => {
      const next = prev.map((e, i) =>
        i !== entryIdx ? e : { ...e, pointsOfInterest: [...(e.pointsOfInterest ?? []), { name, durationMinutes }] }
      )
      persistItinerary(next)
      return next
    })
    setAddingPOI(prev => ({ ...prev, [entryIdx]: '' }))
    setAddingPOIDuration(prev => ({ ...prev, [entryIdx]: 30 }))
  }

  // Block 16 — append a fully-formed POI (name + duration + optional
  // description) to a drive day's pointsOfInterest. Used when adding from
  // an AI route suggestion so the description rides along onto the green
  // chip. Same persistence path as addPOI — Trip.itinerary JSON via the
  // debounced saveItinerary PUT — so arrival recompute (in DayCard, summed
  // from pointsOfInterest.durationMinutes) updates for free on next render.
  const addPOIWithDetails = (entryIdx: number, poi: POI) => {
    setEntries(prev => {
      const next = prev.map((e, i) =>
        i !== entryIdx ? e : { ...e, pointsOfInterest: [...(e.pointsOfInterest ?? []), poi] }
      )
      persistItinerary(next)
      return next
    })
  }

  // Block 16 — mutate an existing POI's durationMinutes. Used by the chip
  // duration dropdown. Persists via the same debounced saveItinerary path;
  // arrival auto-updates because DayCard recomputes poiMinutes each render.
  const updatePOIDuration = (entryIdx: number, poiIdx: number, durationMinutes: number) => {
    setEntries(prev => {
      const next = prev.map((e, i) =>
        i !== entryIdx
          ? e
          : { ...e, pointsOfInterest: (e.pointsOfInterest ?? []).map((p, j) => j === poiIdx ? { ...p, durationMinutes } : p) }
      )
      persistItinerary(next)
      return next
    })
  }

  // Open the per-leg actual-fuel editor for the leg arriving at `toOrder`.
  // Pre-fills the input from the arriving stop's current actualFuel so a
  // re-open shows the persisted value, not a stale draft. Setting
  // editingLegToOrder to a new value implicitly closes any prior open
  // editor — only one row is in edit state at a time.
  const openLegEditor = (toOrder: number, current: number | null) => {
    setEditingLegToOrder(toOrder)
    setLegInput(current != null ? String(current) : '')
  }

  // Save the per-leg actual fuel. Writes via the same updateStop PUT path
  // the booking form already uses for actualRate/actualFees (Pass 1 added
  // actualFuel to StopUpdateSchema). Optimistically updates the in-memory
  // trip.stops so computeTripTotals re-blends immediately and the header
  // + grand totals reflect the new actual without a reloadTrip().
  //
  // Empty input clears the actual (sends null) — un-logs the leg, the
  // displayed estimate replaces it on the next render. Non-numeric /
  // negative inputs silently close without persisting.
  const saveLegFuel = async (stopId: string | undefined, _toOrder: number) => {
    if (!stopId || !id || !trip) return
    const trimmed = legInput.trim()
    let value: number | null
    if (trimmed === '') {
      value = null
    } else {
      const n = Number(trimmed)
      if (!Number.isFinite(n) || n < 0) {
        setEditingLegToOrder(null)
        setLegInput('')
        return
      }
      value = n
    }
    setSavingLeg(true)
    try {
      await tripsApi.updateStop(id, stopId, { actualFuel: value })
      setTrip(t =>
        t
          ? {
              ...t,
              stops: t.stops?.map(s =>
                s.id === stopId ? { ...s, actualFuel: value } : s,
              ),
            }
          : t,
      )
      setEditingLegToOrder(null)
      setLegInput('')
    } catch (e) {
      console.error('[saveLegFuel] failed:', e)
    } finally {
      setSavingLeg(false)
    }
  }

  if (loading) return (
    <div className="flex justify-center py-20">
      <div className="w-6 h-6 border-2 border-[#1F6F8B] border-t-transparent rounded-full animate-spin" />
    </div>
  )
  if (!trip) return null

  const sortedStops = [...(trip.stops || [])].sort((a, b) => a.order - b.order)
  const stopDisplayNumbers = buildStopBadges(sortedStops, user)
  // Canonical trip totals — shared with the Cost Breakdown IIFE below and
  // the PDF / map / dashboard / share surfaces via the same helper. The
  // legacy local `totalCamp` / `grandTotal` were removed; reading them was
  // the source of the inter-surface total drift the helper was extracted
  // to fix. Fuel is passed only when fuelEstimate has loaded AND isn't a
  // noEstimate result.
  //
  // fuelPerLeg is passed alongside fuelEstimate.total so the helper can
  // blend per-leg actuals (Stop.actualFuel) with per-leg estimates for
  // the "actual so far" math. Without this, the helper would fall back
  // to the legacy trip.actualFuel single-number behavior — fine for list
  // surfaces but wrong on this page where individual legs can be logged.
  const tripTotals = computeTripTotals(trip, {
    fuelEstimate: fuelEstimate?.noEstimate ? null : (fuelEstimate?.total ?? null),
    fuelPerLeg: fuelEstimate?.noEstimate ? null : (fuelEstimate?.perLeg ?? null),
  })

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
        { label: 'Dashboard', href: '/dashboard' },
        { label: trip.name, href: `/trips/${id}/map` },
        { label: 'Full Itinerary' },
      ]} />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-medium text-gray-900">{trip.name}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{trip.startLocation} → {trip.endLocation}</p>
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap">
          <button
            onClick={() => setModifyPanelOpen(true)}
            className="btn-outline text-sm flex items-center gap-1.5"
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

      {/* Stats — single-line strip. Heading dropped (the values speak for
          themselves at strip size); padding tightened from p-3/sm:p-6 to
          py-2.5/px-4 (sm:py-3/px-5) so the card is ~1/5 its old height.
          Each cell is wrapped in a flex-1 + justify-center slot so the
          divide-x dividers fall on even quarters of the row and the four
          StatCells stay balanced regardless of label width. */}
      <div className="card-lg !py-2.5 !px-4 sm:!py-3 sm:!px-5">
        <div className="flex items-center divide-x divide-gray-200">
          <div className="flex-1 flex justify-center">
            <StatCell value={liveTotalMiles > 0 ? liveTotalMiles.toLocaleString() : (trip.totalMiles?.toLocaleString() || '–')} label="Total miles" shortLabel="miles" />
          </div>
          <div className="flex-1 flex justify-center">
            <StatCell value={String(trip.totalNights || sortedStops.reduce((s, st) => s + st.nights, 0))} label="Nights" shortLabel="nights" />
          </div>
          <div className="flex-1 flex justify-center">
            <StatCell value={String(sortedStops.length)} label="Stops" shortLabel="stops" />
          </div>
          <div className="flex-1 flex justify-center">
            <StatCell
              value={`$${Math.round(tripTotals.hasAnyActuals ? tripTotals.actualTotal : tripTotals.plannedTotal).toLocaleString()}`}
              label={tripTotals.hasAnyActuals ? 'Actual' : 'Est. total'}
              shortLabel={tripTotals.hasAnyActuals ? 'actual' : 'est.'}
            />
          </div>
        </div>
      </div>

      {/* Accessibility disclaimer — deterministic UI banner (not AI-authored).
          Renders only when the user's effective party has accessibility needs
          set; reassures that ADA/accessibility filtering is best-effort. */}
      {showAccessibilityBanner && (
        <div className="rounded-lg border border-[#1F6F8B]/20 bg-[#1F6F8B]/5 px-4 py-3 text-sm text-gray-600">
          Accessibility filtering is best-effort. RoamReady prioritizes sites that report matching accessibility features, but availability and accuracy aren't guaranteed — confirm specific accessibility/ADA details directly with each campground before booking.
        </div>
      )}

      {/* Timeline */}
      <div className="card-lg">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-medium text-gray-900">Day-by-Day Itinerary</h2>
          {/* Block 15 — destructive Regenerate path is hidden from the UI
              while we work out a safer flow. Only the first-time
              "Generate AI Itinerary" state (hasAI === false: nothing to
              lose) renders. handleGenerate, requestRegenerate,
              confirmRegenerate, and the ConfirmModal block below remain
              wired but unreachable from this surface — dropping the
              !hasAI wrapper re-enables the destructive button (with its
              confirm gate intact) in one line. The label ternary is left
              in place so that re-enable is genuinely one line. */}
          {!hasAI && (
            <button
              onClick={requestRegenerate}
              disabled={generating || itineraryPending}
              className="flex items-center gap-1.5 text-sm text-[#1F6F8B] hover:text-[#134756] disabled:opacity-50 transition-colors"
            >
              {generating ? <RefreshCw size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {generating ? 'Generating…' : hasAI ? 'Regenerate' : 'Generate AI Itinerary'}
            </button>
          )}
        </div>
        {itineraryPending && (
          <div className="flex items-center gap-2 text-xs text-[#1F6F8B] bg-[#E0F0F4] border border-[#1F6F8B]/10 rounded-lg px-3 py-2 mb-4">
            <RefreshCw size={12} className="animate-spin flex-shrink-0" />
            Building your AI itinerary in the background…
          </div>
        )}
        {itineraryError && (
          <div className="flex items-center justify-between gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
            <span>AI itinerary generation timed out.</span>
            <button
              onClick={handleGenerate}
              className="font-semibold text-[#1F6F8B] hover:underline whitespace-nowrap"
            >
              Retry
            </button>
          </div>
        )}

        <div className="space-y-3">
          {(() => {
            const dayGroups = buildGroups(entries, stopDisplayNumbers)
            const rendered: JSX.Element[] = []
            let currentDay = 1

            dayGroups.forEach((group, gi) => {
              const startDay = currentDay

              // Find DRIVE entry local index (may be 0 or 1 if HOME is 0)
              const driveLocalIdx = group.type === 'TRAVEL_DAY'
                ? group.entries.findIndex(e => e.type === 'DRIVE')
                : -1
              const driveIdx = driveLocalIdx >= 0 ? group.indices[driveLocalIdx] : -1

              // Find arrival entry (STAY or OVERNIGHT)
              const arrivalEntry = group.type === 'TRAVEL_DAY'
                ? group.entries.find(e => e.type === 'STAY' || e.type === 'OVERNIGHT')
                : undefined

              const editableStop = (() => {
                if (group.type === 'TRAVEL_DAY') return arrivalEntry?.stop?.type !== 'HOME' ? arrivalEntry?.stop : undefined
                if (group.type === 'STAY_GROUP' || group.type === 'OVERNIGHT_SOLO') return group.entries[0].stop
                return undefined
              })()
              // canEdit retired with the Edit Stop modal; only canDelete
              // survives to gate the row's trash icon.
              const canDelete = !!editableStop && sortedStops.length > 2
              const poiIdx = driveIdx >= 0 ? driveIdx : group.indices[0]

              rendered.push(
                <DayCard
                  key={`group-${gi}`}
                  group={group}
                  startDay={startDay}
                  badges={stopDisplayNumbers}
                  generatingActivities={generatingActivities}
                  itineraryPending={itineraryPending}
                  weatherData={weatherData}
                  addingActivity={addingActivity}
                  addingStayActivity={addingStayActivity}
                  onToggleStayActivity={toggleStayActivity}
                  onDeleteStayActivity={deleteStayActivity}
                  onAddingStayActivityChange={(stopId, text) => setAddingStayActivity(prev => ({ ...prev, [stopId]: text }))}
                  onAddStayActivity={addStayActivity}
                  addingPOI={addingPOI}
                  onDriveDepart={driveIdx >= 0 ? (time) => updateDriveDepart(driveIdx, time) : () => {}}
                  onToggleActivity={(li, actIdx) => toggleActivity(group.indices[li], actIdx)}
                  onDeleteActivity={(li, actIdx) => deleteActivity(group.indices[li], actIdx)}
                  onAddingActivityChange={(li, text) => setAddingActivity(prev => ({ ...prev, [group.indices[li]]: text }))}
                  onAddActivity={(li) => addActivity(group.indices[li])}
                  onDeletePOI={(poi) => deletePOI(poiIdx, poi)}
                  addingPOIDuration={addingPOIDuration}
                  onAddingPOIChange={(text) => setAddingPOI(prev => ({ ...prev, [poiIdx]: text }))}
                  onAddingPOIDurationChange={(m) => setAddingPOIDuration(prev => ({ ...prev, [poiIdx]: m }))}
                  onAddPOI={() => addPOI(poiIdx)}
                  onUpdatePOIDuration={(idx, m) => updatePOIDuration(poiIdx, idx, m)}
                  onAddSuggestion={(poi) => addPOIWithDetails(poiIdx, poi)}
                  onDelete={canDelete ? () => requestDeleteStop(editableStop!) : undefined}
                />
              )

              // Advance sequential day counter
              if (group.type === 'HOME') {
                // standalone HOME doesn't count as a travel day
              } else if (group.type === 'STAY_GROUP') {
                currentDay += group.entries.length
              } else {
                currentDay += 1
              }

              const nextGroup = dayGroups[gi + 1]
              if (nextGroup && group.stopOrder !== nextGroup.stopOrder && group.type !== 'HOME') {
                rendered.push(
                  <button
                    key={`insert-${gi}`}
                    onClick={() => setAddAfterOrder(group.stopOrder)}
                    disabled={mutating}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs text-gray-400 hover:text-[#1F6F8B] hover:bg-[#E0F0F4] rounded-lg border border-dashed border-gray-200 hover:border-[#1F6F8B]/30 transition-colors disabled:opacity-40"
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
          className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 text-sm text-[#1F6F8B] hover:bg-[#E0F0F4] rounded-lg border border-dashed border-[#1F6F8B]/20 hover:border-[#1F6F8B]/40 transition-colors disabled:opacity-40"
        >
          <Plus size={13} /> Add stop
        </button>
      </div>

      {/* ─── Cost Breakdown — Planned vs Actual (Block fuel-budget pass 3) ──
          Per-stop camp rows show actual cost when CONFIRMED+actualRate, else
          the est. The Fuel row is a single line using the EIA-priced
          estimate (with expandable per-leg detail and freshness caption).
          The bottom totals collapse to one "Estimated total" line when no
          actuals exist yet, and split into Planned / Actual-so-far the
          moment any actual lands. All money values guarded against null /
          NaN — loading fuel renders "—", never "$null". */}
      {(() => {
        // Per-stop ROW data — kept local because it drives row rendering
        // (the actual/est tag per row) rather than the trip-level totals.
        // The totals themselves come from computeTripTotals (shared with
        // the header stat-strip + every other surface) so the rows and
        // the totals can't drift even by a cent.
        const stopRows = sortedStops
          .map(stop => {
            const isBooked = stop.bookingStatus === 'CONFIRMED'
            const hasActual = isBooked && stop.actualRate != null
            const estCamp = (stop.siteRate ?? 0) * stop.nights
            const actualCamp = hasActual
              ? (stop.actualRate ?? 0) * stop.nights + (stop.actualFees ?? 0)
              : null
            const displayCamp = hasActual ? actualCamp! : estCamp
            // Skip rows with literally no cost data at all (neither est
            // nor actual). These are typically HOME stops or 0-night returns.
            if (displayCamp <= 0) return null
            return { stop, displayCamp, isActualCamp: hasActual, estCamp, actualCamp }
          })
          .filter((r): r is NonNullable<typeof r> => r !== null)

        // Trip totals — single source of truth via the shared helper.
        // Camp values match Σ over stopRows exactly (rows with displayCamp<=0
        // contribute 0 anyway, so filtering them out for display vs. summing
        // them all is mathematically identical). Per-group sums (campEst,
        // campActual, fuelEst, fuelActual) feed the collapsed group headers
        // below as their subtotal values — no new summation logic, all of
        // these are pre-computed inside computeTripTotals.
        const {
          campEst,
          campActual,
          fuelEst,
          fuelActual,
          plannedTotal,
          actualTotal,
          hasAnyActuals,
        } = tripTotals
        // Per-group "has any actuals" flags — derived from already-computed
        // row/leg state, NOT new sums. hasActualCamp asks "did any stop row
        // tagged isActualCamp survive the filter"; hasActualFuel uses the
        // helper's signal that the per-leg blend supplanted the estimate.
        const hasActualCamp = stopRows.some(r => r.isActualCamp)
        const hasActualFuel = fuelActual != null

        // Caption strings — guard against null asOf when source==='fallback'.
        const fuelCaption = (() => {
          if (!fuelEstimate || fuelEstimate.noEstimate) return null
          if (fuelEstimate.source === 'fallback') {
            return 'estimate uses fallback prices'
          }
          if (fuelEstimate.asOf) {
            try {
              const d = parseTripDate(fuelEstimate.asOf)
              if (d) return `EIA regional prices · wk of ${format(d, 'MMM d')}`
            } catch { /* fall through */ }
          }
          return 'EIA regional prices'
        })()

        // Build an order→stop-name lookup for the expanded per-leg detail.
        // Endpoints are labeled with the stop's locationName when available,
        // else fall back to "Stop {order}". Same dataset that powers the
        // per-row badge so legs feel rooted in the itinerary.
        const stopNameByOrder = new Map<number, string>()
        for (const s of sortedStops) stopNameByOrder.set(s.order, s.locationName)
        const legLabel = (order: number, fallbackState: string | null): string => {
          const name = stopNameByOrder.get(order)
          if (name) return name
          if (fallbackState) return fallbackState
          return `Stop ${order}`
        }

        // Money formatter — integer-clean when whole-dollar, 2dp otherwise.
        // Matches the formatter convention used in RateLine (Block 13) so
        // the trip-level total reads consistently with the per-card rates.
        const fmtMoney = (n: number): string =>
          Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2)

        return (
      <div className="card-lg">
        {/* Section heading — larger weight + bottom rule so it reads as
            a proper section header, not a row label. Sentence case ("Cost
            breakdown") matches the rest of the page's heading style. */}
        <h2 className="text-lg font-medium text-gray-900 pb-2 mb-4 border-b border-gray-200">
          Cost breakdown
        </h2>

        <div className="space-y-2">
          {/* ─── Camping group (collapsible) ────────────────────────────────
              Tappable header row shows the per-group SUBTOTAL on the right
              (campActual when any stop is logged actual, else campEst —
              both come from computeTripTotals; no new sums). Collapsed by
              default (campGroupExpanded=false). When expanded, the
              per-stop rows render beneath at text-sm and the same row
              chrome as the fuel-leg rows below — they read as siblings.
              A "Camping subtotal" foot row repeats the subtotal because
              the list can run 16+ rows and the header scrolls away. */}
          <div>
            <button
              type="button"
              onClick={() => setCampGroupExpanded(o => !o)}
              className="w-full flex items-center justify-between py-2 hover:bg-gray-50 rounded transition-colors text-left"
              aria-expanded={campGroupExpanded}
            >
              <div className="flex items-center gap-2 min-w-0">
                {campGroupExpanded
                  ? <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />
                  : <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />}
                <Tent size={14} className="text-[#C9851A] flex-shrink-0" />
                <span className="text-sm font-medium text-[#854F0B]">Camping</span>
                <span className="text-xs text-gray-400">
                  · {stopRows.length} {stopRows.length === 1 ? 'stop' : 'stops'}
                </span>
              </div>
              <div className="flex items-baseline gap-2 flex-shrink-0">
                <span className={`text-sm ${hasActualCamp ? 'text-[#3E5540] font-medium' : 'text-gray-700'}`}>
                  ${fmtMoney(Math.round(hasActualCamp ? campActual : campEst))}
                </span>
                <span className={`text-[10px] font-semibold uppercase tracking-wide ${hasActualCamp ? 'text-[#3E5540]' : 'text-gray-400'}`}>
                  {hasActualCamp ? 'actual' : 'est.'}
                </span>
              </div>
            </button>
            {campGroupExpanded && (
              <div>
                {stopRows.map(({ stop, displayCamp, isActualCamp }) => (
                  <div key={stop.id} className="flex items-center justify-between py-2 pl-6 border-b border-gray-50 last:border-0">
                    <div className="flex items-center gap-2">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${isHomeBadge(stopDisplayNumbers[stop.id]) ? 'bg-gray-100 text-gray-500' : 'bg-[#E0F0F4] text-[#1F6F8B]'}`}>
                        {formatStopBadgeMarker(stopDisplayNumbers[stop.id])}
                      </div>
                      <span className="text-sm text-gray-700">{stop.locationName}</span>
                    </div>
                    <div className="flex items-baseline gap-2 text-right">
                      <span className="text-sm text-gray-700">${fmtMoney(Math.round(displayCamp * 100) / 100)}</span>
                      {isActualCamp ? (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#3E5540]">actual</span>
                      ) : (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">est.</span>
                      )}
                    </div>
                  </div>
                ))}
                {/* Foot subtotal — repeats the header value so a user who's
                    scrolled past 10+ stop rows can still see what the group
                    sums to without scrolling back up. Same source values
                    (campEst/campActual) the header used. */}
                <div className="flex items-center justify-between pt-2 pl-6 border-t border-gray-100">
                  <span className="text-[13px] text-gray-500">Camping subtotal</span>
                  <div className="flex items-baseline gap-2">
                    <span className={`text-[13px] ${hasActualCamp ? 'text-[#3E5540] font-medium' : 'text-gray-500'}`}>
                      ${fmtMoney(Math.round(hasActualCamp ? campActual : campEst))}
                    </span>
                    <span className={`text-[10px] font-semibold uppercase tracking-wide ${hasActualCamp ? 'text-[#3E5540]' : 'text-gray-400'}`}>
                      {hasActualCamp ? 'actual' : 'est.'}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ─── Fuel group (collapsible, symmetric with Camping) ──────────
              Same header pattern: tappable, chevron + Fuel icon + label +
              leg count on the left, subtotal + est./actual tag on the
              right. Subtotal: fuelActual (per-leg blend, pine) if any leg
              is logged, else fuelEst (gray). When expanded, the EIA
              freshness caption sits at the top, then per-leg rows, then a
              "Fuel subtotal" foot row. Edge cases preserved verbatim:
                · No fuel estimate at all → group is non-expandable, shows
                  em-dash subtotal, no chevron.
                · noEstimate (rig missing MPG) → non-expandable, shows the
                  "Add a rig with MPG to estimate fuel" hint inline.
              All 3-state per-leg editor logic (estimate/editing/logged)
              and one-editor-at-a-time gate is unchanged below. */}
          {(() => {
            const fuelExpandable = !!(fuelEstimate && !fuelEstimate.noEstimate && fuelEstimate.perLeg.length > 0)
            const legCount = fuelExpandable ? fuelEstimate!.perLeg.length : 0
            // Subtotal value: prefer the per-leg actual blend (already
            // computed by the helper), fall back to the trip-level
            // estimate. Either may be null in degenerate states.
            const fuelSubtotal = hasActualFuel ? fuelActual : fuelEst
            const fuelHasNumber = typeof fuelSubtotal === 'number' && Number.isFinite(fuelSubtotal)
            return (
              <div>
                <button
                  type="button"
                  onClick={() => { if (fuelExpandable) setFuelGroupExpanded(o => !o) }}
                  disabled={!fuelExpandable}
                  className={`w-full flex items-center justify-between py-2 rounded transition-colors text-left ${fuelExpandable ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'}`}
                  aria-expanded={fuelExpandable ? fuelGroupExpanded : undefined}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    {fuelExpandable
                      ? (fuelGroupExpanded
                          ? <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />
                          : <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />)
                      : <span className="w-[14px] flex-shrink-0" aria-hidden="true" />}
                    <Fuel size={14} className="text-[#1F6F8B] flex-shrink-0" />
                    <span className="text-sm font-medium text-[#185FA5]">Fuel</span>
                    {legCount > 0 && (
                      <span className="text-xs text-gray-400">
                        · {legCount} {legCount === 1 ? 'leg' : 'legs'}
                      </span>
                    )}
                    {fuelEstimate?.noEstimate && (
                      <span className="text-xs italic text-gray-400">· Add a rig with MPG to estimate fuel</span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-2 flex-shrink-0">
                    {fuelHasNumber ? (
                      <>
                        <span className={`text-sm ${hasActualFuel ? 'text-[#3E5540] font-medium' : 'text-gray-700'}`}>
                          ${fmtMoney(Math.round(fuelSubtotal as number))}
                        </span>
                        <span className={`text-[10px] font-semibold uppercase tracking-wide ${hasActualFuel ? 'text-[#3E5540]' : 'text-gray-400'}`}>
                          {hasActualFuel ? 'actual' : 'est.'}
                        </span>
                      </>
                    ) : (
                      <span className="text-sm text-gray-400">—</span>
                    )}
                  </div>
                </button>
                {fuelExpandable && fuelGroupExpanded && (
                  <div>
                    {/* EIA freshness caption — top of the expanded section
                        so the prices have provenance before the legs. */}
                    {fuelCaption && (
                      <p className="text-xs text-gray-400 pl-6 pb-1">{fuelCaption}</p>
                    )}
                    {/* MPG disclosure (Pass 3 of towing-aware fuel estimate,
                        May 2026). Shows the actual divisor the server used
                        in (miles / mpgUsed) × $/gal, plus the basis tag
                        ('towing' vs 'solo') so the user knows WHICH of
                        their rig's MPG figures drove this trip's number.
                        Honest caveat about terrain & load — the estimate
                        doesn't model either, and trailers + climbs are
                        where the divergence between estimated and real
                        mileage gets ugly. Gated on a finite mpgUsed so
                        the noEstimate path (no rig MPG set) doesn't
                        render this — that path shows the "Add a rig
                        with MPG" hint inline on the group header instead.
                        mpgBasis=null falls back to no parenthetical so a
                        future code path that returns mpgUsed without a
                        basis tag (shouldn't happen today, but the type
                        allows it) still renders cleanly. */}
                    {!fuelEstimate!.noEstimate && typeof fuelEstimate!.mpgUsed === 'number' && Number.isFinite(fuelEstimate!.mpgUsed) && (
                      <p className="text-xs text-gray-400 pl-6 pb-1 flex items-center gap-1">
                        <Info size={11} className="text-gray-300 flex-shrink-0" />
                        <span>
                          Estimated at {Math.round(fuelEstimate!.mpgUsed)} MPG
                          {fuelEstimate!.mpgBasis === 'towing' ? ' (towing)' : fuelEstimate!.mpgBasis === 'solo' ? ' (solo)' : ''}
                          {' · terrain & load affect real mileage'}
                        </span>
                      </p>
                    )}
                    {/* Per-leg rows — text-sm to match the camp rows above.
                        Same row chrome (py-2 pl-6 border-b). All 3-state
                        editor logic preserved verbatim:
                          STATE A — estimate + "Log actual" affordance
                          STATE B — inline input + Save / Cancel
                          STATE C — struck estimate + pine-green actual + Edit
                        One-editor-at-a-time gated by editingLegToOrder. */}
                    {fuelEstimate!.perLeg.map((leg, i) => {
                      const arrivingStop = trip.stops?.find(s => s.order === leg.toOrder)
                      const arrivingStopId = arrivingStop?.id
                      const legActual = arrivingStop?.actualFuel
                      const isLogged =
                        typeof legActual === 'number' && Number.isFinite(legActual)
                      const isEditing = editingLegToOrder === leg.toOrder

                      return (
                        <div key={i} className="flex flex-wrap md:flex-nowrap items-center justify-between gap-2 py-2 pl-6 border-b border-gray-50 last:border-0">
                          <span className="text-sm text-gray-700 min-w-0">
                            {legLabel(leg.fromOrder, null)} → {legLabel(leg.toOrder, leg.toState)}
                            <span className="text-xs text-gray-400"> · {Math.round(leg.miles).toLocaleString()} mi</span>
                          </span>
                          <div className="flex items-center gap-1.5 flex-shrink-0 text-sm">
                            {isEditing ? (
                              <>
                                <span className="text-gray-400 line-through">${fmtMoney(Math.round(leg.cost))}</span>
                                <span className="text-gray-300">→</span>
                                <span className="text-gray-400">$</span>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min={0}
                                  step="0.01"
                                  value={legInput}
                                  onChange={e => setLegInput(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault()
                                      saveLegFuel(arrivingStopId, leg.toOrder)
                                    } else if (e.key === 'Escape') {
                                      setEditingLegToOrder(null)
                                      setLegInput('')
                                    }
                                  }}
                                  placeholder="0.00"
                                  autoFocus
                                  disabled={!arrivingStopId || savingLeg}
                                  className="text-sm border border-gray-200 rounded px-1.5 py-0.5 w-24 focus:outline-none focus:border-[#1F6F8B] bg-white"
                                />
                                <button
                                  type="button"
                                  onClick={() => saveLegFuel(arrivingStopId, leg.toOrder)}
                                  disabled={savingLeg || !arrivingStopId}
                                  className="text-xs font-semibold text-white bg-[#F7A829] hover:bg-[#C9851A] px-2 py-0.5 rounded disabled:opacity-60 transition-colors"
                                >
                                  {savingLeg ? '…' : 'Save'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingLegToOrder(null)
                                    setLegInput('')
                                  }}
                                  className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : isLogged ? (
                              <>
                                <span className="text-gray-400 line-through">${fmtMoney(Math.round(leg.cost))}</span>
                                <span className="text-[#3E5540] font-medium">${fmtMoney(Math.round(legActual as number))}</span>
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-[#3E5540]">actual</span>
                                <button
                                  type="button"
                                  onClick={() => openLegEditor(leg.toOrder, legActual as number)}
                                  className="text-xs text-[#1F6F8B] hover:text-[#134756] font-medium transition-colors"
                                >
                                  Edit
                                </button>
                              </>
                            ) : (
                              <>
                                <span className="text-gray-700">${fmtMoney(Math.round(leg.cost))}</span>
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">est.</span>
                                <button
                                  type="button"
                                  onClick={() => openLegEditor(leg.toOrder, null)}
                                  disabled={!arrivingStopId}
                                  className="text-xs text-[#1F6F8B] hover:text-[#134756] font-medium transition-colors disabled:opacity-40"
                                >
                                  + Log actual
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                    {/* Foot subtotal — when an actual exists we show BOTH
                        the blended actual AND the regional estimate so the
                        user can see the delta inline; when no actual yet,
                        just the estimate. Same fields used in the header. */}
                    <div className="flex items-center justify-between pt-2 pl-6 border-t border-gray-100">
                      <span className="text-[13px] text-gray-500">Fuel subtotal</span>
                      <div className="flex items-baseline gap-2">
                        {hasActualFuel ? (
                          <>
                            <span className="text-[13px] text-[#3E5540] font-medium">
                              ${fmtMoney(Math.round(fuelActual as number))}
                            </span>
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#3E5540]">actual</span>
                            {typeof fuelEst === 'number' && Number.isFinite(fuelEst) && (
                              <span className="text-[11px] text-gray-400">
                                · ${fmtMoney(Math.round(fuelEst))} est.
                              </span>
                            )}
                          </>
                        ) : fuelHasNumber ? (
                          <>
                            <span className="text-[13px] text-gray-500">
                              ${fmtMoney(Math.round(fuelEst as number))}
                            </span>
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">est.</span>
                          </>
                        ) : (
                          <span className="text-[13px] text-gray-400">—</span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* ─── Combined totals ───────────────────────────────────────────
              Top border separates the per-group subtotals above from the
              trip-wide totals here. Logic unchanged from the prior pass:
              Planned vs Actual-so-far split when actuals exist, single
              "Estimated total" line otherwise. Values straight from
              computeTripTotals (plannedTotal, actualTotal) — same numbers
              the header stat-strip and every other surface uses. */}
          <div className="pt-3 border-t border-gray-200">
            {hasAnyActuals ? (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Planned total</span>
                  <span className="text-gray-500">${fmtMoney(Math.round(plannedTotal))}</span>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-gray-900 font-medium">Actual so far</span>
                  <span className="text-lg font-medium text-[#3E5540]">${fmtMoney(Math.round(actualTotal))}</span>
                </div>
                <p className="text-[11px] text-gray-400 mt-1">
                  Actual so far uses your real costs where recorded, planned estimates elsewhere.
                </p>
              </>
            ) : (
              <div className="flex items-center justify-between font-medium">
                <span className="text-gray-900">Estimated total</span>
                <span className="text-[#1F6F8B]">${fmtMoney(Math.round(plannedTotal))}</span>
              </div>
            )}
          </div>

          {/* Legacy trip-level "Log actual fuel spent" input was retired in
              Pass 3 of the per-leg-fuel rework. Logging now happens per
              leg in the expanded fuel breakdown above — each leg row has
              its own "+ Log actual" affordance that writes to the
              arriving stop's actualFuel. The Trip.actualFuel column and
              type still exist as a legacy fallback that list surfaces
              (TripCard, SharedTripPage) read via computeTripTotals's
              non-perLeg path; nothing on this page writes it anymore. */}
        </div>
      </div>
        )
      })()}

      {/* Modals */}
      {pendingDeleteStop && (
        <ConfirmModal
          isOpen={true}
          title="Delete this stop?"
          message={buildDeleteConfirmMessage(pendingDeleteStop)}
          confirmLabel="Delete stop"
          cancelLabel="Keep it"
          onConfirm={confirmDeleteStop}
          onCancel={() => { if (!deleting) { setPendingDeleteStop(null); setDeleteError(null) } }}
          danger
          isConfirming={deleting}
        />
      )}
      {showRegenerateConfirm && (
        <ConfirmModal
          isOpen={true}
          title="Regenerate this itinerary?"
          message={"Regenerating will replace your current AI itinerary. Any activities you've added, checked off, or removed from your stay lists will be lost — there's no undo. Your bookings, confirmation numbers, and stop notes will be kept."}
          confirmLabel="Regenerate"
          cancelLabel="Keep my itinerary"
          onConfirm={confirmRegenerate}
          onCancel={() => { if (!generating) setShowRegenerateConfirm(false) }}
          danger
          isConfirming={generating}
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
      <Suspense fallback={null}>
        <ModifyTripPanel
          trip={trip}
          isOpen={modifyPanelOpen}
          onClose={() => setModifyPanelOpen(false)}
          onTripUpdated={async (_updated) => {
            await reloadTrip()
          }}
        />
      </Suspense>
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
      className={`text-sm font-semibold border border-gray-200 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:border-[#1F6F8B] cursor-pointer ${className ?? ''}`}
    >
      {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
    </select>
  )
}

// ─── StatCell ─────────────────────────────────────────────────────────────────

// Inline horizontal layout — value and unit on a single baseline, no stacking.
// Was a centered two-line column (text-base/sm:text-2xl number stacked over a
// text-[10px]/sm:text-xs label with mt-0.5); the Block 10 redesign collapsed
// the whole stats card into a slim strip, so the cell goes side-by-side with
// a uniform text-lg (18px) number — no breakpoint bump, so the strip stays
// the same height on mobile and desktop. The short/full label swap is
// preserved verbatim: mobile shows "miles / nights / stops / est." inline,
// desktop swaps to the full "Total miles / Nights / Stops / Est. total".
function StatCell({ value, label, shortLabel }: { value: string; label: string; shortLabel: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-lg font-medium text-[#1F6F8B]">{value}</span>
      <span className="text-xs text-gray-500">
        <span className="sm:hidden">{shortLabel}</span>
        <span className="hidden sm:inline">{label}</span>
      </span>
    </div>
  )
}

// ─── DayCard ──────────────────────────────────────────────────────────────────

interface DayCardProps {
  group: DayGroup
  startDay: number
  badges: Record<string, StopBadge>
  generatingActivities: boolean
  // Block 15 — true while the server is still building Trip.itinerary for a
  // brand-new trip (the page polls `/trips/:id` until itinerary lands). The
  // STAY_GROUP branch combines this with `generatingActivities` to drive the
  // "Finding things to do…" placeholder on multi-night stay cards. Always
  // false for old trips opened fresh (their itinerary is already populated),
  // so the placeholder never shows on them.
  itineraryPending: boolean
  weatherData: Record<string, StopWeather | null | undefined>
  addingActivity: Record<number, string>
  // Block 15 — per-stop "add activity" draft text and callbacks for the
  // new-shape shared stayActivities list. Used by the STAY_GROUP branch when
  // group.entries[0].stop.stayActivities is non-null; the old per-day callbacks
  // above continue to drive the fallback path for trips where it's null.
  addingStayActivity: Record<string, string>
  onToggleStayActivity: (stopId: string, actIdx: number) => void
  onDeleteStayActivity: (stopId: string, actIdx: number) => void
  onAddingStayActivityChange: (stopId: string, text: string) => void
  onAddStayActivity: (stopId: string) => void
  addingPOI: Record<number, string>
  addingPOIDuration: Record<number, number>
  onDriveDepart: (time: string) => void
  onToggleActivity: (entryLocalIdx: number, actIdx: number) => void
  onDeleteActivity: (entryLocalIdx: number, actIdx: number) => void
  onAddingActivityChange: (entryLocalIdx: number, text: string) => void
  onAddActivity: (entryLocalIdx: number) => void
  onDeletePOI: (poiIdx: number) => void
  onAddingPOIChange: (text: string) => void
  onAddingPOIDurationChange: (minutes: number) => void
  onAddPOI: () => void
  // Block 16 — added so an AI route suggestion can be turned into a real
  // POI (onAddSuggestion) and an existing POI's duration can be edited in
  // place (onUpdatePOIDuration). Both route through the same persistItinerary
  // path so manual and AI-sourced stops persist identically.
  onUpdatePOIDuration: (poiIdx: number, minutes: number) => void
  onAddSuggestion: (poi: POI) => void
  onEdit?: () => void
  onDelete?: () => void
}

function DayCard({
  group, startDay, badges, generatingActivities, itineraryPending, weatherData,
  addingActivity, addingPOI, addingPOIDuration,
  addingStayActivity,
  onToggleStayActivity, onDeleteStayActivity, onAddingStayActivityChange, onAddStayActivity,
  onDriveDepart,
  onToggleActivity, onDeleteActivity, onAddingActivityChange, onAddActivity,
  onDeletePOI, onAddingPOIChange, onAddingPOIDurationChange, onAddPOI,
  onUpdatePOIDuration, onAddSuggestion,
  onEdit, onDelete,
}: DayCardProps) {
  // Per-DayCard weather collapse — used by the STAY_GROUP branch's
  // "View weather for your destination" toggle. Hoisted here (not into
  // the branch) because hooks must be called unconditionally at the top
  // of the component. Each DayCard instance is per-group so this state
  // is correctly scoped to one card; the other branches simply don't
  // consume it. Mirrors the inline `weatherOpen` pattern that lives
  // inside StayContent and OvernightContent for their own collapses.
  const [weatherOpen, setWeatherOpen] = useState(false)

  const EditDeleteButtons = () => (
    <div className="flex items-center gap-1 flex-shrink-0">
      {onEdit && (
        <button onClick={onEdit} title="Edit stop" className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors rounded">
          <Pencil size={14} />
        </button>
      )}
      {onDelete && (
        <button onClick={onDelete} title="Remove stop" className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors rounded">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )

  // ── HOME standalone (no drive in/out) ───────────────────────────────────────
  // Fires for the trip's bookend home rows: the departure point (rare — only
  // when no drive immediately follows) AND the closing Finish row (appended
  // by buildGroups when the last stop is badged 'H'). Label is driven by the
  // badge: Start for 'S', Finish for 'H' / 'F'.
  if (group.type === 'HOME') {
    const entry = group.entries[0]
    const badge = entry.stop?.id ? badges[entry.stop.id] : undefined
    const label = badge !== undefined ? formatStopBadgeLabel(badge) : 'Home'
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MapPin size={13} className="text-gray-400" />
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
            <span className="text-sm text-gray-700">
              {entry.stop?.locationName}{entry.stop?.locationState ? `, ${entry.stop.locationState}` : ''}
            </span>
          </div>
        </div>
      </div>
    )
  }

  // ── TRAVEL_DAY (depart + drive + optional check-in / overnight) ─────────────
  if (group.type === 'TRAVEL_DAY') {
    const hasHome = group.entries[0].stop?.type === 'HOME'
    const homeEntry = hasHome ? group.entries[0] : undefined
    const driveEntry = hasHome ? group.entries[1] : group.entries[0]
    const arrivalEntry = hasHome
      ? (group.entries.length > 2 ? group.entries[2] : undefined)
      : (group.entries.length > 1 ? group.entries[1] : undefined)
    const driveIdx = hasHome ? group.indices[1] : group.indices[0]
    const arrivalStop = arrivalEntry?.stop
    const weather = arrivalStop ? weatherData[arrivalStop.id] : undefined
    const headerDate = (hasHome ? homeEntry?.date : driveEntry?.date)

    if (!driveEntry || driveEntry.type !== 'DRIVE') return null

    const driveHours = parseDurationToHours(driveEntry.driveDuration) ?? driveEntry.driveHours
    const poiMinutes = (driveEntry.pointsOfInterest ?? []).reduce((s, p) => s + p.durationMinutes, 0)
    const arrival = driveHours ? calcArrival(driveEntry.departureTime, driveHours + poiMinutes / 60) : null
    // From/to city strings, lifted up from DriveContent so the drive-section
    // header can consolidate icon + label + cities + duration on a single row.
    const fromName = driveEntry.prevStop
      ? `${driveEntry.prevStop.locationName}${driveEntry.prevStop.locationState ? ', ' + driveEntry.prevStop.locationState : ''}`
      : '—'
    const toName = driveEntry.stop
      ? `${driveEntry.stop.locationName}${driveEntry.stop.locationState ? ', ' + driveEntry.stop.locationState : ''}`
      : '—'

    return (
      <div className="rounded-lg border border-gray-400 overflow-hidden bg-white">
        {/* Card header — pale RV-blue tint marks this as a travel-day card,
            with a quiet "Drive day" tag on the right to match the visual
            idiom used for other section labels in this file. Header tint
            only — the card body stays white. */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#E0F0F4] border-b border-gray-400">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Day {startDay}</span>
            {headerDate && <span className="text-sm font-medium text-gray-700">{format(headerDate, 'EEE MMM d')}</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#1F6F8B]">Drive day</span>
            <EditDeleteButtons />
          </div>
        </div>

        {/* Depart row — HOME or prior stop — with inline time selector */}
        {homeEntry ? (() => {
          const homeBadge = homeEntry.stop?.id ? badges[homeEntry.stop.id] : undefined
          const departLabel = homeBadge !== undefined ? formatStopBadgeLabel(homeBadge) : 'Depart'
          return (
            <div className="px-4 py-3">
              <div className="flex items-center gap-1.5 flex-wrap">
                <MapPin size={12} className="text-[#1F6F8B]" />
                <span className="text-xs font-semibold uppercase tracking-wide text-[#1F6F8B]">{departLabel}</span>
                <span className="text-sm text-gray-700">
                  {homeEntry.stop?.locationName}{homeEntry.stop?.locationState ? `, ${homeEntry.stop.locationState}` : ''}
                </span>
                <TimePicker value={driveEntry.departureTime} onChange={onDriveDepart} />
              </div>
            </div>
          )
        })() : driveEntry.prevStop ? (
          // Mid-trip depart row — restructured to mirror the home-flavor
          // START row above: leading MapPin in RV-blue, then an uppercase
          // tracking-wide RV-blue "DEPART" label (literal "Depart" rendered
          // uppercase via the same class string the START branch uses), then
          // the city name in plain gray-700, then the TimePicker. The
          // previous "<city, bold> · Depart <time>" arrangement put the
          // label in the middle and bolded the city, which didn't line up
          // with the START and ARRIVE rows' left-aligned bold labels.
          <div className="px-4 py-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <MapPin size={12} className="text-[#1F6F8B]" />
              <span className="text-xs font-semibold uppercase tracking-wide text-[#1F6F8B]">Depart</span>
              <span className="text-sm text-gray-700">
                {driveEntry.prevStop.locationName}{driveEntry.prevStop.locationState ? `, ${driveEntry.prevStop.locationState}` : ''}
              </span>
              <TimePicker value={driveEntry.departureTime} onChange={onDriveDepart} />
            </div>
          </div>
        ) : null}

        {/* Drive section — border-t dropped so Start/Depart flows directly
            into the drive without an internal line. The card now relies on
            the tinted-header border-b (above) and a single floating divider
            (after the route block, below) to structure: header rule splits
            tinted header from body, floating rule splits "journey" (start
            + drive + route + POIs) from "arrival" (arrive + campground). */}
        <div className="px-4 py-3">
          {/* Drive header — one row: [Car] DRIVE · {from} → {to} [duration]
              Cities were lifted out of DriveContent (which used to render
              them as a separate row) so the section reads as a single
              consolidated line; DriveContent keeps the highway route line
              and the "Tell me more about this route" disclosure as-is. */}
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            <Car size={13} className="text-blue-600 flex-shrink-0" />
            <span className="text-xs font-semibold uppercase tracking-wide text-blue-600">Drive</span>
            <span className="text-xs text-gray-400">·</span>
            <span className="text-sm font-medium text-gray-700">{fromName}</span>
            <ArrowRight size={12} className="text-gray-400 flex-shrink-0" />
            <span className="text-sm font-medium text-gray-700">{toName}</span>
            {driveEntry.driveDuration && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full ml-1">
                <Clock size={10} />{driveEntry.driveDuration}
              </span>
            )}
          </div>
          <DriveContent
            entry={driveEntry}
            onDeletePOI={onDeletePOI}
            addingPOIText={addingPOI[driveIdx] ?? ''}
            addingPOIDurationVal={addingPOIDuration[driveIdx] ?? 30}
            onAddingPOIChange={onAddingPOIChange}
            onAddingPOIDurationChange={onAddingPOIDurationChange}
            onAddPOI={onAddPOI}
            onUpdatePOIDuration={onUpdatePOIDuration}
            onAddSuggestion={onAddSuggestion}
          />
        </div>

        {/* Floating mid-card divider — `mx-4` keeps a visible gap between the
            line's ends and the card border so it reads as a separator inside
            the card, not a full-width section wall. This is the ONE internal
            rule splitting the upper "journey" block from the lower "arrival"
            block; everything above and below flows together without further
            lines. */}
        <div className="mx-4 border-t border-gray-400" />

        {/* Arrive row — mirrors the Depart/Start row at the top of the card
            to bookend the drive. The inline "Arrive HH:MM" pill and the late-
            arrival warning chips used to render inside StayContent /
            OvernightContent; both moved up here so the "when you arrive" info
            lives next to "where you arrive", and the campground block below
            is just about the campground. Renders city even when `arrival` is
            null (no drive hours yet) so the row never disappears. */}
        {arrivalStop && (
          <div className="px-4 py-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <MapPin size={12} className="text-[#1F6F8B]" />
              <span className="text-xs font-semibold uppercase tracking-wide text-[#1F6F8B]">Arrive</span>
              <span className="text-sm text-gray-700">
                {arrivalStop.locationName}{arrivalStop.locationState ? `, ${arrivalStop.locationState}` : ''}
              </span>
              {arrival && (
                <>
                  <span className="text-xs text-gray-400">·</span>
                  <span className={`text-sm font-semibold ${
                    arrival.level === 'red' ? 'text-red-700'
                    : arrival.level === 'amber' ? 'text-amber-700'
                    : 'text-gray-700'}`}>
                    Arrive {arrival.timeStr}
                  </span>
                  {arrival.nextDay && <span className="text-xs text-gray-400">(+1 day)</span>}
                  {arrival.level === 'amber' && (
                    <span className="text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                      Late arrival — confirm after-hours check-in
                    </span>
                  )}
                  {arrival.level === 'red' && (
                    <span className="text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded-full">
                      Very late arrival — consider an earlier departure
                    </span>
                  )}
                </>
              )}
            </div>
            {arrival && (poiMinutes ?? 0) > 0 && (
              <div className="text-xs text-gray-400 ml-4 mt-1">Includes {poiMinutes} min for stops along the way</div>
            )}
          </div>
        )}

        {/* Check-in / Overnight section — wrappers intentionally have NO
            border-t. The ARRIVE row above already carries the only divider
            in this region (its own border-t), and ARRIVE+campground are
            meant to read as ONE visual block ("you arrived, here's where
            you're staying"). Dropping the border-t that used to sit at the
            top of these wrappers eliminates the doubled hairline that
            visually boxed ARRIVE off from its own destination content. */}
        {arrivalEntry?.type === 'STAY' && arrivalStop && (
          <div className="px-4 py-3">
            <StayContent entry={arrivalEntry} weather={weather} />
          </div>
        )}

        {arrivalEntry?.type === 'OVERNIGHT' && arrivalStop && (
          <div className="px-4 py-3">
            <OvernightContent entry={arrivalEntry} weather={weather} />
          </div>
        )}
      </div>
    )
  }

  // ── STAY_GROUP (activity days at one stop) ──────────────────────────────────
  if (group.type === 'STAY_GROUP') {
    const firstEntry = group.entries[0]
    const lastEntry = group.entries[group.entries.length - 1]
    const stop = firstEntry.stop!
    const weather = weatherData[stop.id]
    const cgInfo = getDisplayCampgroundName(stop)
    const isMulti = group.entries.length > 1
    const endDay = startDay + group.entries.length - 1

    const dayLabel = isMulti ? `Days ${startDay}–${endDay}` : `Day ${startDay}`
    const dateLabel = isMulti && firstEntry.date && lastEntry.date
      ? `${format(firstEntry.date, 'MMM d')} – ${format(lastEntry.date, 'MMM d')}`
      : firstEntry.date ? format(firstEntry.date, 'EEE MMM d') : undefined

    // Block 15 — shape detection for the activities section. New trips (and
    // any trip that's been regenerated since Step 2 shipped) carry a single
    // shared list on stop.stayActivities. Old trips have it as null and keep
    // rendering the per-day entry.activities arrays exactly as before. Both
    // hasAnyActivities and anyAdding switch source accordingly so the
    // "Rest day · No activities planned" fallback and the post-add UI behave
    // correctly under whichever shape is active.
    const sharedRawActivities = stop.stayActivities
    const usesSharedStayActivities = sharedRawActivities != null
    const sharedStayActivities = usesSharedStayActivities
      ? normalizeActivities(sharedRawActivities as any)
      : []
    const hasAnyActivities = usesSharedStayActivities
      ? sharedStayActivities.length > 0
      : group.entries.some(e => e.activities.length > 0)
    const anyAdding = usesSharedStayActivities
      ? (addingStayActivity[stop.id] ?? '') !== ''
      : group.indices.some(idx => (addingActivity[idx] ?? '') !== '')

    // Block 15 (loading state) — three render states for the activities region:
    //   (i)   loading       → itinerary still being built OR /activities/generate
    //                         is in flight AND this stop has nothing yet → show
    //                         "Finding things to do…" + shimmer rows
    //   (ii)  has content   → render the activities normally (shared list for
    //                         new-shape, per-day loop for old-shape)
    //   (iii) finished empty → both flags are false and there's nothing →
    //                         existing "Rest day · No activities planned"
    //
    // Old trips opened fresh: itineraryPending is false (their itinerary is
    // already populated when fetched) and generatingActivities is false
    // (auto-generate doesn't fire when per-day entries already carry their
    // activities). So stayActivitiesLoading evaluates to false → they go
    // through the (ii)/(iii) branches unchanged from Step 3.
    const stayActivitiesLoading =
      stop.type === 'DESTINATION' &&
      (stop.nights ?? 0) > 0 &&
      !hasAnyActivities &&
      (itineraryPending || generatingActivities)

    return (
      <div className="rounded-lg border border-gray-400 bg-white overflow-hidden">
        {/* Header — pale-gold tinted band mirrors the drive card's blue
            tinted header. Card body switched to bg-white so the tint
            reads as a distinct top band rather than disappearing into a
            full amber-50 card. Border strengthened to gray-400 to match
            the drive card. */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#FAEEDA] border-b border-gray-400">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="text-xs font-semibold text-amber-700 uppercase tracking-wide flex-shrink-0">{dayLabel}</span>
            <span className="text-sm font-medium text-gray-700 truncate">
              {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
            </span>
            {dateLabel && <span className="text-xs text-gray-400 flex-shrink-0">· {dateLabel}</span>}
          </div>
          {/* Right slot: "N-night stay" tag + edit/delete buttons, same
              shape as the drive card's "Drive day" tag + buttons pattern.
              Singular handled with explicit "1-night stay" branch. */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#854F0B]">
              {group.entries.length === 1 ? '1-night stay' : `${group.entries.length}-night stay`}
            </span>
            <EditDeleteButtons />
          </div>
        </div>

        {/* Sub-header: bold campground name with dark-gold Tent inline
            (destination icon per the Block 12 icon-language convention),
            and the weather block wrapped in the same expand/collapse
            pattern used by the drive-day card's StayContent/OvernightContent.
            "Staying at" prefix dropped — the tent + bold name already
            communicates the role, no need for the verbal frame. */}
        {(cgInfo || (stop.latitude && stop.longitude)) && (
          <div className="px-4 pt-2.5 pb-0 space-y-1.5">
            {cgInfo && (
              <div className="flex items-center gap-1.5">
                <Tent size={13} className="text-[#C9851A] flex-shrink-0" />
                <span className="text-sm font-semibold text-gray-800">{cgInfo.name}</span>
                {cgInfo.source === 'suggested' && (
                  <span className="text-xs text-gray-400">AI pick</span>
                )}
              </div>
            )}
            {/* Block 13 — rate + booked-detail line on the multi-night
                stay card. Same shared helpers as the drive-day arrival
                cards so a stop reads consistently no matter which card
                type it's seen on. */}
            <RateLine stop={stop} />
            <BookedSummary stop={stop} />
            {stop.latitude && stop.longitude && (
              <div>
                <button
                  type="button"
                  onClick={() => setWeatherOpen(o => !o)}
                  className="text-xs text-[#1F6F8B] hover:text-[#134756] font-medium transition-colors"
                >
                  {weatherOpen ? 'Hide weather ↑' : 'View weather for your destination ↓'}
                </button>
                {weatherOpen && <StopWeatherCard stop={stop} weather={weather} compact />}
              </div>
            )}
          </div>
        )}

        {/* Block 15 (loading state) — the 3-way branch described where
            stayActivitiesLoading is computed above. Loading takes precedence
            so the user never sees the "Rest day" fallback while the AI is
            still working. Both old- and new-shape rendering live unchanged
            inside the (ii)/(iii) branches below. */}
        {stayActivitiesLoading ? (
          // Block 15 (loading state, polish pass) — visually prominent "AI is
          // working" block. RV-blue brand accent (#1F6F8B) on the spinner and
          // message + a tinted bordered container so the whole region clearly
          // reads as "in progress" rather than empty space. The "Things to do
          // during your stay" header stays above the container so the card
          // doesn't visually jump when the loading state resolves into the
          // shared list. Logic is untouched — stayActivitiesLoading is the
          // same derived flag from itineraryPending + generatingActivities.
          <div className="px-4 pb-3 pt-2.5">
            <p className="text-xs font-semibold text-amber-700 mb-1.5">Things to do during your stay</p>
            <div className="rounded-lg border border-[#1F6F8B]/30 bg-[#E0F0F4]/60 px-3 py-3 space-y-2.5">
              <div className="flex items-center gap-2">
                <Loader2 size={17} className="text-[#1F6F8B] animate-spin flex-shrink-0" />
                <p className="text-sm font-medium text-[#1F6F8B] leading-snug">
                  Generating activity suggestions… this takes a moment
                </p>
              </div>
              <div className="space-y-1.5 pt-0.5" aria-hidden="true">
                {[1, 2, 3].map(n => (
                  <div key={n} className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded border border-[#1F6F8B]/20 bg-[#1F6F8B]/5 flex-shrink-0 animate-pulse" />
                    <div className={`h-3 bg-[#1F6F8B]/10 rounded animate-pulse ${n === 1 ? 'w-48' : n === 2 ? 'w-40' : 'w-44'}`} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Layover fallback — only when there's genuinely nothing AND
                nothing is in flight AND the user isn't mid-type. Identical
                trigger condition to before; loading branch above already
                covers the in-flight case. */}
            {!hasAnyActivities && !generatingActivities && !anyAdding && (
              <p className="px-4 py-2 text-xs text-amber-600 italic">Rest day · No activities planned</p>
            )}

            {/* Block 15 — activities section. New-shape (Stop.stayActivities
                non-null): render ONE consolidated "Things to do during your
                stay" list — no per-night sub-sections, no duplicate AI lists.
                Old-shape (stayActivities === null on every pre-Step-2 trip):
                fall through to the per-day rendering loop EXACTLY as it worked
                before this change. The ActivityContent component is shape-
                agnostic; only the data it's handed differs between branches. */}
            {usesSharedStayActivities ? (
              <div className="px-4 pb-3 pt-2.5">
                <p className="text-xs font-semibold text-amber-700 mb-1.5">Things to do during your stay</p>
                <ActivityContent
                  entry={{ ...firstEntry, activities: sharedStayActivities }}
                  generatingActivities={generatingActivities}
                  suppressHeader
                  onToggleActivity={(actIdx) => onToggleStayActivity(stop.id, actIdx)}
                  onDeleteActivity={(actIdx) => onDeleteStayActivity(stop.id, actIdx)}
                  addingText={addingStayActivity[stop.id] ?? ''}
                  onAddingChange={(text) => onAddingStayActivityChange(stop.id, text)}
                  onAddActivity={() => onAddStayActivity(stop.id)}
                />
              </div>
            ) : (
          <div className="px-4 pb-3 space-y-3 pt-2.5">
            {group.entries.map((entry, li) => {
              const flatIdx = group.indices[li]
              return (
                <div key={li} className={isMulti ? 'pt-2 border-t border-amber-100 first:border-0 first:pt-0' : ''}>
                  {isMulti && (
                    <p className="text-xs font-semibold text-amber-700 mb-1.5">
                      {entry.date ? format(entry.date, 'EEE, MMM d') : `Night ${entry.nightNum}`}
                    </p>
                  )}
                  <ActivityContent
                    entry={entry}
                    generatingActivities={generatingActivities}
                    suppressHeader
                    onToggleActivity={(actIdx) => onToggleActivity(li, actIdx)}
                    onDeleteActivity={(actIdx) => onDeleteActivity(li, actIdx)}
                    addingText={addingActivity[flatIdx] ?? ''}
                    onAddingChange={(text) => onAddingActivityChange(li, text)}
                    onAddActivity={() => onAddActivity(li)}
                  />
                </div>
              )
            })}
          </div>
            )}
          </>
        )}
      </div>
    )
  }

  // ── OVERNIGHT_SOLO (edge case) ──────────────────────────────────────────────
  if (group.type === 'OVERNIGHT_SOLO') {
    const entry = group.entries[0]
    const stop = entry.stop!
    const weather = weatherData[stop.id]
    return (
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Day {startDay}</span>
            {entry.date && <span className="text-sm font-medium text-gray-700">{format(entry.date, 'EEE MMM d')}</span>}
          </div>
          <EditDeleteButtons />
        </div>
        <div className="px-4 py-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Bed size={13} className="text-slate-500" />
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Overnight Stop</span>
          </div>
          <OvernightContent entry={entry} weather={weather} />
        </div>
      </div>
    )
  }

  return null
}

// ─── DriveContent ─────────────────────────────────────────────────────────────

function DriveContent({
  entry, onDeletePOI, addingPOIText, addingPOIDurationVal,
  onAddingPOIChange, onAddingPOIDurationChange, onAddPOI,
  onUpdatePOIDuration, onAddSuggestion,
}: {
  entry: TimelineEntry
  onDeletePOI: (poiIdx: number) => void
  addingPOIText: string
  addingPOIDurationVal: number
  onAddingPOIChange: (text: string) => void
  onAddingPOIDurationChange: (minutes: number) => void
  onAddPOI: () => void
  // Block 16 — wires AI route suggestions through the same persistence path
  // as a manual add (Trip.itinerary pointsOfInterest → saveItinerary PUT)
  // and lets an existing chip's duration be edited in place. Arrival
  // recomputes automatically from the summed durationMinutes inside
  // DayCard each render — see line 2094.
  onUpdatePOIDuration: (poiIdx: number, minutes: number) => void
  onAddSuggestion: (poi: POI) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [highlights, setHighlights] = useState<string | null>(entry.routeHighlights ?? null)
  const [loadingHighlights, setLoadingHighlights] = useState(false)
  const [isCustomDuration, setIsCustomDuration] = useState(false)
  // Block 16 — per-suggestion duration drafts. Keyed by visibleSuggestions
  // index; pre-fill comes from suggestDurationMinutes() below. The user
  // can override before clicking + Add, then the chosen value rides over
  // into the chip via onAddSuggestion.
  const [suggestionDurations, setSuggestionDurations] = useState<Record<number, number>>({})
  // Note: fromName/toName used to be computed here for the now-removed cities
  // row. The drive-section header in DayCard renders them inline alongside the
  // Car icon and duration chip, so DriveContent only owns the highway route
  // line, the "Tell me more about this route" disclosure, and the
  // "Stops along the way" section (added chips + manual add + suggestions).

  const handleToggle = async () => {
    const opening = !expanded
    setExpanded(opening)
    if (opening && !highlights && entry.stop) {
      setLoadingHighlights(true)
      try {
        const res = await tripsApi.generateRouteHighlights(entry.stop.tripId, entry.stop.id)
        setHighlights(res.data.routeHighlights ?? null)
      } catch (err: any) {
        // FEATURE_GATED 403 → paywall opened by the central interceptor.
        // Leave highlights null so the disclosure collapses cleanly; the
        // "Could not load…" fallback below would compete with the modal.
        if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') {
          return
        }
        setHighlights('Could not load points of interest.')
      } finally {
        setLoadingHighlights(false)
      }
    }
  }

  // Block 16 — parse the raw highlights string into structured suggestions.
  // The AI sometimes opens its reply with a markdown header line like
  //   "# Points of Interest: Las Cruces to Carlsbad"
  // which the previous renderer let leak through as the first bullet (the
  // old strip regex was /^[-•*\d.]+\s*/ — no `#` in the class). The new
  // parser strips leading markdown noise (#/-/•/*/digits/dots), drops the
  // header-style and error-string lines explicitly, then splits on the
  // first " — " / " - " / " · " / ":" separator to extract name +
  // description. Lines with no separator fall back to name-only.
  type Suggestion = { name: string; description?: string }
  const loadFailed = highlights === 'Could not load points of interest.'
  const parsedSuggestions: Suggestion[] = (() => {
    if (!highlights || loadFailed) return []
    return highlights.split('\n')
      .map<Suggestion | null>(raw => {
        const stripped = raw.replace(/^[#\-•*\d.\s]+/, '').trim()
        if (!stripped) return null
        if (/^points of interest\b/i.test(stripped)) return null
        if (/^could not load/i.test(stripped)) return null
        const m = stripped.match(/^(.+?)\s+[—–\-·:]\s+(.+)$/)
        if (m) return { name: m[1].trim(), description: m[2].trim() }
        return { name: stripped }
      })
      .filter((s): s is Suggestion => s != null)
  })()

  // Block 16 — heuristic duration default for an AI suggestion. Ordered so
  // the most specific match wins, with hike/trail/waterfall above
  // byway/scenic/drive so "scenic drive with a trail" defaults to the
  // longer time. Default 30 min keeps parity with the manual-add fallback.
  const suggestDurationMinutes = (text: string): number => {
    const t = text.toLowerCase()
    if (/(hike|trail|waterfall|loop)/.test(t)) return 120
    if (/(museum|monument|site|landmark|historic|gallery|cave|cavern|preserve)/.test(t)) return 60
    if (/(park|forest)/.test(t)) return 60
    if (/(byway|scenic|overlook|vista|drive|highway|pull-?out|lookout|viewpoint)/.test(t)) return 30
    return 30
  }

  // Block 16 — hide suggestions whose name matches an already-added POI
  // (case- and whitespace-insensitive). This is how a suggestion visually
  // "moves" from the suggestions list into the green added-stops list the
  // moment the user clicks + Add.
  const addedNames = new Set((entry.pointsOfInterest ?? []).map(p => p.name.toLowerCase().trim()))
  const visibleSuggestions = parsedSuggestions.filter(s => !addedNames.has(s.name.toLowerCase().trim()))

  // Block 16 — section header running total. Sums every added POI's
  // durationMinutes (manual + AI). Hidden when zero. Format: <60 → "Nmin",
  // exact hours → "Nh", mixed → "Xh Ymin". Mirrors DayCard line 2094 which
  // uses the same sum to push out the day's arrival time.
  const totalPOIMinutes = (entry.pointsOfInterest ?? []).reduce((s, p) => s + p.durationMinutes, 0)
  const totalText = (() => {
    if (totalPOIMinutes <= 0) return ''
    const h = Math.floor(totalPOIMinutes / 60)
    const m = totalPOIMinutes % 60
    if (h === 0) return `${m}min`
    if (m === 0) return `${h}h`
    return `${h}h ${m}min`
  })()

  // Section visibility: open when any sub-block has content. The existing
  // `addingPOIText === ' '` (single-space) trick from the empty-state CTA
  // is intentionally preserved — the CTA below sets addingPOIText to a
  // space to "open" the section without a separate isOpen flag.
  const hasAddedStops = (entry.pointsOfInterest?.length ?? 0) > 0
  const sectionVisible = hasAddedStops || addingPOIText !== '' || expanded

  // Block 16 — shared chip-side duration dropdown. Always offers the four
  // standards (15/30/60/120) plus the current value if non-standard, so a
  // custom 45-min manual add still re-renders correctly when re-edited.
  const renderChipDurationSelect = (current: number, onChange: (m: number) => void) => {
    const options = Array.from(new Set([15, 30, 60, 120, current])).sort((a, b) => a - b)
    return (
      <select
        value={String(current)}
        onChange={e => onChange(parseInt(e.target.value))}
        className="text-[11px] rounded px-1.5 py-0.5 bg-white focus:outline-none"
        style={{ color: '#2F4030', borderColor: '#9FBF8A', borderWidth: 1 }}
      >
        {options.map(m => <option key={m} value={m}>{m} min</option>)}
      </select>
    )
  }

  return (
    <div>
      {entry.highwayRoute && (
        <p className="text-xs text-gray-400 mb-1.5 ml-4">{entry.highwayRoute}</p>
      )}
      {/* Tell me more — load-on-demand trigger that also surfaces the (c)
          suggestions sub-block inside the "Stops along the way" section
          below (block 16). */}
      <button
        onClick={handleToggle}
        className="mt-2 text-xs text-[#1F6F8B] hover:text-[#134756] transition-colors font-medium"
      >
        {expanded ? 'Show less ↑' : 'Tell me more about this route ↓'}
      </button>

      {/* Block 16 — Stops along the way. Three vertical sub-blocks:
            (a) Added stops list — pale-green chips, editable duration, ×
            (b) Add-your-own field — text input + duration select + Add
            (c) Suggested along this route — visible while expanded, each
                row has a duration <select> pre-filled by the heuristic and
                a blue "+ Add" that routes through onAddSuggestion.
          Manual-added and AI-added stops are indistinguishable in (a)
          because (c)'s + Add appends the full POI object (incl. its
          optional description) into the same pointsOfInterest array. */}
      {sectionVisible && (
        <div className="mt-3 pt-2.5 border-t border-blue-100">
          <p className="text-xs font-semibold text-amber-700 mb-2 flex items-center gap-1 flex-wrap">
            <Star size={11} className="text-amber-500" />
            Stops along the way
            {totalText && (
              <span className="text-[11px] font-normal text-amber-600">
                · adds {totalText} to your drive
              </span>
            )}
          </p>

          {/* (a) Added stops — pale-green chips. Colors per spec:
                 bg #EDF3E6, border #9FBF8A, text #2F4030, secondary #5F6B57.
                 Distinct from the campground "Booked" pine-green pills. */}
          {hasAddedStops && (
            <div className="flex flex-col gap-1.5 mb-2">
              {entry.pointsOfInterest!.map((poi, i) => (
                <div
                  key={i}
                  className="rounded-md border px-2.5 py-1.5"
                  style={{ backgroundColor: '#EDF3E6', borderColor: '#9FBF8A' }}
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium" style={{ color: '#2F4030' }}>{poi.name}</p>
                      {poi.description && (
                        <p className="text-[11px] leading-snug mt-0.5" style={{ color: '#5F6B57' }}>
                          {poi.description}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {renderChipDurationSelect(poi.durationMinutes, m => onUpdatePOIDuration(i, m))}
                      <button
                        onClick={() => onDeletePOI(i)}
                        className="p-0.5 hover:bg-white/60 rounded transition-colors"
                        title="Remove stop"
                        style={{ color: '#5F6B57' }}
                      >
                        <XCircle size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* (b) Manual add — unchanged data path: pressing Enter or
                 clicking Add fires onAddPOI which addPOIs the current
                 addingPOIText with addingPOIDurationVal. */}
          <div className="flex items-center gap-1 flex-wrap">
            <input
              className="text-xs border border-gray-200 rounded px-2 py-1 flex-1 min-w-[120px] focus:outline-none focus:border-amber-400 bg-white"
              placeholder="Add a stop or attraction…"
              value={addingPOIText}
              onChange={e => onAddingPOIChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onAddPOI() }}
            />
            {isCustomDuration ? (
              <input
                type="number"
                min={1}
                className="text-xs border border-gray-200 rounded px-2 py-1 w-20 focus:outline-none focus:border-amber-400 bg-white"
                value={addingPOIDurationVal}
                placeholder="min"
                onChange={e => onAddingPOIDurationChange(Math.max(1, parseInt(e.target.value) || 1))}
              />
            ) : (
              <select
                value={[15, 30, 60, 120].includes(addingPOIDurationVal) ? String(addingPOIDurationVal) : 'custom'}
                onChange={e => {
                  if (e.target.value === 'custom') { setIsCustomDuration(true) }
                  else { onAddingPOIDurationChange(parseInt(e.target.value)) }
                }}
                className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:border-amber-400"
              >
                <option value="15">15 min</option>
                <option value="30">30 min</option>
                <option value="60">60 min</option>
                <option value="120">120 min</option>
                <option value="custom">Custom…</option>
              </select>
            )}
            <button
              onClick={onAddPOI}
              disabled={!addingPOIText.trim()}
              className="text-xs px-2.5 py-1 bg-amber-100 text-amber-700 rounded hover:bg-amber-200 transition-colors disabled:opacity-40 whitespace-nowrap"
            >
              Add
            </button>
          </div>

          {/* (c) Suggestions — visible only while expanded. Loading state
                 reuses the same shimmer style the previous expanded block
                 used; error state shows the cached "Could not load…"
                 message; "all consumed" shows a quiet hint; otherwise the
                 list renders. The + Add button routes through
                 onAddSuggestion which calls addPOIWithDetails (same
                 persistItinerary path as the manual add). */}
          {expanded && (
            <div className="mt-3 pt-2 border-t border-blue-100">
              <p className="text-[11px] font-semibold text-[#1F6F8B] mb-2">Suggested along this route</p>
              {loadingHighlights ? (
                <div className="space-y-1.5">
                  {[60, 80, 70].map((w, i) => (
                    <div key={i} className="h-4 bg-blue-100 rounded animate-pulse" style={{ width: `${w}%` }} />
                  ))}
                </div>
              ) : loadFailed ? (
                <p className="text-xs text-gray-500 italic">Could not load points of interest.</p>
              ) : visibleSuggestions.length === 0 ? (
                parsedSuggestions.length > 0 ? (
                  <p className="text-xs text-gray-400 italic">All suggestions added.</p>
                ) : null
              ) : (
                <div className="flex flex-col gap-1.5">
                  {visibleSuggestions.map((s, i) => {
                    const dur = suggestionDurations[i] ?? suggestDurationMinutes(`${s.name} ${s.description ?? ''}`)
                    return (
                      <div key={i} className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-700">{s.name}</p>
                          {s.description && (
                            <p className="text-[11px] text-gray-500 leading-snug mt-0.5">{s.description}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
                          <select
                            value={String(dur)}
                            onChange={e => setSuggestionDurations(prev => ({ ...prev, [i]: parseInt(e.target.value) }))}
                            className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:border-[#1F6F8B]"
                          >
                            <option value="15">15 min</option>
                            <option value="30">30 min</option>
                            <option value="60">60 min</option>
                            <option value="120">120 min</option>
                          </select>
                          <button
                            onClick={() => onAddSuggestion({ name: s.name, durationMinutes: dur, description: s.description })}
                            className="text-[11px] px-2 py-0.5 bg-[#E0F0F4] text-[#1F6F8B] rounded hover:bg-[#BFDBFE] transition-colors whitespace-nowrap font-medium"
                          >
                            + Add
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Empty-state CTA — preserves the existing addingPOIText = ' '
          trick to "open" the section. Per scope, no refactor to an
          isOpen flag here; this is intentional. */}
      {!sectionVisible && (
        <button
          onClick={() => onAddingPOIChange(' ')}
          className="mt-2 text-xs text-amber-600 hover:text-amber-800 transition-colors"
        >
          + Add stops along the way
        </button>
      )}
    </div>
  )
}

// ─── RateLine ─────────────────────────────────────────────────────────────────

/**
 * Estimate-vs-actual rate display. Block 13 split siteRate (pre-booking
 * estimate — from the campground's published rate or an AI guess) from
 * actualRate (what the user actually paid, recorded at booking time).
 * This helper picks the right one and renders nothing when there's
 * nothing meaningful to show — so we never produce "$null", "Est. $0",
 * or an empty "$/night". Branches:
 *   1. CONFIRMED + actualRate present → "$X/night" (no prefix)
 *   2. else if siteRate present + > 0 → "Est. $X/night"
 *   3. else → null (no row)
 * Shared by StayContent, OvernightContent, and the STAY_GROUP sub-header
 * so the est/actual logic lives in exactly one place.
 *
 * Formatting: integer rates render bare (no trailing ".00"); rates with
 * cents render with two decimals. Matches user expectation for typical
 * campground pricing.
 */
/**
 * Display-time campground-name resolver. The Stop row carries two related
 * fields:
 *   - `campgroundName`        — set only after the user confirms a booking
 *                               (TripBookingPage's save path writes it
 *                               alongside bookingStatus: 'CONFIRMED').
 *   - `campgroundCandidates`  — a string[] of AI-recommended campgrounds
 *                               populated at trip-build time; the same field
 *                               the booking flow surfaces as picks.
 *
 * Before a stop is booked, `campgroundName` is empty but candidates are
 * populated. Falling back to the first candidate here lets the itinerary's
 * arrive block render the recommendation as the visual anchor of the
 * arrival instead of dropping the row entirely. After the user books, the
 * row transitions seamlessly because the same call now returns
 * `campgroundName` (the user's confirmed pick) and the "AI pick" tag drops.
 *
 * Returns null when neither field has a usable value — render sites gate
 * on this so a stop with no candidates and no booking renders nothing
 * (no "undefined", no broken empty row).
 */
function getDisplayCampgroundName(stop: Stop): { name: string; source: 'booked' | 'suggested' } | null {
  if (stop.campgroundName?.trim()) {
    return { name: stop.campgroundName.trim(), source: 'booked' }
  }
  if (Array.isArray(stop.campgroundCandidates) && stop.campgroundCandidates.length > 0) {
    const first = stop.campgroundCandidates[0]
    if (typeof first === 'string' && first.trim()) {
      return { name: first.trim(), source: 'suggested' }
    }
  }
  return null
}

function RateLine({ stop }: { stop: Stop }) {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))
  const isBooked = stop.bookingStatus === 'CONFIRMED'
  if (isBooked && stop.actualRate != null) {
    return <div className="text-xs text-gray-400 ml-4">${fmt(stop.actualRate)}/night</div>
  }
  if (stop.siteRate != null && stop.siteRate > 0) {
    return <div className="text-xs text-gray-400 ml-4">Est. ${fmt(stop.siteRate)}/night</div>
  }
  return null
}

// ─── BookedSummary ────────────────────────────────────────────────────────────

/**
 * Booked-stop detail line — only renders when bookingStatus === CONFIRMED
 * AND at least one piece of detail is available. Composes a compact
 * "<nights> nights · Site <site#> · $<total> total" line; any segment
 * with no data is dropped, so a stop with no site number simply omits
 * the "Site X" middle piece. Total prefers actualRate, falls back to
 * siteRate if the user hasn't recorded an actual yet, and adds
 * actualFees on top. Suppressed entirely when no rate is available so
 * we never render "$0 total". "(incl. fees)" appended only when fees > 0
 * so the line stays short for the common no-fees case.
 *
 * Shared by StayContent, OvernightContent, and STAY_GROUP — same helper
 * everywhere keeps the math + null guards in one place.
 */
function BookedSummary({ stop }: { stop: Stop }) {
  if (stop.bookingStatus !== 'CONFIRMED') return null
  const ratePerNight = stop.actualRate ?? stop.siteRate ?? 0
  const fees = stop.actualFees ?? 0
  const total = ratePerNight * stop.nights + fees
  const parts: string[] = []
  if (stop.nights > 0) {
    parts.push(`${stop.nights} night${stop.nights === 1 ? '' : 's'}`)
  }
  if (stop.siteNumber) {
    parts.push(`Site ${stop.siteNumber}`)
  }
  if (ratePerNight > 0 && total > 0) {
    const totalDisplay = Number.isInteger(total) ? total.toLocaleString() : total.toFixed(2)
    parts.push(fees > 0 ? `$${totalDisplay} total (incl. fees)` : `$${totalDisplay} total`)
  }
  if (parts.length === 0) return null
  return <div className="text-xs text-gray-500 ml-4">{parts.join(' · ')}</div>
}

// ─── StayContent ──────────────────────────────────────────────────────────────

// `arrival` / `poiMinutes` props removed in Block 11 pass 1 — the inline
// arrival pill they fed moved up to DayCard's new ARRIVE row. Re-add if a
// future variant needs the time inline here.
function StayContent({ entry, weather }: {
  entry: TimelineEntry
  weather?: StopWeather | null
}) {
  const stop = entry.stop!
  const navigate = useNavigate()
  // Pre-booking → AI candidate, post-booking → confirmed name. Source flag
  // drives the inline "AI pick" tag rendered next to the name below.
  const cgInfo = getDisplayCampgroundName(stop)

  const [notesOpen, setNotesOpen] = useState(false)
  const [notesText, setNotesText] = useState(stop.notes ?? '')
  const [savedNotes, setSavedNotes] = useState(stop.notes ?? '')
  const [savingNotes, setSavingNotes] = useState(false)
  const [saveConfirm, setSaveConfirm] = useState(false)
  // Weather is collapsed by default — most users glance at the itinerary
  // without needing the forecast inline. Per-instance state so each
  // arrival card opens independently (DayCard renders one StayContent
  // per drive-day, each with its own collapse).
  const [weatherOpen, setWeatherOpen] = useState(false)

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
      {/* Location + campground name. The inline "· Arrive HH:MM" pill and
          its late-arrival warning chips moved up to the new ARRIVE row in
          DayCard, so this block now just covers the destination identity:
          city + (optionally) campground name. `arrival` and `poiMinutes`
          are still in the prop signature so the call site doesn't change;
          they're intentionally unused here. */}
      <div className="space-y-0.5">
        {/* City/location header — for NORMAL arrivals this line duplicated
            the city already shown in the ARRIVE row above, so it's been
            dropped. The return-home variant is preserved: "Arrived home
            in …" isn't a redundant city, it's a special-case message the
            ARRIVE row doesn't carry, so we keep that branch and only that
            branch. Normal arrivals now lead with the campground name (the
            bold + gold-tent line just below). */}
        {entry.isReturnHome && (
          <div className="text-sm font-semibold text-gray-800">
            Arrived home in {stop.locationName}{stop.locationState ? `, ${stop.locationState}` : ''}
          </div>
        )}
        {/* Campground name — promoted to bold dark-gray with a dark-gold
            Tent icon inline. The tent mirrors OvernightContent's purple-
            moon-beside-bold-name treatment but in a stay-flavored palette:
            multi-night STAY arrival = gold tent + bold name, OVERNIGHT
            arrival = purple moon + bold name. The section-level Tent icon
            at the top of StayContent (next to the city) is intentionally
            left in place — Block 12's territory still owns that header.
            Block 12 will revisit if the two tents read as redundant. */}
        {cgInfo && (
          <div className="flex items-center gap-1.5 ml-4">
            <Tent size={13} className="text-[#C9851A] flex-shrink-0" />
            <span className="text-sm font-semibold text-gray-800">{cgInfo.name}</span>
            {cgInfo.source === 'suggested' && (
              <span className="text-xs text-gray-400">AI pick</span>
            )}
          </div>
        )}
        {/* Block 13 — estimate-vs-actual rate + booked-detail line.
            Shared with OvernightContent + STAY_GROUP via the helpers
            above. Both render nothing when there's no data, so a
            rate-less / unbooked stop adds zero visual rows here. */}
        <RateLine stop={stop} />
        <BookedSummary stop={stop} />
      </div>

      {/* Book this stop! / Confirmed — not shown for HOME stops.
          Block 13: the booked pill is now a static informational chip
          (pine #3E5540 on a light pine tint, per the locked palette) and
          the edit affordance is an explicit "Edit booking" RV-blue text
          link beside it — replaces the prior implicit pattern where the
          whole sage pill was a Link. Two confirmationNum branches
          collapsed into one (label-only difference) since they were
          byte-identical apart from the trailing "#..." text. */}
      {stop.type !== 'HOME' && (stop.bookingStatus === 'CONFIRMED' ? (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#3E5540] bg-[#3E5540]/10 px-2.5 py-1 rounded-full w-fit">
            <Check size={11} />
            {stop.confirmationNum ? `Confirmed · #${stop.confirmationNum}` : 'Booked'}
          </div>
          <Link
            to={`/trips/${stop.tripId}/booking?stopId=${stop.id}`}
            className="text-xs text-[#1F6F8B] hover:text-[#134756] font-medium transition-colors"
          >
            Edit booking
          </Link>
        </div>
      ) : (
        <button
          onClick={() => navigate(`/trips/${stop.tripId}/booking?stopId=${stop.id}`)}
          className="flex items-center gap-1.5 text-xs font-semibold text-[#F7A829] border border-[#F7A829] hover:bg-[#F7A829]/10 px-3 py-1.5 rounded-lg transition-colors"
        >
          Let's book it! →
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
              className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-2 focus:outline-none focus:border-[#1F6F8B] resize-none bg-white"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveNotes}
                disabled={savingNotes}
                className="text-xs font-semibold text-white bg-[#F7A829] hover:bg-[#C9851A] px-3 py-1 rounded-lg disabled:opacity-60 transition-colors"
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
              <span className="text-xs text-[#0F766E] font-medium">Saved ✓</span>
            )}
          </div>
        )}
      </div>

      {/* Weather — collapsed by default behind a small RV-blue link; only
          renders the link when coords exist so there's no dead affordance
          on coord-less stops. StopWeatherCard's internals are untouched —
          we just toggle whether it mounts at the call site. */}
      {stop.latitude && stop.longitude && (
        <div>
          <button
            type="button"
            onClick={() => setWeatherOpen(o => !o)}
            className="text-xs text-[#1F6F8B] hover:text-[#134756] font-medium transition-colors"
          >
            {weatherOpen ? 'Hide weather ↑' : 'View weather for your destination ↓'}
          </button>
          {weatherOpen && <StopWeatherCard stop={stop} weather={weather} compact />}
        </div>
      )}
    </div>
  )
}

// ─── ActivityContent ──────────────────────────────────────────────────────────

function ActivityContent({ entry, generatingActivities, suppressHeader, onToggleActivity, onDeleteActivity, addingText, onAddingChange, onAddActivity }: {
  entry: TimelineEntry
  generatingActivities: boolean
  suppressHeader?: boolean
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
      {!suppressHeader && (
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
      )}

      {/* Activities list — polish pass: clearly visible square checkbox (RV-blue
          when checked) + always-visible trash icon for delete (gray default →
          red on hover with light red bg). The toggle/delete *behavior* is
          unchanged; onToggleActivity / onDeleteActivity wire to the same Step 3
          handlers (per-day for old-shape trips, shared for new-shape trips). */}
      {entry.activities.length > 0 ? (
        <ul className="space-y-1.5">
          {entry.activities.map((act, i) => (
            <li key={i} className="flex items-start gap-2">
              <button
                onClick={() => onToggleActivity(i)}
                // Inline borderRadius is belt-and-suspenders: it wins over any
                // class-based or global rule that might later try to round this
                // button to a circle. Confirmed via audit that no current CSS
                // is fighting Tailwind's `rounded-[4px]` (the only border-radius
                // rules in client/src CSS files are scoped to .card/.btn-*/.input/
                // .badge and never applied here) — the inline style is purely a
                // future-proof guarantee against a perfect-square-with-soft-corners
                // never silently becoming a circle again.
                style={{ borderRadius: '4px' }}
                className={`mt-0.5 w-[18px] h-[18px] rounded-[4px] flex-shrink-0 flex items-center justify-center border-[1.5px] transition-colors ${
                  act.checked
                    ? 'bg-[#1F6F8B] border-[#1F6F8B] text-white'
                    : 'border-gray-400 bg-white hover:border-[#1F6F8B]/60'
                }`}
                aria-label={act.checked ? 'Mark activity not done' : 'Mark activity done'}
              >
                {act.checked && <Check size={12} strokeWidth={3} />}
              </button>
              <span className={`flex-1 text-sm leading-snug ${act.checked ? 'line-through text-gray-500' : 'text-gray-700'}`}>
                {act.name}
              </span>
              {/* Delete — always visible (no hover-reveal). Default mid-gray so
                  the affordance reads at a glance; hover turns to the same
                  red-600 on red-50 treatment used by the page-level edit/delete
                  buttons above (DayCard EditDeleteButtons), so deletion across
                  the page has one consistent visual language. */}
              <button
                onClick={() => onDeleteActivity(i)}
                className="flex-shrink-0 mt-0.5 p-1 rounded text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                aria-label="Remove activity"
              >
                <Trash2 size={14} />
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

// Same prop-shape trim as StayContent above — the arrival pill and POI hint
// moved up to DayCard's ARRIVE row in the TRAVEL_DAY branch. OVERNIGHT_SOLO
// (DayCard line ~1568) never passed these props in the first place, so
// dropping them from the signature has no behavioral effect there.
function OvernightContent({ entry, weather }: {
  entry: TimelineEntry
  weather?: StopWeather | null
}) {
  const stop = entry.stop!
  const navigate = useNavigate()
  // Pre-booking → AI candidate, post-booking → confirmed name. Source flag
  // drives the inline "AI pick" tag rendered next to the name below.
  const cgInfo = getDisplayCampgroundName(stop)
  // Per-instance collapse for the weather block — same pattern as StayContent.
  // OvernightContent is shared with the OVERNIGHT_SOLO card (DayCard ~line
  // 1568); the collapse behavior intentionally applies there too for
  // consistent overnight styling.
  const [weatherOpen, setWeatherOpen] = useState(false)
  return (
    <div className="space-y-2">
      {/* Location + campground name. The inline arrival pill + late-arrival
          warning chips + "Includes X min" hint moved up to the new ARRIVE
          row in DayCard's TRAVEL_DAY branch (Block 11 pass 1). For the
          OVERNIGHT_SOLO call site (DayCard line ~1568) `arrival` and
          `poiMinutes` were never passed, so this block was already a no-op
          there — the removal is purely dead-code cleanup for that path. */}
      <div className="space-y-0.5">
        {/* City/location header removed — the ARRIVE row above already
            shows the destination city, and the campground line below (with
            its slate Bed waypoint marker) is the section's primary
            identity. No return-home variant for OVERNIGHT, so no
            conditional branch needs to survive (StayContent keeps an
            isReturnHome-only variant for "Arrived home in …"). */}
        {/* Campground name — promoted to a bold dark-gray line with the Bed
            icon (waypoint marker per the Block 12 icon-language convention)
            inline immediately before it. The earlier purple Moon was retired
            in Block 12; tent = destination (multi-night), bed = waypoint
            (single-night pass-through), label rows = MapPin. */}
        {cgInfo && (
          <div className="flex items-center gap-1.5 ml-4">
            <Bed size={13} className="text-slate-500 flex-shrink-0" />
            <span className="text-sm font-semibold text-gray-800">{cgInfo.name}</span>
            {cgInfo.source === 'suggested' && (
              <span className="text-xs text-gray-400">AI pick</span>
            )}
          </div>
        )}
        {/* Rate + booked-detail summary — both via shared helpers so the
            est/actual logic lives in exactly one place. RateLine handles
            the Block 13 prefix toggle ("Est." before booking, no prefix
            after, hidden when there's nothing to show); BookedSummary
            adds "nights · Site # · $total" only when CONFIRMED. */}
        <RateLine stop={stop} />
        <BookedSummary stop={stop} />
      </div>

      {/* Block 13 — same booked-pill + Edit-booking pattern as StayContent.
          OvernightContent has no HOME guard since OVERNIGHT entries are
          never HOME-typed. */}
      {stop.bookingStatus === 'CONFIRMED' ? (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#3E5540] bg-[#3E5540]/10 px-2.5 py-1 rounded-full w-fit">
            <Check size={11} />
            {stop.confirmationNum ? `Confirmed · #${stop.confirmationNum}` : 'Booked'}
          </div>
          <Link
            to={`/trips/${stop.tripId}/booking?stopId=${stop.id}`}
            className="text-xs text-[#1F6F8B] hover:text-[#134756] font-medium transition-colors"
          >
            Edit booking
          </Link>
        </div>
      ) : (
        <button
          onClick={() => navigate(`/trips/${stop.tripId}/booking?stopId=${stop.id}`)}
          className="flex items-center gap-1.5 text-xs font-semibold text-[#F7A829] border border-[#F7A829] hover:bg-[#F7A829]/10 px-3 py-1.5 rounded-lg transition-colors"
        >
          Let's book it! →
        </button>
      )}

      {/* Weather — same collapse pattern as StayContent. Renders only when
          coords exist; StopWeatherCard internals are untouched, just gated
          at the call site. */}
      {stop.latitude && stop.longitude && (
        <div>
          <button
            type="button"
            onClick={() => setWeatherOpen(o => !o)}
            className="text-xs text-[#1F6F8B] hover:text-[#134756] font-medium transition-colors"
          >
            {weatherOpen ? 'Hide weather ↑' : 'View weather for your destination ↓'}
          </button>
          {weatherOpen && <StopWeatherCard stop={stop} weather={weather} compact />}
        </div>
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

// EditStopModal retired — see commit retiring the modal across both this
// page and TripMapPage. The component file at
// client/src/components/trip/EditStopModal.tsx is deleted.

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
    } catch (err: any) {
      // FEATURE_GATED 403 → paywall already opened by the central interceptor.
      // Skip the inline "Could not load suggestions" so the suggestion list
      // stays empty rather than competing with the modal narration.
      if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') {
        return
      }
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
          className="flex items-center gap-1.5 text-xs text-[#1F6F8B] hover:text-[#134756] font-medium disabled:opacity-50 transition-colors"
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
                    ? 'border-[#1F6F8B] bg-[#E0F0F4] text-[#1F6F8B] font-medium'
                    : 'border-gray-200 bg-gray-50 text-gray-700 hover:border-[#1F6F8B] hover:bg-[#E0F0F4]'
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
