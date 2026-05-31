import {
  Document, Page, View, Text, StyleSheet, Image,
} from '@react-pdf/renderer'
import { Trip, Stop, ItineraryDay, ItineraryActivity, POI, TripFuelEstimate } from '../../types/index'
import { format, addDays } from 'date-fns'
import { parseTripDate } from '../../utils/dates'
import { computeTripTotals } from '../../utils/tripTotals'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TimelineEntry {
  dayNum: number
  date?: Date
  type: 'DRIVE' | 'STAY' | 'ACTIVITY' | 'OVERNIGHT'
  stop?: Stop
  prevStop?: Stop
  miles?: number
  driveHours?: number
  nightNum?: number
  departureTime: string
  checkInTime: string
  checkOutTime: string
  highwayRoute?: string | null
  routeDescription?: string | null
  terrainSummary?: string | null
  pointsOfInterest?: POI[] | null
  activities: ItineraryActivity[]
  transitNote?: string | null
  // Option A — consolidated multi-night stay. When a DESTINATION stop carries a
  // shared stayActivities list, its per-night STAY + ACTIVITY entries are
  // collapsed into ONE entry (see collapseSharedStays) that spans the whole
  // stay, mirroring the web's STAY_GROUP card. endDate/endDayNum carry the last
  // night so the header can render a "Day 5–11 · Jun 3 – Jun 9" range.
  consolidatedStay?: boolean
  endDate?: Date
  endDayNum?: number
  // Post-arrival night count for a consolidated card (= number of ACTIVITY
  // entries absorbed). Drives the "N-NIGHT STAY" tag so it matches the web's
  // STAY_GROUP, which excludes the arrival night folded into the travel day.
  consolidatedNights?: number
  // Marks the arrival (n=0) STAY of a shared multi-night stop. Its card shows
  // the booking info grid but NOT the shared activity list — the list renders
  // on the separate consolidated card (mirrors the web's travel-day split).
  arrivalCheckIn?: boolean
}

// ─── Colors / constants ───────────────────────────────────────────────────────

const GREEN  = '#1F6F8B'
const GREEN_L = '#E0F0F4'
const BLUE_L  = '#E0F0F4'
const AMBER_L = '#FFFBEB'
const PURP_L  = '#F5F3FF'
const GRAY_9  = '#111827'
const GRAY_7  = '#374151'
const GRAY_5  = '#6B7280'
const GRAY_1  = '#F9FAFB'
const WHITE   = '#FFFFFF'

