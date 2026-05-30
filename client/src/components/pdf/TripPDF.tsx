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

  // Cover-page map — FIXED height so react-pdf never pushes it to page 2.
  //
  // flex:1 was the previous approach but react-pdf does not reliably shrink a
  // flex child containing an <Image> to the remaining page height — it can
  // instead push the whole block to a new page.
  //
  // Height derived from stylesheet values (worst case = 2-line title):
  //   Usable page height   = 792 − paddingTop(36) − paddingBottom(48) = 708pt
  //   logoRow              = logoImg.height(36) + marginBottom(10)     =  46pt
  //   tripNameRow 2-line   = 17×1.25×2 + tripSub(9+3)                 =  54.5pt
  //   coverHeader.mb       =                                             14pt
  //   divider              = height(1) + marginBottom(16)              =  17pt
  //   statsStrip           = marginTop(4)+borders(1)+cells(42)+mb(20)  =  67pt
  //   Total above map                                                  = 198.5pt
  //   Available (worst)    = 708 − 198.5                               = 509.5pt
  //   Fixed height (−70pt safety margin for rounding + unmeasured gaps)= 440pt
  //
  // Short 1-line title leaves ~91pt gap below the map — acceptable white space.
  // 2-line title leaves ~70pt gap — still comfortable. Increase toward 500 once
  // confirmed safe in both real PDFs; decrease if still overflowing.
  //
  // objectFit:'contain' on the image → no distortion. Portrait source (0.844:1)
  // in a wider-than-tall container produces neutral side-strips; no crop ever.
  mapCoverWrap: { height: 440, borderRadius: 6, overflow: 'hidden' },
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

  const cardStyle = entry.type === 'STAY' ? s.stayCard
    : entry.type === 'OVERNIGHT' ? s.ovCard
    : s.actCard

  const badgeBg = entry.type === 'STAY' ? '#BFDBFE'
    : entry.type === 'OVERNIGHT' ? '#DDD6FE'
    : '#FDE68A'

  const badgeTxt = entry.type === 'STAY' ? '#065F46'
    : entry.type === 'OVERNIGHT' ? '#5B21B6'
    : '#92400E'

  const typeLabel = entry.type === 'STAY' ? 'CHECK-IN'
    : entry.type === 'OVERNIGHT' ? 'OVERNIGHT'
    : 'EXPLORE DAY'

  const dayBadgeBg = entry.type === 'STAY' ? GREEN
    : entry.type === 'OVERNIGHT' ? '#7C3AED'
    : '#D97706'

  return (
    // wrap={false}: the whole stop block (check-in info, notes, activities,
    // transit note) stays on one page. Over-tall single stops degrade
    // gracefully — react-pdf renders rather than errors.
    <View wrap={false} style={[s.entry, cardStyle]}>
      <View style={s.entryHeader}>
        <View style={[s.dayBadge, { backgroundColor: dayBadgeBg }]}>
          <Text style={s.dayBadgeText}>{entry.dayNum}</Text>
        </View>
        <View style={[s.typeBadge, { backgroundColor: badgeBg }]}>
          <Text style={[s.typeBadgeText, { color: badgeTxt }]}>{typeLabel}</Text>
        </View>
        {entry.date && <Text style={s.entryDateText}>{fmtDate(entry.date)}</Text>}
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
          /* ── Normal stay (CHECK-IN) ── */
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

            {/* Block 15 — new-shape: render the shared list once here under
                the web's "Things to do during your stay" wording.
                Old-shape (stayActivities == null): fall through to the
                per-day entry.activities path exactly as before. */}
            {usesSharedStayActivities ? (
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
  const entries = trip.itinerary ? mergeAI(rawEntries, trip.itinerary) : rawEntries

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
