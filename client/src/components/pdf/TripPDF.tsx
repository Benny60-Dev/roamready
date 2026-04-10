import {
  Document, Page, View, Text, StyleSheet, Image,
} from '@react-pdf/renderer'
import { Trip, Stop, ItineraryDay, ItineraryActivity } from '../../types/index'
import { format, addDays } from 'date-fns'

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
  pointsOfInterest?: string[] | null
  activities: ItineraryActivity[]
  transitNote?: string | null
}

// ─── Colors / constants ───────────────────────────────────────────────────────

const GREEN  = '#1D9E75'
const GREEN_L = '#E1F5EE'
const BLUE_L  = '#EFF6FF'
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

  // Header
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  logoBox: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  logoDot: { width: 22, height: 22, borderRadius: 6, backgroundColor: GREEN, justifyContent: 'center', alignItems: 'center' },
  logoText: { fontSize: 7, fontFamily: 'Helvetica-Bold', color: WHITE, letterSpacing: 0.3 },
  brandName: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: GRAY_9 },
  brandTag: { fontSize: 8, color: GRAY_5, marginTop: 1 },
  headerRight: { textAlign: 'right' },
  tripName: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: GRAY_9 },
  tripSub: { fontSize: 9, color: GRAY_5, marginTop: 2 },
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
  stayCard: { backgroundColor: GREEN_L, borderWidth: 1, borderColor: '#A7F3D0', borderRadius: 6 },
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

  // Map image
  mapImage: { width: '100%', height: 180, borderRadius: 6, marginBottom: 16, objectFit: 'cover' },
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
  let currentDate = startDate ? new Date(startDate) : undefined

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i]
    const prevStop = i > 0 ? stops[i - 1] : undefined

    if (prevStop) {
      const miles = calcMiles(prevStop.latitude, prevStop.longitude, stop.latitude, stop.longitude)
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
        date: stop.arrivalDate ? new Date(stop.arrivalDate) : currentDate ? new Date(currentDate) : undefined,
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
    <View style={[s.entry, s.driveCard]}>
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
          <Text style={[s.terrainText, { color: '#1E40AF', marginTop: 4 }]}>{entry.terrainSummary}</Text>
        ) : null}
        {entry.pointsOfInterest?.length ? (
          <View style={s.poiRow}>
            {entry.pointsOfInterest.map((poi, i) => (
              <View key={i} style={s.poiChip}><Text style={s.poiText}>{poi}</Text></View>
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

  const cardStyle = entry.type === 'STAY' ? s.stayCard
    : entry.type === 'OVERNIGHT' ? s.ovCard
    : s.actCard

  const badgeBg = entry.type === 'STAY' ? '#A7F3D0'
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
    <View style={[s.entry, cardStyle]}>
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
            {entry.activities?.length ? (
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

            {entry.activities?.length ? (
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
}

export function TripPDF({ trip, mapImageBase64 }: Props) {
  const sortedStops = [...(trip.stops || [])].sort((a, b) => a.order - b.order)

  const rawEntries = buildTimeline(sortedStops, trip.startDate ?? undefined)
  const entries = trip.itinerary ? mergeAI(rawEntries, trip.itinerary) : rawEntries

  const totalNights = trip.totalNights ?? sortedStops.reduce((s, st) => s + st.nights, 0)
  const totalCamp   = trip.estimatedCamp ?? sortedStops.reduce((s, st) => s + (st.siteRate || 0) * st.nights, 0)
  const grandTotal  = totalCamp + (trip.estimatedFuel || 0)

  const dateRange = [trip.startDate, trip.endDate]
    .filter(Boolean)
    .map(d => format(new Date(d!), 'MMM d, yyyy'))
    .join(' – ') || 'Dates TBD'

  const generatedOn = format(new Date(), 'MMM d, yyyy')

  return (
    <Document title={`RoamReady – ${trip.name}`} author="RoamReady">
      <Page size="LETTER" style={s.page}>

        {/* ── Header ── */}
        <View style={s.headerRow}>
          <View style={s.logoBox}>
            <View style={s.logoDot}>
              <Text style={s.logoText}>RR</Text>
            </View>
            <View>
              <Text style={s.brandName}>RoamReady</Text>
              <Text style={s.brandTag}>Trip Itinerary</Text>
            </View>
          </View>
          <View style={s.headerRight}>
            <Text style={s.tripName}>{trip.name}</Text>
            <Text style={s.tripSub}>{trip.startLocation} → {trip.endLocation}</Text>
            <Text style={[s.tripSub, { marginTop: 2 }]}>{dateRange}</Text>
          </View>
        </View>

        <View style={s.divider} />

        {/* ── Stats ── */}
        <View style={s.statsCard}>
          <Text style={s.statsTitle}>Trip at a Glance</Text>
          <View style={s.statsGrid}>
            <View style={s.statCell}>
              <Text style={s.statVal}>{trip.totalMiles?.toLocaleString() || '—'}</Text>
              <Text style={s.statLabel}>Total Miles</Text>
            </View>
            <View style={s.statDivider} />
            <View style={s.statCell}>
              <Text style={s.statVal}>{totalNights}</Text>
              <Text style={s.statLabel}>Nights</Text>
            </View>
            <View style={s.statDivider} />
            <View style={s.statCell}>
              <Text style={s.statVal}>{sortedStops.length}</Text>
              <Text style={s.statLabel}>Stops</Text>
            </View>
            <View style={s.statDivider} />
            <View style={s.statCell}>
              <Text style={s.statVal}>{fmtCurrency(trip.estimatedFuel)}</Text>
              <Text style={s.statLabel}>Est. Fuel</Text>
            </View>
            <View style={s.statDivider} />
            <View style={s.statCell}>
              <Text style={s.statVal}>{fmtCurrency(totalCamp || null)}</Text>
              <Text style={s.statLabel}>Est. Camping</Text>
            </View>
            <View style={s.statDivider} />
            <View style={s.statCell}>
              <Text style={[s.statVal, { fontSize: 16 }]}>{fmtCurrency(grandTotal || null)}</Text>
              <Text style={s.statLabel}>Total Est. Cost</Text>
            </View>
          </View>
        </View>

        {/* ── Route Map ── */}
        {mapImageBase64 ? (
          <Image src={mapImageBase64} style={s.mapImage} />
        ) : null}

        {/* ── Itinerary ── */}
        <Text style={s.sectionTitle}>Day-by-Day Itinerary</Text>

        {entries.map((entry, idx) =>
          entry.type === 'DRIVE'
            ? <DriveEntry key={idx} entry={entry} />
            : <StopEntry key={idx} entry={entry} />
        )}

        {/* ── Footer ── */}
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