// Amber/gold tokens — mirror the web's multi-night STAY_GROUP card
// (TripSummaryPage.tsx): gold header band, gray-400 border, amber-700 labels,
// #854F0B night tag. Tailwind's numbered amber/gray scale is stock here (the
// project's tailwind.config only overrides the DEFAULT shade), so these are the
// literal Tailwind values the web classes resolve to.
const AMBER_HEADER = '#FAEEDA'  // header band background  (web: bg-[#FAEEDA])
const AMBER_700    = '#B45309'  // day label + activity title (web: text-amber-700)
const AMBER_TAG    = '#854F0B'  // "N-NIGHT STAY" tag text  (web: text-[#854F0B])
const GRAY_400     = '#9CA3AF'  // card + header-band border (web: border-gray-400)

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: GRAY_7,
    backgroundColor: WHITE,
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 40,
  },

  // Header — two-row stacked layout so a long title can't collide with the
  // logo or overflow the right margin.
  // Row 1: logo block (icon + wordmark) — left-aligned, no right partner.
  // Row 2: trip title (full-width, wrappable) + subtitle line beneath it.
  coverHeader:  { marginBottom: 14 },
  logoRow:      { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  logoBox:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  logoImg:      { width: 36, height: 36, objectFit: 'contain' },
  brandName:    { fontSize: 13, fontFamily: 'Helvetica-Bold', color: GRAY_9 },
  brandTag:     { fontSize: 7.5, color: GRAY_5, marginTop: 1 },
  tripNameRow:  { flexDirection: 'column' },
  tripName:     { fontSize: 17, fontFamily: 'Helvetica-Bold', color: GRAY_9, lineHeight: 1.25 },
  tripSub:      { fontSize: 9, color: GRAY_5, marginTop: 3 },
  // Legacy — kept so the itinerary page's existing style refs compile
  headerRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  headerRight:  { textAlign: 'right' },
  divider: { height: 1, backgroundColor: GREEN, marginBottom: 16, opacity: 0.3 },

  // Stats
  statsCard: { backgroundColor: GREEN_L, borderRadius: 8, padding: 14, marginBottom: 16 },
  statsTitle: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: GRAY_9, marginBottom: 10 },
  statsGrid: { flexDirection: 'row', gap: 0 },
  statCell: { flex: 1, alignItems: 'center' },
  statVal: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: GREEN },
  statLabel: { fontSize: 7, color: GRAY_5, marginTop: 2, textAlign: 'center' },
  statDivider: { width: 1, backgroundColor: GREEN, opacity: 0.2 },

  // Section heading
  sectionTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: GRAY_9, marginBottom: 10 },

  // Entry cards
  entry: { borderRadius: 6, marginBottom: 8, overflow: 'hidden' },
  entryHeader: { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 6 },
  dayBadge: { width: 22, height: 22, borderRadius: 11, justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
  // Pill variant for a consolidated stay's day range ("5–11") — circle is too
  // narrow for two numbers, so widen with horizontal padding and a min width.
  dayBadgeWide: { minWidth: 22, height: 22, borderRadius: 11, justifyContent: 'center', alignItems: 'center', flexShrink: 0, paddingHorizontal: 5 },
  dayBadgeText: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: WHITE },
  typeBadge: { borderRadius: 3, paddingHorizontal: 5, paddingVertical: 2 },
  typeBadgeText: { fontSize: 7, fontFamily: 'Helvetica-Bold' },
  entryDateText: { fontSize: 8, color: GRAY_5, marginLeft: 'auto' },
  entryBody: { paddingHorizontal: 10, paddingBottom: 10, paddingTop: 2 },

  // Drive row
  driveCard: { backgroundColor: BLUE_L, borderWidth: 1, borderColor: '#BFDBFE', borderRadius: 6 },
  driveRoute: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#1D4ED8', marginBottom: 3 },
  driveMeta: { flexDirection: 'row', gap: 12, marginBottom: 4 },
  driveMetaText: { fontSize: 8, color: '#1D4ED8' },
  routeDesc: { fontSize: 8, color: GRAY_7, lineHeight: 1.4 },

  // Stay/Activity/Overnight row
  stayCard: { backgroundColor: GREEN_L, borderWidth: 1, borderColor: '#BFDBFE', borderRadius: 6 },
  actCard: { backgroundColor: AMBER_L, borderWidth: 1, borderColor: '#FDE68A', borderRadius: 6 },
  ovCard: { backgroundColor: PURP_L, borderWidth: 1, borderColor: '#DDD6FE', borderRadius: 6 },
  // Consolidated multi-night stay — white body + gold header band + gray-400
  // border, matching the web's STAY_GROUP card. The gold band comes from
  // entryHeaderAmber applied to the header View; the body inherits this white.
  stayCardAmber: { backgroundColor: WHITE, borderWidth: 1, borderColor: GRAY_400, borderRadius: 6 },
  entryHeaderAmber: { backgroundColor: AMBER_HEADER, borderBottomWidth: 1, borderBottomColor: GRAY_400 },

  locationName: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: GRAY_9, marginBottom: 2 },
  campName: { fontSize: 9, color: GRAY_7, marginBottom: 6 },

  // Info grid
  infoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  infoCell: { flexDirection: 'row', gap: 3, alignItems: 'center', minWidth: '30%' },
  infoLabel: { fontSize: 7, color: GRAY_5, textTransform: 'uppercase', letterSpacing: 0.3 },
  infoVal: { fontSize: 8, color: GRAY_9 },

  // Confirmation
  confirmBox: { backgroundColor: '#D1FAE5', borderRadius: 4, padding: 5, marginBottom: 6, flexDirection: 'row', gap: 4, alignItems: 'center' },
  confirmLabel: { fontSize: 7, color: '#065F46', fontFamily: 'Helvetica-Bold' },
  confirmVal: { fontSize: 8, color: '#065F46' },

  // Notes
  notesBox: { backgroundColor: GRAY_1, borderRadius: 4, padding: 6, marginTop: 4 },
  notesText: { fontSize: 8, color: GRAY_7, lineHeight: 1.4 },

  // Activities
  actTitle: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: GRAY_7, marginTop: 6, marginBottom: 3 },
  actItem: { flexDirection: 'row', gap: 4, alignItems: 'center', marginBottom: 2 },
  actDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: GREEN, marginTop: 1 },
  actText: { fontSize: 8, color: GRAY_7 },

  // Cost breakdown — per-stop camping rows + per-leg fuel rows + subtotals +
  // grand total. Mirrors the web Cost breakdown (TripSummaryPage.tsx); values
  // come from the SAME computeTripTotals helper + per-stop/per-leg math.
  costGroupLabel:   { fontSize: 9, fontFamily: 'Helvetica-Bold', color: GRAY_9, marginTop: 8, marginBottom: 2 },
  costRow:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 3, paddingLeft: 10, borderBottomWidth: 0.5, borderBottomColor: '#F3F4F6' },
  costRowLabel:     { fontSize: 8.5, color: GRAY_7 },
  costRowSub:       { fontSize: 7.5, color: GRAY_5 },
  costRowVal:       { fontSize: 8.5, color: GRAY_7 },
  costSubtotalRow:  { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 3, paddingLeft: 10, borderTopWidth: 0.5, borderTopColor: '#E5E7EB' },
  costSubtotalLabel:{ fontSize: 8.5, color: GRAY_5 },
  costSubtotalVal:  { fontSize: 8.5, color: GRAY_7 },
  costTotalRow:     { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6, marginTop: 6, borderTopWidth: 1, borderTopColor: '#D1D5DB' },
  costTotalLabel:   { fontSize: 10, fontFamily: 'Helvetica-Bold', color: GRAY_9 },
  costTotalVal:     { fontSize: 10, fontFamily: 'Helvetica-Bold', color: GREEN },

  // Footer
  footer: { position: 'absolute', bottom: 20, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  footerLeft: { fontSize: 7, color: GRAY_5 },
  footerRight: { fontSize: 7, color: GRAY_5 },

  // Terrain / POI
  terrainText: { fontSize: 8, color: GRAY_7, lineHeight: 1.4, marginTop: 3 },
  poiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  poiChip: { backgroundColor: GRAY_1, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 2 },
  poiText: { fontSize: 7, color: GRAY_5 },

  // Highway badge
  hwyBadge: { backgroundColor: GRAY_9, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 2, marginRight: 4 },
  hwyText: { fontSize: 7, color: WHITE, fontFamily: 'Helvetica-Bold' },

  // Map image — legacy (kept for reference; cover page now uses mapCoverWrap/mapCoverImg)
  mapImage: { width: '100%', height: 180, borderRadius: 6, marginBottom: 16, objectFit: 'cover' },

  // Cover-page map — FIXED height, ratio-matched to the server image so
  // objectFit:'contain' fills the box edge-to-edge with no side-strips.
  //
  // BOX:   532pt wide (content width) × 485pt tall → ratio 532÷485 = 1.09691
  // IMAGE: 640×583px (server request)  → ratio 640÷583 = 1.09777 (+0.08% wider)
  //
  // With 'contain' and image 0.08% wider than box:
  //   → width is the constraining dimension → image fills 532pt side-to-side
  //   → rendered height = 532÷1.09777 = 484.6pt → 0.4pt total top/bottom strip
  //   → effectively zero letterboxing; no side-strips; no crop; no distortion
  // objectFit:'cover' would also work (only 0.08% crop on height) but 'contain'
  // is kept as the hard guarantee that every stop + route point stays visible.
  //
  // HEIGHT DERIVATION (worst case = 2-line title, from stylesheet values):
  //   Usable page height   = 792 − paddingTop(36) − paddingBottom(48) = 708pt
  //   logoRow              = logoImg.height(36) + marginBottom(10)     =  46pt
  //   tripNameRow 2-line   = 17×1.25×2 + tripSub(9+3)                 =  54.5pt
  //   coverHeader.mb       =                                             14pt
  //   divider              = height(1) + marginBottom(16)              =  17pt
  //   statsStrip           = marginTop(4)+borders(1)+cells(42)+mb(20)  =  67pt
  //   Total above map                                                  = 198.5pt
  //   Available (worst)    = 708 − 198.5                               = 509.5pt
  //   Fixed height (−24.5pt safety margin)                            = 485pt
  //   2-line title gap below map                                      ≈  24.5pt
  //   1-line title gap below map                                      ≈  45.5pt
  mapCoverWrap: { height: 485, borderRadius: 6, overflow: 'hidden' },
  mapCoverImg:  { width: '100%', height: '100%', objectFit: 'contain' },

  // Slim stats strip (cover page) — hairline rules above/below, 6 cells
  // (Miles | Nights | Stops | Est. Fuel | Est. Camp | Total) in a horizontal
  // row with thin vertical dividers. Numbers ~14pt bold, labels ~8pt muted.
  // Font sizes are starting values — tune after visual review of a generated PDF.
  statsStrip: {
    marginTop: 4,
    marginBottom: 20,
    borderTopWidth: 0.5,
    borderTopColor: '#D1D5DB',
    borderBottomWidth: 0.5,
    borderBottomColor: '#D1D5DB',
  },
  statsStripInner: { flexDirection: 'row', alignItems: 'center' },
  statsStripCell:  { flex: 1, alignItems: 'center', paddingVertical: 9 },
  statsStripVal:   { fontSize: 14, fontFamily: 'Helvetica-Bold', color: GRAY_9 },
  statsStripLabel: { fontSize: 8, color: GRAY_5, marginTop: 2, letterSpacing: 0.4 },
  // Fixed-height divider (spans the inner text block). Height tuned for 14pt
  // value + 8pt label + 2pt gap ≈ 24pt content; 30pt gives a little breathing room.
  statsStripVDiv:  { width: 0.5, height: 30, backgroundColor: '#D1D5DB' },
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d?: Date): string {
  return d ? format(d, 'EEE, MMM d yyyy') : '—'
}

// Compact range for a consolidated stay header, e.g. "Jun 3 – Jun 9 2026".
// Collapses to a single date when start === end (1-night stay).
function fmtDateRange(start?: Date, end?: Date): string {
  if (!start) return '—'
  if (!end || start.getTime() === end.getTime()) return format(start, 'MMM d yyyy')
  return `${format(start, 'MMM d')} – ${format(end, 'MMM d yyyy')}`
}

function fmtTime(hhmm?: string | null): string {
  if (!hhmm) return '—'
  const [h, m] = hhmm.split(':').map(Number)
  const period = h >= 12 ? 'pm' : 'am'
  const dH = h > 12 ? h - 12 : h === 0 ? 12 : h
  return `${dH}:${m.toString().padStart(2, '0')}${period}`
}

function fmtCurrency(n?: number | null): string {
  if (!n && n !== 0) return '—'
  return `$${n.toLocaleString()}`
}

function buildTimeline(stops: Stop[], startDate?: string): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let dayNum = 1
  // parseTripDate routes the ISO/date-only input through the UTC-day-as-local
  // normalization (see utils/dates.ts) so date-fns format() on these dates
  // renders the intended calendar day regardless of viewer timezone.
  let currentDate: Date | undefined = parseTripDate(startDate) ?? undefined

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i]
    const prevStop = i > 0 ? stops[i - 1] : undefined

    if (prevStop) {
      const miles = stop.driveDistanceMiles
        ?? calcMiles(prevStop.latitude, prevStop.longitude, stop.latitude, stop.longitude)
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
    }

    if (stop.type === 'OVERNIGHT_ONLY') {
      entries.push({
        dayNum,
        date: parseTripDate(stop.arrivalDate) ?? (currentDate ? new Date(currentDate) : undefined),
        type: 'OVERNIGHT',
        stop,
        departureTime: '06:00',
        checkInTime: '18:00',
        checkOutTime: '06:00',
        activities: [],
      })
      dayNum++
      if (currentDate) currentDate = addDays(currentDate, 1)
    } else {
      const nights = stop.nights ?? 0
      for (let n = 0; n < nights; n++) {
        let entryDate: Date | undefined
        const parsedArrival = parseTripDate(stop.arrivalDate)
        if (parsedArrival) {
          entryDate = addDays(parsedArrival, n)
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

function mergeAI(entries: TimelineEntry[], aiDays: ItineraryDay[]): TimelineEntry[] {
  if (!aiDays?.length) return entries
  return entries.map((entry, idx) => {
    const ai = aiDays[idx]
    if (!ai) return entry
    const acts = ai.activities
    const normalized: ItineraryActivity[] = Array.isArray(acts)
      ? (acts as any[]).map(a => typeof a === 'string' ? { name: a, checked: false } : a)
      : []
    return {
      ...entry,
      departureTime: ai.departureTime ?? entry.departureTime,
      checkInTime: ai.checkInTime ?? entry.checkInTime,
      checkOutTime: ai.checkOutTime ?? entry.checkOutTime,
      highwayRoute: ai.highwayRoute ?? entry.highwayRoute,
      routeDescription: ai.routeDescription ?? entry.routeDescription,
      terrainSummary: ai.terrainSummary ?? entry.terrainSummary,
      pointsOfInterest: ai.pointsOfInterest ?? entry.pointsOfInterest,
      activities: normalized.length ? normalized : entry.activities,
      transitNote: ai.transitNote ?? entry.transitNote,
    }
  })
}

// Option A (+ partial Fix C) — collapse a shared-list multi-night stay into a
// CHECK-IN card + one consolidated activity-days card.
//
// Runs AFTER mergeAI so the per-day index alignment between buildTimeline's
// entries and trip.itinerary (one ItineraryDay per day) is never disturbed by
// this consolidation. For each STAY entry whose stop carries a non-null
// stayActivities list (the new shape):
//   • the arrival night (n=0 STAY) is KEPT as its own CHECK-IN card, flagged
//     arrivalCheckIn — exactly like the web folds the arrival into its
//     travel-day card and excludes it from the STAY_GROUP count;
//   • the following ACTIVITY entries (n≥1) collapse into ONE consolidatedStay
//     card carrying the shared list, labelled with the POST-ARRIVAL night
//     count and date range. So an 8-night Whitefish stop arriving Jun 2 reads
//     "7-NIGHT STAY · Jun 3 – Jun 9", matching the web (NOT "8-NIGHT / Jun 2").
// The arrival night is not dropped from the trip — it's just shown on the
// check-in card rather than counted in the consolidated stay card.
//
// Old-shape stops (stayActivities == null) carry genuinely distinct per-day
// activities, so they are left completely untouched and keep their per-day
// cards exactly as before. Drive / overnight / single-night entries pass
// through unchanged (a 1-night shared stay stays a lone CHECK-IN card with
// its list). Day-badge numbers are intentionally left on the PDF's existing
// per-entry scheme (the web-parity day-numbering port is a separate item).
function collapseSharedStays(entries: TimelineEntry[]): TimelineEntry[] {
  const out: TimelineEntry[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.type === 'STAY' && e.stop?.stayActivities != null) {
      let j = i + 1
      while (
        j < entries.length &&
        entries[j].type === 'ACTIVITY' &&
        entries[j].stop?.id === e.stop?.id
      ) {
        j++
      }
      const activityEntries = entries.slice(i + 1, j)  // n = 1 … nights-1 (post-arrival)
      // Single-night shared stay → no post-arrival nights. Leave the lone STAY
      // card untouched (it keeps the shared list, as before).
      if (activityEntries.length === 0) {
        out.push(e)
        continue
      }
      // Multi-night: the arrival night (n=0) stays its own CHECK-IN card — the
      // web folds it into the travel-day card and counts only the remaining
      // nights on the STAY_GROUP. We mark it arrivalCheckIn so the shared list
      // renders on the consolidated card below, not twice. The consolidated
      // card spans the post-arrival nights only → "7-NIGHT STAY", Jun 3 – Jun 9
      // for an 8-night Whitefish stop arriving Jun 2 (matches the web).
      const first = activityEntries[0]
      const last = activityEntries[activityEntries.length - 1]
      out.push({ ...e, arrivalCheckIn: true })
      out.push({
        ...first,
        type: 'STAY',
        consolidatedStay: true,
        consolidatedNights: activityEntries.length,
        endDate: last.date,
        endDayNum: last.dayNum,
      })
      i = j - 1
      continue
    }
    out.push(e)
  }
  return out
}

function calcMiles(lat1?: number, lng1?: number, lat2?: number, lng2?: number): number {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 0
  const R = 3958.8
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(a)))
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function InfoCell({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <View style={s.infoCell}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.infoVal}>{value}</Text>
    </View>
  )
}

function DriveEntry({ entry }: { entry: TimelineEntry }) {
  return (
    // wrap={false}: the entire drive card — header, route name, meta, notes —
    // is kept as an unbreakable unit. If it genuinely exceeds a full page
    // (pathological case) react-pdf degrades by breaking rather than erroring.
    <View wrap={false} style={[s.entry, s.driveCard]}>
      <View style={s.entryHeader}>
        <View style={[s.dayBadge, { backgroundColor: '#3B82F6' }]}>
          <Text style={s.dayBadgeText}>{entry.dayNum}</Text>
        </View>
        <View style={[s.typeBadge, { backgroundColor: '#DBEAFE' }]}>
          <Text style={[s.typeBadgeText, { color: '#1D4ED8' }]}>DRIVE DAY</Text>
        </View>
        {entry.date && <Text style={s.entryDateText}>{fmtDate(entry.date)}</Text>}
      </View>
      <View style={s.entryBody}>
        <Text style={s.driveRoute}>
          {entry.prevStop?.locationName || '—'} → {entry.stop?.locationName || '—'}
        </Text>
        <View style={s.driveMeta}>
          {entry.miles ? <Text style={s.driveMetaText}>{entry.miles} mi</Text> : null}
          {entry.driveHours ? <Text style={s.driveMetaText}>~{entry.driveHours} hrs</Text> : null}
          {entry.highwayRoute ? (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[s.driveMetaText, { marginRight: 3 }]}>via</Text>
              <View style={s.hwyBadge}><Text style={s.hwyText}>{entry.highwayRoute}</Text></View>
            </View>
          ) : null}
          <Text style={s.driveMetaText}>Depart {fmtTime(entry.departureTime)}</Text>
        </View>
        {entry.routeDescription ? (
          <Text style={s.routeDesc}>{entry.routeDescription}</Text>
        ) : null}
        {entry.terrainSummary ? (
          <Text style={[s.terrainText, { color: '#134756', marginTop: 4 }]}>{entry.terrainSummary}</Text>
        ) : null}
        {entry.pointsOfInterest?.length ? (
          <View style={s.poiRow}>
            {entry.pointsOfInterest.map((poi, i) => (
              <View key={i} style={s.poiChip}><Text style={s.poiText}>{poi.name} · {poi.durationMinutes} min</Text></View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  )
}

function StopEntry({ entry }: { entry: TimelineEntry }) {
  const stop = entry.stop
  if (!stop) return null

  // Block 15 — shared per-stay activity list. When Stop.stayActivities is
  // non-null it's the canonical user-edited list and the PDF renders it
  // ONCE on the 'STAY' entry (mirroring the web's single consolidated
  // "Things to do during your stay" section); the per-day entry.activities
  // path is suppressed on the subsequent 'ACTIVITY' entries of the same
  // stop so the list isn't duplicated per night. Old-shape trips
  // (stayActivities == null) fall through to the per-day rendering
  // unchanged. Normalization mirrors mergeAI above — bare strings get
  // wrapped into { name, checked: false }.
  const sharedRaw = stop.stayActivities
  const usesSharedStayActivities = sharedRaw != null
  const sharedStayActivities: ItineraryActivity[] = usesSharedStayActivities && Array.isArray(sharedRaw)
    ? (sharedRaw as any[]).map(a => typeof a === 'string' ? { name: a, checked: false } : a)
    : []

  // Fix A — the consolidated stay card uses the web's amber/gold palette
  // (white body, gold header band via entryHeaderAmber, gray-400 border).
  // Every other card keeps its existing color.
  const cardStyle = entry.consolidatedStay ? s.stayCardAmber
    : entry.type === 'STAY' ? s.stayCard
    : entry.type === 'OVERNIGHT' ? s.ovCard
    : s.actCard

  // Consolidated tag mirrors the web's text-only #854F0B night tag (no fill).
  const badgeBg = entry.consolidatedStay ? 'transparent'
    : entry.type === 'STAY' ? '#BFDBFE'
    : entry.type === 'OVERNIGHT' ? '#DDD6FE'
    : '#FDE68A'

  const badgeTxt = entry.consolidatedStay ? AMBER_TAG
    : entry.type === 'STAY' ? '#065F46'
    : entry.type === 'OVERNIGHT' ? '#5B21B6'
    : '#92400E'

  // Consolidated card → "N-NIGHT STAY" where N is the POST-ARRIVAL night count
  // (consolidatedNights), matching the web STAY_GROUP which excludes the
  // arrival night. Non-consolidated stays keep "CHECK-IN" etc.
  const stayNights = entry.consolidatedNights ?? stop.nights ?? ((entry.endDayNum ?? entry.dayNum) - entry.dayNum + 1)
  const typeLabel = entry.consolidatedStay
    ? `${stayNights}-NIGHT STAY`
    : entry.type === 'STAY' ? 'CHECK-IN'
    : entry.type === 'OVERNIGHT' ? 'OVERNIGHT'
    : 'EXPLORE DAY'

  // Day badge spans a range for a multi-day consolidated stay; single number
  // otherwise. (Absolute numbers stay on the PDF's per-entry scheme — the
  // web-parity day-numbering port is a separate, parked item.) Header date
  // collapses to a range for the consolidated stay.
  const isDayRange = !!entry.consolidatedStay && entry.endDayNum != null && entry.endDayNum !== entry.dayNum
  const dayBadgeLabel = isDayRange ? `${entry.dayNum}–${entry.endDayNum}` : String(entry.dayNum)
  const headerDate = entry.consolidatedStay
    ? fmtDateRange(entry.date, entry.endDate)
    : entry.date ? fmtDate(entry.date) : null

  const dayBadgeBg = entry.consolidatedStay ? AMBER_700
    : entry.type === 'STAY' ? GREEN
    : entry.type === 'OVERNIGHT' ? '#7C3AED'
    : '#D97706'

  return (
    // wrap={false}: the whole stop block (check-in info, notes, activities,
    // transit note) stays on one page. Over-tall single stops degrade
    // gracefully — react-pdf renders rather than errors.
    <View wrap={false} style={[s.entry, cardStyle]}>
      <View style={entry.consolidatedStay ? [s.entryHeader, s.entryHeaderAmber] : s.entryHeader}>
        <View style={[isDayRange ? s.dayBadgeWide : s.dayBadge, { backgroundColor: dayBadgeBg }]}>
          <Text style={s.dayBadgeText}>{dayBadgeLabel}</Text>
        </View>
        <View style={[s.typeBadge, { backgroundColor: badgeBg }]}>
          <Text style={[s.typeBadgeText, { color: badgeTxt }]}>{typeLabel}</Text>
        </View>
        {headerDate && <Text style={s.entryDateText}>{headerDate}</Text>}
      </View>

      <View style={s.entryBody}>
        <Text style={s.locationName}>{stop.locationName}</Text>
        {stop.campgroundName ? <Text style={s.campName}>{stop.campgroundName}</Text> : null}

        {entry.type === 'OVERNIGHT' ? (
          /* ── Overnight stop: no check-in/out times ── */
          <>
            <View style={s.infoGrid}>
              <InfoCell label="Site rate" value={stop.siteRate ? `$${stop.siteRate}/night` : null} />
              <InfoCell label="Hookups" value={stop.hookupType || null} />
              <InfoCell label="Pet friendly" value={stop.isPetFriendly === true ? 'Yes' : stop.isPetFriendly === false ? 'No' : null} />
            </View>
            <View style={s.notesBox}>
              <Text style={s.notesText}>Overnight stop — early departure planned</Text>
            </View>
            {stop.notes ? (
              <View style={[s.notesBox, { marginTop: 4 }]}>
                <Text style={s.notesText}>{stop.notes}</Text>
              </View>
            ) : null}
          </>
        ) : entry.type === 'ACTIVITY' ? (
          /* ── Explore day: no nights/check-in/out ── */
          <>
            {/* Block 15 — when the stop carries a shared stayActivities
                list the consolidated section is rendered once on the STAY
                entry, so suppress the per-day activities block here to
                avoid duplication across nights. Old-shape trips
                (stayActivities == null) keep the original per-day path. */}
            {!usesSharedStayActivities && entry.activities?.length ? (
              <>
                <Text style={s.actTitle}>Activities</Text>
                {entry.activities.map((act, i) => (
                  <View key={i} style={s.actItem}>
                    <View style={s.actDot} />
                    <Text style={s.actText}>{act.name}</Text>
                  </View>
                ))}
              </>
            ) : null}
            {entry.transitNote ? (
              <View style={[s.notesBox, { marginTop: 4 }]}>
                <Text style={s.notesText}>{entry.transitNote}</Text>
              </View>
            ) : null}
          </>
        ) : (
          /* ── Stay: CHECK-IN card (arrival / single-night / old-shape) OR the
                consolidated activity-days card (amber). The consolidated card
                shows only the campground + shared list (its booking detail
                lives on the preceding CHECK-IN card, mirroring the web's
                travel-day / STAY_GROUP split). ── */
          <>
            {!entry.consolidatedStay && (
              <>
                {stop.confirmationNum && stop.bookingStatus === 'CONFIRMED' ? (
                  <View style={s.confirmBox}>
                    <Text style={s.confirmLabel}>CONFIRMED</Text>
                    <Text style={s.confirmVal}>#{stop.confirmationNum}</Text>
                    {stop.siteNumber ? <Text style={s.confirmVal}>· Site {stop.siteNumber}</Text> : null}
                  </View>
                ) : null}

                <View style={s.infoGrid}>
                  <InfoCell label="Nights" value={stop.nights ? String(stop.nights) : null} />
                  <InfoCell label="Check-in" value={fmtTime(stop.checkInTime || entry.checkInTime)} />
                  <InfoCell label="Check-out" value={fmtTime(stop.checkOutTime || entry.checkOutTime)} />
                  <InfoCell label="Site rate" value={stop.siteRate ? `$${stop.siteRate}/night` : null} />
                  <InfoCell label="Hookups" value={stop.hookupType || null} />
                  <InfoCell label="Pet friendly" value={stop.isPetFriendly === true ? 'Yes' : stop.isPetFriendly === false ? 'No' : null} />
                </View>

                {stop.notes ? (
                  <View style={s.notesBox}>
                    <Text style={s.notesText}>{stop.notes}</Text>
                  </View>
                ) : null}
              </>
            )}

            {/* Shared activity list. Renders on the consolidated card (amber
                title/dots) and on a single-night shared stay's check-in card;
                SUPPRESSED on the arrival check-in card of a multi-night stay
                (arrivalCheckIn) since the list is on the consolidated card.
                Old-shape stops fall through to per-day entry.activities. */}
            {entry.consolidatedStay ? (
              sharedStayActivities.length ? (
                <>
                  <Text style={[s.actTitle, { color: AMBER_700 }]}>Things to do during your stay</Text>
                  {sharedStayActivities.map((act, i) => (
                    <View key={i} style={s.actItem}>
                      <View style={[s.actDot, { backgroundColor: AMBER_700 }]} />
                      <Text style={s.actText}>{act.name}</Text>
                    </View>
                  ))}
                </>
              ) : null
            ) : entry.arrivalCheckIn ? null
              : usesSharedStayActivities ? (
                sharedStayActivities.length ? (
                  <>
                    <Text style={s.actTitle}>Things to do during your stay</Text>
                    {sharedStayActivities.map((act, i) => (
                      <View key={i} style={s.actItem}>
                        <View style={s.actDot} />
                        <Text style={s.actText}>{act.name}</Text>
                      </View>
                    ))}
                  </>
                ) : null
              ) : entry.activities?.length ? (
                <>
                  <Text style={s.actTitle}>Activities</Text>
                  {entry.activities.map((act, i) => (
                    <View key={i} style={s.actItem}>
                      <View style={s.actDot} />
                      <Text style={s.actText}>{act.name}</Text>
                    </View>
                  ))}
                </>
              ) : null}

            {entry.transitNote ? (
              <View style={[s.notesBox, { marginTop: 4 }]}>
                <Text style={s.notesText}>{entry.transitNote}</Text>
              </View>
            ) : null}
          </>
        )}
      </View>
    </View>
  )
}

// ─── Main Document ────────────────────────────────────────────────────────────

interface Props {
  trip: Trip
  mapImageBase64?: string | null
  /** Live regional fuel-cost estimate threaded from the page that triggered
   *  the PDF (the page already fetches this async — passing the result down
   *  as a prop avoids the PDF needing its own async fetch + state). When
   *  null/noEstimate (e.g. estimate hadn't loaded by export time, or the
   *  rig has no MPG), the helper returns camp-only and the fuel stat
   *  renders as "—". The stale trip.estimatedFuel column is intentionally
   *  not consulted as a fallback — it's the inconsistent AI guess the
   *  helper exists to retire. */
  fuelEstimate?: TripFuelEstimate | null
}

export function TripPDF({ trip, mapImageBase64, fuelEstimate }: Props) {
  const sortedStops = [...(trip.stops || [])].sort((a, b) => a.order - b.order)

  const rawEntries = buildTimeline(sortedStops, trip.startDate ?? undefined)
  const mergedEntries = trip.itinerary ? mergeAI(rawEntries, trip.itinerary) : rawEntries
  // Option A — fold each shared-list multi-night stay into one consolidated card.
  const entries = collapseSharedStays(mergedEntries)

  const totalNights = trip.totalNights ?? sortedStops.reduce((s, st) => s + st.nights, 0)

  // Trip totals via the shared helper — same arithmetic the on-screen
  // Cost Breakdown and stat-strip use, so PDF totals can't drift from
  // what the user saw before clicking Export. fuelEstimate is threaded
  // as a prop from the page that triggered the PDF (the page already
  // fetched it async); when null/noEstimate, the helper returns camp-only
  // and the stats grid renders fuel as "—".
  //
  // fuelPerLeg passed too so the PDF's "actual so far" line reflects
  // per-leg actuals (Stop.actualFuel sum) instead of the legacy trip-
  // level number — matches what the on-screen Cost Breakdown shows.
  const totals = computeTripTotals(trip, {
    fuelEstimate: fuelEstimate?.noEstimate ? null : (fuelEstimate?.total ?? null),
    fuelPerLeg: fuelEstimate?.noEstimate ? null : (fuelEstimate?.perLeg ?? null),
  })
  const totalCampEst = totals.campEst
  const fuelEst      = totals.fuelEst   // restored: 6th cell in the cover strip
  const plannedTotal = totals.plannedTotal
  // actualTotalSoFar / hasAnyActuals were shown in the old chunky stats card
  // (removed in the cover-page redesign). Kept as a comment so they're easy
  // to restore if an "actual so far" row is added back to the itinerary page.
  // const actualTotalSoFar = totals.actualTotal
  // const hasAnyActuals    = totals.hasAnyActuals

  // ── Cost breakdown rows — SAME math as the web Cost breakdown
  // (TripSummaryPage.tsx). Camping rows = per-stop siteRate × nights ($0 rows
  // skipped, exactly like the web); the Camping subtotal, Fuel subtotal, and
  // grand total all read straight from computeTripTotals above (campEst /
  // fuelEst / plannedTotal) — no reimplemented arithmetic that could drift.
  // Fuel rows come from the same threaded fuelEstimate.perLeg the page shows.
  const campRows = sortedStops
    .map(st => ({
      name: st.locationName,
      nights: st.nights ?? 0,
      rate: st.siteRate ?? 0,
      cost: (st.siteRate ?? 0) * (st.nights ?? 0),
    }))
    .filter(r => r.cost > 0)
  const stopNameByOrder = new Map<number, string>()
  for (const st of sortedStops) stopNameByOrder.set(st.order, st.locationName)
  const legName = (order: number, fallback: string | null) =>
    stopNameByOrder.get(order) ?? fallback ?? `Stop ${order}`
  const fuelLegs = fuelEstimate && !fuelEstimate.noEstimate ? fuelEstimate.perLeg : []

  // Live total miles: prefer Routes API driveDistanceMiles per stop, fall back to Haversine.
  const liveTotalMiles = sortedStops.slice(1).reduce((sum, stop, i) => {
    const prev = sortedStops[i]
    const seg = stop.driveDistanceMiles ?? calcMiles(prev.latitude, prev.longitude, stop.latitude, stop.longitude)
    return sum + seg
  }, 0)

  // parseTripDate normalizes the UTC calendar day so 'MMM d, yyyy' renders
  // the intended date regardless of viewer timezone. Filter() also drops the
  // null-passthrough output from parseTripDate, so we never format invalid.
  const dateRange = [trip.startDate, trip.endDate]
    .map(d => parseTripDate(d))
    .filter((d): d is Date => d != null)
    .map(d => format(d, 'MMM d, yyyy'))
    .join(' – ') || 'Dates TBD'

  const generatedOn = format(new Date(), 'MMM d, yyyy')

  return (
    <Document title={`RoamReady – ${trip.name}`} author="RoamReady">

      {/* ══════════════════════════════════════════════════════════════
          PAGE 1 — COVER: header · stats strip · full-route map
          Day-by-day itinerary ALWAYS starts on page 2.
          ══════════════════════════════════════════════════════════════ */}
      <Page size="LETTER" style={s.page}>

        {/* ── Header — stacked layout ── */}
        {/* Row 1: logo + wordmark left-aligned on its own line.
            Row 2: trip title (full content width, wraps on long titles) +
                   "start → end · date range" subtitle directly beneath.
            This prevents the logo / title collision on long trip names. */}
        <View style={s.coverHeader}>
          {/* Row 1 — logo */}
          <View style={s.logoRow}>
            <Image src="/roamready-icon.png" style={s.logoImg} />
            <View>
              <Text style={s.brandName}>RoamReady</Text>
              <Text style={s.brandTag}>Trip Itinerary</Text>
            </View>
          </View>
          {/* Row 2 — title + subtitle, full content width */}
          <View style={s.tripNameRow}>
            <Text style={s.tripName}>{trip.name}</Text>
            <Text style={s.tripSub}>
              {trip.startLocation} → {trip.endLocation}{'  ·  '}{dateRange}
            </Text>
          </View>
        </View>

        <View style={s.divider} />

        {/* ── Slim stats strip — 6 cells ── */}
        {/* Miles | Nights | Stops | Est. Fuel | Est. Camp | Total
            Hairline top & bottom, thin vertical dividers between cells.
            Labels are shortened to 1–2 words so 6 cells fit at any trip name length.
            Font sizes (val: 14pt, label: 8pt) are starting values — tune visually. */}
        <View style={s.statsStrip}>
          <View style={s.statsStripInner}>
            <View style={s.statsStripCell}>
              <Text style={s.statsStripVal}>
                {liveTotalMiles > 0 ? liveTotalMiles.toLocaleString() : (trip.totalMiles?.toLocaleString() || '—')}
              </Text>
              <Text style={s.statsStripLabel}>MILES</Text>
            </View>
            <View style={s.statsStripVDiv} />
            <View style={s.statsStripCell}>
              <Text style={s.statsStripVal}>{totalNights}</Text>
              <Text style={s.statsStripLabel}>NIGHTS</Text>
            </View>
            <View style={s.statsStripVDiv} />
            <View style={s.statsStripCell}>
              <Text style={s.statsStripVal}>{sortedStops.length}</Text>
              <Text style={s.statsStripLabel}>STOPS</Text>
            </View>
            <View style={s.statsStripVDiv} />
            <View style={s.statsStripCell}>
              <Text style={s.statsStripVal}>{fmtCurrency(fuelEst || null)}</Text>
              <Text style={s.statsStripLabel}>EST. FUEL</Text>
            </View>
            <View style={s.statsStripVDiv} />
            <View style={s.statsStripCell}>
              <Text style={s.statsStripVal}>{fmtCurrency(totalCampEst || null)}</Text>
              <Text style={s.statsStripLabel}>EST. CAMP</Text>
            </View>
            <View style={s.statsStripVDiv} />
            <View style={s.statsStripCell}>
              <Text style={s.statsStripVal}>{fmtCurrency(plannedTotal || null)}</Text>
              <Text style={s.statsStripLabel}>TOTAL</Text>
            </View>
          </View>
        </View>

        {/* ── Route map — tall centerpiece, fills remaining cover height ── */}
        {/* mapCoverWrap has flex:1 → the Page's flex-column distributes the
            remaining height (after header + divider + stats strip) to this
            container. The Image inside uses objectFit:'contain' so the portrait
            source (540×640, ratio ≈ 0.844) fits without any crop or distortion.
            Server auto-fits all stops + polyline; no center/zoom in the URL. */}
        {mapImageBase64 ? (
          <View style={s.mapCoverWrap}>
            <Image src={mapImageBase64} style={s.mapCoverImg} />
          </View>
        ) : null}

        {/* ── Footer (fixed: repeats on any cover overflow pages) ── */}
        <View style={s.footer} fixed>
          <Text style={s.footerLeft}>Generated by RoamReady · {generatedOn}</Text>
          <Text
            style={s.footerRight}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>

      </Page>

      {/* ══════════════════════════════════════════════════════════════
          PAGE 2+ — DAY-BY-DAY ITINERARY
          Each stop/drive entry is wrapped in wrap={false} so the whole
          block moves to the next page rather than splitting mid-card.
          ══════════════════════════════════════════════════════════════ */}
      <Page size="LETTER" style={s.page}>

        <Text style={s.sectionTitle}>Day-by-Day Itinerary</Text>

        {entries.map((entry, idx) =>
          entry.type === 'DRIVE'
            ? <DriveEntry key={idx} entry={entry} />
            : <StopEntry key={idx} entry={entry} />
        )}

        {/* ══════════════════════════════════════════════════════════════
            COST BREAKDOWN — per-stop camping + per-leg fuel + grand total.
            One-to-one with the web Cost breakdown; subtotals/total come from
            computeTripTotals so the PDF can't drift from the on-screen number.
            ══════════════════════════════════════════════════════════════ */}
        <View style={{ marginTop: 14 }} wrap={false}>
          <Text style={s.sectionTitle}>Cost breakdown</Text>

          <Text style={s.costGroupLabel}>Camping</Text>
          {campRows.map((r, i) => (
            <View key={`camp-${i}`} style={s.costRow}>
              <Text style={s.costRowLabel}>
                {r.name}
                <Text style={s.costRowSub}>  ·  {r.nights} night{r.nights === 1 ? '' : 's'}{r.rate ? ` × $${r.rate}` : ''}</Text>
              </Text>
              <Text style={s.costRowVal}>{fmtCurrency(Math.round(r.cost))}</Text>
            </View>
          ))}
          <View style={s.costSubtotalRow}>
            <Text style={s.costSubtotalLabel}>Camping subtotal</Text>
            <Text style={s.costSubtotalVal}>{fmtCurrency(Math.round(totalCampEst))}</Text>
          </View>
        </View>

        <View wrap={false}>
          <Text style={s.costGroupLabel}>Fuel</Text>
          {fuelLegs.length ? fuelLegs.map((leg, i) => (
            <View key={`fuel-${i}`} style={s.costRow}>
              <Text style={s.costRowLabel}>
                {legName(leg.fromOrder, null)} → {legName(leg.toOrder, leg.toState)}
                <Text style={s.costRowSub}>  ·  {Math.round(leg.miles).toLocaleString()} mi</Text>
              </Text>
              <Text style={s.costRowVal}>{fmtCurrency(Math.round(leg.cost))}</Text>
            </View>
          )) : (
            <View style={s.costRow}>
              <Text style={s.costRowLabel}>Fuel estimate unavailable</Text>
              <Text style={s.costRowVal}>—</Text>
            </View>
          )}
          <View style={s.costSubtotalRow}>
            <Text style={s.costSubtotalLabel}>Fuel subtotal</Text>
            <Text style={s.costSubtotalVal}>{fuelEst != null ? fmtCurrency(Math.round(fuelEst)) : '—'}</Text>
          </View>

          <View style={s.costTotalRow}>
            <Text style={s.costTotalLabel}>Estimated total</Text>
            <Text style={s.costTotalVal}>{fmtCurrency(Math.round(plannedTotal))}</Text>
          </View>
        </View>

        {/* ── Footer (fixed: repeats on every itinerary page) ── */}
        <View style={s.footer} fixed>
          <Text style={s.footerLeft}>Generated by RoamReady · {generatedOn}</Text>
          <Text
            style={s.footerRight}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>

      </Page>

    </Document>
  )
}
