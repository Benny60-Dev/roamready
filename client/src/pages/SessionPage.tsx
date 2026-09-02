import { useCallback, useState, useRef, useEffect, useLayoutEffect, type CSSProperties } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { MapPin, Tent, Users, Loader, Plus, X, Sparkles, ChevronDown, ChevronUp, ChevronRight, Check, Info, Flag } from 'lucide-react'
import { aiApi, sessionsApi, tripsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useUIStore } from '../store/uiStore'
import { ChatMessage, Trip, Rig } from '../types'
import { VEHICLE_LABELS, rigDisplayName, missingSafetyDims, missingMpg } from '../utils/rigs'
import BottomSheet from '../components/ui/BottomSheet'
import ConfirmModal from '../components/ui/ConfirmModal'
import ConfirmVehiclesModal, { type ConfirmVehiclesResult } from '../components/trip/ConfirmVehiclesModal'
import RigCompletenessNotice from '../components/trip/RigCompletenessNotice'
import RigWarningPill from '../components/trip/RigWarningPill'
import HomeBaseCard from '../components/trip/HomeBaseCard'
import TripCard from '../components/trip/TripCard'
import HomeJournalMapCard from '../components/journal/HomeJournalMapCard'
import { useSessionAutosave } from '../hooks/useSessionAutosave'
import { useVoiceInput } from '../hooks/useVoiceInput'
import { useScrollResetOnReady } from '../hooks/useScrollResetOnReady'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { hasRoundTripIntent } from '../utils/roundTripIntent'
import { cleanChatText } from '../utils/cleanChatText'
import { initChatAudio } from '../utils/chatSounds'
import { ChatInput } from '../components/ChatInput'
import { selectGreeting } from '../utils/greeting'
import { relativeTime, parseTripDate, rollYmdForwardIfPast, formatTripDate } from '../utils/dates'

// Shared style for the "Trip context" strip chips (rig | travelers | hookup).
// minHeight 44 gives a comfortable touch target (the rig chip is tappable on
// multi-rig), and giving all three the same base makes the row read as one set
// of equal-height chips instead of a tall interactive pill beside two short
// text labels. The rig chip layers its open/hover state + cursor on top.
const CONTEXT_CHIP_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minHeight: 44,
  padding: '6px 12px',
  borderRadius: 6,
  border: '0.5px solid #E8E4DA',
  background: 'white',
  color: '#134756',
  fontSize: 12,
}
import { computeTripTotals } from '../utils/tripTotals'
import { deriveTripStatus } from '../utils/tripStatus'

// Window augmentation for SpeechRecognition / webkitSpeechRecognition lives
// in client/src/types/global.d.ts now — see useVoiceInput hook for usage.

// Take the first 40 chars of a user message, cut at the last word boundary if reasonable.
function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 40) return trimmed
  const slice = trimmed.slice(0, 40)
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > 20 ? slice.slice(0, lastSpace) : slice).trim()
}

// Per-trip rig override types. selectedRig on SessionPage can hold either a
// real Rig from user.rigs (has a real id, persisted via /users/me) or an
// AdHocRig the user filled out via "Add a different rig" in the chip
// dropdown. Ad-hoc rigs ride into the promote payload via the adHocVehicle
// slot (existing per-trip vehicle field) and rigId: null — they are never
// written to the Rig table or to the profile.
type AdHocRig = {
  isAdHoc: true
  year?: number
  make?: string
  model?: string
  length?: number
}
type SelectedRig = Rig | AdHocRig | null
function isAdHocRig(r: SelectedRig): r is AdHocRig {
  return r != null && 'isAdHoc' in r && r.isAdHoc === true
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Examples surfaced inside the "Learn how to prompt me" disclosure. The
// disclosure replaces the prior 4 starter chips + the randomized SessionTipCard
// + an italic "or try" line — three competing CTAs collapsed into one quiet
// expandable affordance. Buttons populate the input only; they do not submit,
// so the user can edit before sending.
const SIMPLE_EXAMPLES = [
  'Surprise me',
  'Plan a 5-day trip to Moab starting this Saturday',
  'Plan a long weekend somewhere I can swim with my dog',
]

const DESCRIPTIVE_EXAMPLE =
  "Plan a 10-day trip starting June 6th. I want to go from Phoenix up through Sedona and Flagstaff, then over to Durango. I need to be at my sister's house in Santa Fe on day 5, and we'd like a full-hookup site every night since we're traveling with the dog."

function TypingIndicator() {
  return (
    <div className="flex gap-1 items-center px-3 py-2 w-fit">
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
    </div>
  )
}


/** RV-SAFETY-ACK — inline acknowledgment shown directly above the Build button
 *  (replaces the former blocking modal). The user must check this box before the
 *  Build button is enabled. The acknowledgment is still PERSISTED server-side after
 *  the build's stop-creation loop (tripsApi.acknowledgeRvSafety in buildItinerary) —
 *  this checkbox only gates the click; it does not change the build or ack-write flow. */
function RvSafetyInlineAck({ checked, onChange, disabled }: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="flex items-start gap-2 mb-3 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[#F7A829] cursor-pointer disabled:cursor-not-allowed"
      />
      <span className="text-[11px] leading-snug text-gray-500">
        <span className="font-medium text-gray-800">I'm responsible for checking clearance, weight, length &amp; grade for my rig.</span>{' '}
        RoamReady plans the trip; it doesn't guarantee RV-safe roads.
      </span>
    </label>
  )
}

/** AI-PACK-1 treatment for planning chat: an OPENED-but-unterminated
 *  <itinerary> block means the generation was cut off (max_tokens) — the old
 *  fallback silently accepted it, which could persist a partial plan. Now it
 *  parses nothing and reports `truncated` so the UI can say so; a knowingly
 *  truncated itinerary is never built. */
function parseItinerary(text: string): { itinerary: any | null; truncated: boolean } {
  const closed = text.match(/<itinerary>([\s\S]*?)<\/itinerary>/)?.[1]
  if (closed == null) {
    if (/<itinerary>/.test(text)) {
      console.error('[parseItinerary] unterminated <itinerary> block — generation truncated')
      return { itinerary: null, truncated: true }
    }
    return { itinerary: null, truncated: false }
  }
  const inner = closed.trim()
  try { return { itinerary: JSON.parse(inner), truncated: false } } catch {
    const m = inner.match(/\{[\s\S]*\}/)
    if (m) { try { return { itinerary: JSON.parse(m[0]), truncated: false } } catch { /* fall through */ } }
    return { itinerary: null, truncated: false }
  }
}

// ─── Return-leg guard ─────────────────────────────────────────────────────────
// Deterministic post-processing applied to every itinerary the AI emits.
// Three prompt-edit passes failed to make the model reliably default to
// one-way; this guard enforces the behavior in code regardless of what
// the model emits.
//
// RULE: if the conversation contains no explicit round-trip request phrase,
// strip the entire return leg (final home stop + any return-side transit
// stops) so the trip ends at the real destination. If a round-trip phrase IS
// present, return the itinerary unchanged (genuine round trip is kept).
//
// IDENTIFICATION LOGIC:
//   • Turnaround = last DESTINATION-type stop with nights > 0, city ≠ stops[0].
//     Requiring type=DESTINATION is essential: OVERNIGHT_ONLY transit stops exist
//     on BOTH legs; matching any stop with nights > 0 would wrongly select the
//     return-transit stop instead of the real destination.
//   • Return leg = everything after turnaroundIdx (transit + final home stop).
//   • Slice stops[0..turnaroundIdx] removes the whole return leg in one cut.
//
// TOTAL FIXUP after slice:
//   • totalNights: recomputed from sliced stops (exact).
//   • totalMiles, estimatedFuel: nulled out — AI's value was the round-trip
//     total; blank is better than a doubled figure (geocoding corrects this).
//   • estimatedCamp: left alone (downstream code walks per-stop siteRates).
//   • stop.order values: NOT renumbered — remain sequential from the slice,
//     and the server's createStop resequences on insert anyway.

function stripUnrequestedReturnLeg(
  itinerary: any,
  messages: ChatMessage[],
  homeCity?: string | null,
): { itinerary: any; stripped: boolean } {
  // Guard: malformed or trivially short stop list — nothing to strip
  const stops: any[] = itinerary?.stops
  if (!Array.isArray(stops) || stops.length < 2) return { itinerary, stripped: false }

  // BUG-RT-ASSUME-ROUNDTRIP — KEEP the return leg ONLY when the user's language
  // carries POSITIVE round-trip intent (hasRoundTripIntent: "come home", "back
  // home", "and back", "return", "loop", "back to <origin>", etc.). Everything
  // else — explicit one-way AND genuinely AMBIGUOUS ("trip to X from Y", no return
  // signal) — defaults to ONE-WAY and the model's return leg is stripped. This
  // aligns the BUILD path with the prompt's stated one-way default AND with the
  // pre-build BUDGET gate (server/src/controllers/ai.ts), which already resolves
  // ambiguous → ONE_WAY via this SAME hasRoundTripIntent recognizer — so build and
  // budget no longer disagree. (Prior AI-RT-2 logic "trusted the model" on
  // ambiguous and KEPT the leg, which let the model assume a round trip the user
  // never stated — e.g. "Rocky Point from Mesa" became Mesa→Rocky Point→Mesa.) The
  // user adds a return via modify if they want one. Regression-checked by
  // npm run check:round-trip-intent.
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.content)
  if (hasRoundTripIntent(userMessages, [homeCity, stops[0]?.locationName])) {
    return { itinerary, stripped: false }  // positive round-trip intent — KEEP the return leg
  }
  // No positive round-trip intent (one-way OR ambiguous) → strip the return leg.

  // Find turnaround: last DESTINATION-typed stop with nights > 0 that isn't
  // the home city. Requiring type='DESTINATION' is critical: transit stops
  // (OVERNIGHT_ONLY) can appear on BOTH the outbound AND the return leg, so
  // the previous "any stop with nights > 0" check wrongly found the return-
  // transit Albuquerque instead of Denver on a Mesa→Albuq→Denver→Albuq→Mesa
  // itinerary, leaving the dangling return transit in the preview.
  const homeCityNorm = stops[0]?.locationName?.toLowerCase().trim() ?? ''
  let turnaroundIdx = -1
  for (let i = stops.length - 1; i >= 0; i--) {
    const city = (stops[i].locationName ?? '').toLowerCase().trim()
    if (stops[i].type === 'DESTINATION' && (stops[i].nights ?? 0) > 0 && city !== homeCityNorm) {
      turnaroundIdx = i
      break
    }
  }

  // Fallback: no DESTINATION stop with nights > 0 found (e.g. all nights:0) —
  // use any DESTINATION-type stop that isn't the home city
  if (turnaroundIdx === -1) {
    for (let i = stops.length - 1; i >= 0; i--) {
      const city = (stops[i].locationName ?? '').toLowerCase().trim()
      if (stops[i].type === 'DESTINATION' && city !== homeCityNorm) {
        turnaroundIdx = i
        break
      }
    }
  }

  // No-op: no turnaround found, or it's already the final stop (one-way)
  if (turnaroundIdx === -1 || turnaroundIdx === stops.length - 1) return { itinerary, stripped: false }

  const slicedStops = stops.slice(0, turnaroundIdx + 1)
  const totalNights = slicedStops.reduce((n: number, s: any) => n + ((s.nights as number) ?? 0), 0)

  console.log(
    '[stripUnrequestedReturnLeg] stripped return leg:',
    `${stops.length} → ${slicedStops.length} stops,`,
    `destination="${(stops[turnaroundIdx] as any)?.locationName}"`,
  )

  return {
    itinerary: { ...itinerary, stops: slicedStops, totalNights, totalMiles: null, estimatedFuel: null },
    stripped: true,
  }
}

/** Single source of truth for the nights shown to the user: ALWAYS derived
 *  from the (post-guard) stop list, never the model's own totalNights claim —
 *  prose and persisted plan can no longer disagree on the count. */
function nightsFromStops(itinerary: any): number {
  return Array.isArray(itinerary?.stops)
    ? itinerary.stops.reduce((n: number, s: any) => n + (Number(s?.nights) || 0), 0)
    : Number(itinerary?.totalNights) || 0
}

/** Great-circle miles (client copy of the server haversineMiles) — used to pick a
 *  round trip's turnaround (the stop farthest from origin) when coords are present. */
function haversineMilesLocal(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 3958.8
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
}

/** BUG-3 — flexible-until-build title. During planning the displayed title is
 *  DERIVED from the actual destination ("Trip to {dest}"), not the AI's free-text
 *  itinerary.name (which could be a misheard city or go stale). At build this is
 *  persisted as Trip.name (the lock); after build the user renames manually.
 *  The destination = the TURNAROUND (farthest from origin) on a round trip — NOT
 *  the last stop in sequence, which is on the return leg — and the last destination
 *  on a one-way trip. */
function deriveTripTitle(itinerary: any): string | null {
  const stops: any[] = Array.isArray(itinerary?.stops) ? itinerary.stops : []
  if (!stops.length) return null
  const norm = (v?: string) => (v ?? '').toLowerCase().trim()
  const homeName = norm(stops[0]?.locationName)
  // Real destinations = DESTINATION stops, excluding the 0-night return-home closer.
  const realDests = stops.filter((s, i) =>
    s?.type === 'DESTINATION' &&
    !(i === stops.length - 1 && norm(s.locationName) === homeName && (Number(s.nights) || 0) === 0),
  )
  if (!realDests.length) return null

  // ROUND TRIP (last stop returns to the origin city): title = the TURNAROUND,
  // the stop FARTHEST from origin — NOT the last destination in sequence (which is
  // on the RETURN leg; that was BUG-3 picking e.g. "Indianapolis" over "Bangor").
  // ONE-WAY: the last destination is the headline (unchanged).
  const lastStop = stops[stops.length - 1]
  const isRoundTrip = lastStop !== stops[0] && norm(lastStop?.locationName) === homeName

  let dest: any
  if (!isRoundTrip) {
    dest = realDests[realDests.length - 1]
  } else {
    const origin = stops[0]
    const withCoords = realDests.filter(d => d.latitude != null && d.longitude != null)
    if (origin?.latitude != null && origin?.longitude != null && withCoords.length) {
      // Best signal: physically farthest from origin = the turnaround.
      dest = withCoords.reduce((far, d) =>
        haversineMilesLocal(origin.latitude, origin.longitude, d.latitude, d.longitude) >
        haversineMilesLocal(origin.latitude, origin.longitude, far.latitude, far.longitude) ? d : far)
    } else {
      // Planning has no destination coordinates yet → proxy: the headline
      // destination is where the traveler stays longest (most nights; tie → first).
      dest = realDests.reduce((best, d) => ((Number(d.nights) || 0) > (Number(best.nights) || 0)) ? d : best)
    }
  }
  if (!dest?.locationName) return null
  const loc = dest.locationState ? `${dest.locationName}, ${dest.locationState}` : dest.locationName
  return `Trip to ${loc}`
}

// Client-generated deterministic notice (never model text) shown when the
// return-leg guard strips anything — the plan and the narration can no
// longer silently diverge. Tagged _local so it renders as a bubble but is
// NEVER posted back to the AI or persisted.
const ONE_WAY_NOTICE =
  "I planned this one-way. Say 'round trip' if you want the return leg included."
const TRUNCATED_NOTICE =
  'That plan got cut off mid-generation, so I didn\'t keep a partial version — please try again.'

// Declarative correction (STATE-AND-PROCEED, never a question) shown when the
// past-date backstop rolls a mis-yeared start date forward. Both dates are
// 'yyyy-mm-dd'; parseTripDate renders the UTC calendar day correctly.
function pastDateNotice(originalYmd: string, correctedYmd: string): string {
  const pretty = (ymd: string) =>
    parseTripDate(ymd)?.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) ?? ymd
  return `I set the start date to ${pretty(correctedYmd)} since ${pretty(originalYmd)} has already passed.`
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SessionPage() {
  const { id: sessionId } = useParams<{ id: string }>()
  const [hydrating, setHydrating] = useState(true)
  const [hydrationError, setHydrationError] = useState<string | null>(null)
  const [sessionTitle, setSessionTitle] = useState<string | null>(null)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const [itinerary, setItinerary] = useState<any>(null)
  const [creating, setCreating] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [greeting, setGreeting] = useState<string | null>(null)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  // "Learn how to prompt me" disclosure — collapsed by default. Replaces the
  // prior starter chips + randomized tip card + italic fallback line, all of
  // which were competing CTAs under the input.
  const [howOpen, setHowOpen] = useState(false)
  // PLANNING trips fed to the "Continue planning" strip below the empty-state
  // canvas. Fetched once on mount; the strip stays hidden while loading and
  // collapses entirely when the user has zero PLANNING trips (a new user sees
  // only the canvas). Same data source DashboardPage uses (tripsApi.getAll),
  // filtered client-side — no new endpoint.
  const [planningTrips, setPlanningTrips] = useState<Trip[]>([])
  // Full trip set (all statuses) — feeds the Home journal-map discovery card's
  // visited-states derivation, which needs COMPLETED trips (planningTrips alone
  // would undercount). Populated from the same single tripsApi.getAll() below.
  const [allTrips, setAllTrips] = useState<Trip[]>([])
  const [tripsLoading, setTripsLoading] = useState(true)
  // "Add your home base" card (Option 2). homeCardDismissed = local Skip for this
  // session. The card shows for any no-home user on the empty-state hero.
  const [homeCardDismissed, setHomeCardDismissed] = useState(false)
  // Disables the header buttons during the async create/delete dance so a
  // double-tap can't fire two requests or navigate twice.
  const [isProcessing, setIsProcessing] = useState(false)
  // sessionUpdatedAt is bumped on hydration and after autosave settles —
  // shown in the header as "Last edited 5 minutes ago" so the user knows
  // where they left off.
  const [sessionUpdatedAt, setSessionUpdatedAt] = useState<string | null>(null)
  // Block 8 — opens before promote when the user has a rig on file so the
  // modal can ask "are you bringing the toad?" and accept an ad-hoc vehicle.
  // Skipped entirely when the user has no rigs — promote runs straight
  // through with the pre-Block-8 behavior in that case.
  const [confirmVehiclesOpen, setConfirmVehiclesOpen] = useState(false)
  // RV-SAFETY-ACK — inline acknowledgment checkbox shown above the Build button
  // (replaces the former blocking modal). Starts UNCHECKED each fresh planning
  // session; the Build button stays disabled until it's checked. The ack is still
  // persisted server-side after the build's stop loop (unchanged).
  const [rvSafetyAcked, setRvSafetyAcked] = useState(false)
  // RIG-COMPLETENESS NOTICE — non-blocking build-time nudge when the SAVED rig
  // lacks safety dims (no hazard warnings) and/or MPG (approximate fuel cost).
  // Opened in onBuildItineraryClick; independent of the RV-safety ack above.
  const [showRigNotice, setShowRigNotice] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const { user } = useAuthStore()
  const navigate = useNavigate()

  // Apple-style press-to-start / press-to-stop dictation. The hook captures
  // whatever the user has already typed before tapping the mic so dictation
  // extends rather than overwrites. See hooks/useVoiceInput.ts for the
  // continuous + interimResults config.
  const { supported: speechSupported, listening, toggleListening } = useVoiceInput({
    onTranscript: (text) => setInput(text),
    onStart: () => input,
  })

  // BUG-1: the compact ChatInput placeholder clips on narrow screens (field-
  // sizing collapses the empty textarea to one line; a wrapped placeholder's
  // 2nd line is hidden). Show a shorter placeholder below the sm breakpoint
  // (640px) so it fits one line; full text at sm and up. Declared here in the
  // top hook section (above any early return) to keep hook order stable.
  const isSmAndUp = useMediaQuery('(min-width: 640px)')

  // Keep the cursor in the chat box: focus on load AND after each send completes
  // (so the user can keep typing without clicking back into the field).
  //
  // We refocus when `typing` clears rather than from inside sendMessage, because
  // the ChatInput textarea is disabled={typing} while the AI responds — focusing
  // a disabled element is a no-op. Waiting for `typing` to flip back to false
  // means we focus exactly when the field re-enables. The same effect also fires
  // when `hydrating` clears (the input mounts after the loading state), giving
  // us autofocus-on-load for free. Deps are only [hydrating, typing], so this
  // never steals focus on unrelated re-renders (typing in the box, AI render).
  //
  // Gated to fine-pointer (desktop/mouse) devices so we don't pop the on-screen
  // keyboard on touch devices when the page loads. inputRef?.focus() is null-safe
  // when the input isn't mounted yet. NOTE: this also gates refocus-after-send on
  // touch — flip the matchMedia guard if mobile autofocus is wanted.
  useEffect(() => {
    if (hydrating || typing) return
    if (typeof window !== 'undefined' && !window.matchMedia('(pointer: fine)').matches) return
    inputRef.current?.focus()
  }, [hydrating, typing])

  // Warm up the chat notification AudioContext on the first user gesture so the
  // send/reply cues work for the rest of the session (browser autoplay policy
  // blocks audio until the page is interacted with). Mount-once; idempotent.
  useEffect(() => { initChatAudio() }, [])

  // Mark this session as the last one the user actively visited. SessionNewPage's
  // resume-detection uses this to skip the "Resume your last session?" prompt for
  // in-app navigation (e.g. user taps Profile then Plan). Tab close clears
  // sessionStorage automatically so this naturally expires per browser session.
  // Cleared explicitly on cancel + on promote (see handleCancel + the promote
  // success path).
  useEffect(() => {
    if (sessionId) {
      sessionStorage.setItem('lastVisitedSessionId', sessionId)
    }
  }, [sessionId])

  // "New trip" — creates a fresh session and routes to it. The current session
  // STAYS in PLANNING status (not archived) so the user can find it via the
  // Clock-icon SessionsPanel dropdown. Pre-writing lastVisitedSessionId for
  // the NEW session id ensures SessionNewPage's Check A skips the prompt on
  // the next visit if the user bounces through /sessions/new for any reason.
  const handleNewTrip = useCallback(async () => {
    if (isProcessing) return
    setIsProcessing(true)
    try {
      const res = await sessionsApi.create({})
      sessionStorage.setItem('lastVisitedSessionId', res.data.id)
      navigate(`/sessions/${res.data.id}`, { replace: true })
    } catch (err) {
      console.error('[SessionPage] handleNewTrip failed:', err)
      setIsProcessing(false)
    }
  }, [isProcessing, navigate])

  // "Cancel this plan" — soft-deletes (status=ARCHIVED via DELETE) the current
  // session, clears the visit flag, and creates a BRAND-NEW empty session,
  // routing straight to it.
  //
  // SESSION-RESET-1: we deliberately do NOT route through /sessions/new here.
  // SessionNewPage's silent-resume heuristics (Check A = lastVisitedSessionId,
  // Check B = "updated < 5 min ago") can latch onto a stale sibling PLANNING
  // session and resume IT instead of starting fresh — Check B still fires after
  // a cancel (we only clear the Check-A flag). That dragged the cancelled-plan
  // sibling's old conversation into the next request and produced the off-topic
  // refusal (~50%, refresh "fixed" it). An EXPLICIT cancel must always land in a
  // brand-new empty session, never a resumed one — so we create the fresh
  // session directly (mirroring handleNewTrip) and bypass the resume logic.
  const handleCancel = useCallback(async () => {
    if (!sessionId || isProcessing) return
    setIsProcessing(true)
    try {
      await sessionsApi.delete(sessionId)
      sessionStorage.removeItem('lastVisitedSessionId')
      const res = await sessionsApi.create({})
      navigate(`/sessions/${res.data.id}`, { replace: true })
    } catch (err) {
      console.error('[SessionPage] handleCancel failed:', err)
      setIsProcessing(false)
    }
  }, [sessionId, isProcessing, navigate])

  // ── Hydrate session from server ──────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setHydrating(true)
    setHydrationError(null)

    Promise.all([
      sessionsApi.get(sessionId),
      // Used to decide first-time / returning / time-of-day greeting pool.
      // Failure here is non-fatal — we fall back to a time-aware greeting.
      sessionsApi.list().catch(() => ({ data: [] as Awaited<ReturnType<typeof sessionsApi.list>>['data'] })),
    ])
      .then(([res, listRes]) => {
        if (cancelled) return
        const s = res.data
        setSessionTitle(s.title)
        setSessionUpdatedAt(s.updatedAt)
        // FR-RIG-MISMATCH — seed the advisory banner from the server-owned
        // partialTripData, and re-sync this session's dismissal flag.
        setStatedRig(((s as any).partialTripData?.statedRig as string | undefined) ?? null)
        try { setRigBannerDismissed(sessionStorage.getItem(`rig-mismatch-dismissed:${sessionId}`) === '1') } catch { /* ignore */ }
        const raw = Array.isArray(s.messages) ? (s.messages as ChatMessage[]) : []
        // Legacy sessions persisted a seeded assistant "Fill out the form below…"
        // welcome as messages[0]. The chat-first refactor doesn't seed anymore;
        // strip the stale seed on hydration so it doesn't render as a real bubble.
        const persistedMessages = raw.length > 0
          && raw[0].role === 'assistant'
          && raw[0].content.includes('Fill out the form below')
          ? raw.slice(1)
          : raw
        setMessages(persistedMessages)
        if (persistedMessages.length > 0) {
          // Scan ALL assistant messages newest → oldest. If the most recent
          // assistant message is a non-itinerary reply (e.g. a soft-cap nudge
          // turn or a hard-cap canned message), an earlier emitted itinerary
          // block is still recoverable on reload.
          for (let i = persistedMessages.length - 1; i >= 0; i--) {
            const m = persistedMessages[i]
            if (m.role !== 'assistant') continue
            const { itinerary: parsedItin } = parseItinerary(m.content)
            if (parsedItin) {
              // Hydration replays the guard silently (no notice) — the notice
              // belongs to the live generation turn, not every reload.
              setItinerary(stripUnrequestedReturnLeg(parsedItin, persistedMessages, user?.homeCity).itinerary)
              break
            }
          }
        }

        // Pick the greeting once per hydration. Excludes the current session
        // from the prior-session calculation so a brand-new session doesn't
        // count itself as proof the user's been here before.
        const otherSessions = listRes.data.filter(o => o.id !== sessionId)
        const hasAnyPriorSessions = otherSessions.length > 0
        const lastUpdated = otherSessions[0]?.updatedAt
        const daysSinceLastSession = lastUpdated
          ? Math.floor((Date.now() - new Date(lastUpdated).getTime()) / 86_400_000)
          : null
        const { greeting: chosen } = selectGreeting({
          firstName: user?.firstName,
          hasAnyPriorSessions,
          daysSinceLastSession,
          currentDate: new Date(),
        })
        setGreeting(chosen)
      })
      .catch(err => {
        if (cancelled) return
        if (err?.response?.status === 404) {
          setHydrationError('That session was not found. Start a new one from "Plan a trip".')
        } else {
          setHydrationError('Could not load this session. Try again in a moment.')
        }
      })
      .finally(() => {
        if (!cancelled) setHydrating(false)
      })

    return () => { cancelled = true }
  }, [sessionId])

  // ── Autosave ─────────────────────────────────────────────────────────────────
  useSessionAutosave(
    hydrating ? null : sessionId,
    {
      messages,
      // partialTripData is now SERVER-OWNED (holds the captured trip origin for
      // the null-home re-ask fix). The client must NOT send it — the old
      // `partialTripData: {}` here overwrote the column every autosave and would
      // clobber the server-persisted origin. Omitted so the server's value
      // survives; the client never reads it.
      ...(sessionTitle ? { title: sessionTitle } : {}),
    }
  )

  // Keep the latest message in view by scrolling ONLY the message-list
  // container (listRef) — never the window. scrollIntoView (even block:'nearest')
  // walks every scrollable ancestor, and on mobile the dvh-based wrapper height
  // (:844) makes the WINDOW scrollable, so it dragged the non-sticky header and
  // the top of the reply off-screen on the first short reply. Setting the
  // container's own scrollTop contains the scroll to the chat history.
  // Guarded on actual overflow: when the exchange fits, do nothing → the
  // conversation stays top-anchored (anchor-to-top, scroll-only-on-overflow).
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    if (list.scrollHeight > list.clientHeight) {
      list.scrollTop = list.scrollHeight
    }
  }, [messages, typing])

  // Reset the WINDOW scroll on the empty→active transition (first user message
  // sent). On mobile, tapping the empty-state hero input lifts the soft keyboard
  // and the browser scrolls the window down; when the active layout mounts its
  // (now sticky) header at document-top, the leftover window.scrollY would
  // otherwise leave the header/first reply above the viewport. useLayoutEffect
  // runs before paint → no flash of the scrolled position. Must live ABOVE the
  // hydrating/hydrationError early returns (Rules of Hooks); isEmptyState is
  // recomputed locally here since it's derived later in the body. prevEmptyRef
  // gates it to the true→false edge so it only fires on the first user message.
  // Window-only — independent of the message-list scroll (listRef).
  const prevEmptyRef = useRef(true)
  useLayoutEffect(() => {
    const empty = !messages.some(m => m.role === 'user')
    if (prevEmptyRef.current && !empty) window.scrollTo(0, 0)
    prevEmptyRef.current = empty
  }, [messages])

  // Lock body scroll in active-conversation view so the WINDOW can never scroll.
  // The dvh wrapper (:844) makes the document ~110px taller than the visual
  // viewport, so the window becomes scrollable and ends up scrolled down,
  // carrying the (sticky) header + top of the first reply above the fold — and a
  // one-shot scrollTo(0,0) doesn't hold because the browser re-scrolls. With the
  // body locked, only the internal message list (listRef, overflow-y-auto)
  // scrolls. Restored on cleanup / when returning to the empty state. Computes
  // `empty` locally (isEmptyState is derived later); above the early returns.
  useLayoutEffect(() => {
    const empty = !messages.some(m => m.role === 'user')
    if (empty) return
    window.scrollTo(0, 0)            // clear any residual offset before locking
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [messages])

  // Reset window scroll to the top on the hydrating→ready edge, when this page's
  // tall content first mounts. The global <ScrollToTop> fires once on pathname
  // change, which post-login lands while we still show the short `if (hydrating)`
  // spinner; re-applying the reset when content is ready lands it correctly.
  // (Pre-paint useLayoutEffect inside the hook → no jump.) See the hook for the
  // full rationale; window-only, so it never fights the chat's internal scroll.
  useScrollResetOnReady(!hydrating)

  // ── Continue-planning strip data ───────────────────────────────────────────
  // Fetched once on mount. Trips don't change while the user is inside this
  // session (promoting via Build Itinerary navigates away to /trips/:id/map),
  // so a single fetch is enough — no re-fetch on session-id change.
  useEffect(() => {
    let cancelled = false
    tripsApi.getAll()
      .then(res => {
        if (cancelled) return
        const all = res.data as Trip[]
        setAllTrips(all)
        const planning = all
          .filter(t => deriveTripStatus(t) === 'PLANNING')
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        setPlanningTrips(planning)
      })
      .catch(() => { /* non-fatal — strip just stays hidden on error */ })
      .finally(() => {
        if (!cancelled) setTripsLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // The default rig is the seed for the per-trip picker below. After Phase A
  // the prisma include on /users/me orders rigs by isDefault desc, so
  // find(isDefault) reliably returns the user's flagged default; the [0]
  // fallback only kicks in for legacy accounts where no rig has been flagged.
  const defaultRig = user?.rigs?.find(r => r.isDefault) ?? user?.rigs?.[0] ?? null

  // Per-trip rig override. Seeded from defaultRig but the user can pick a
  // different rig (or an ad-hoc rig — see AdHocRig type) for just this trip
  // via the chip dropdown below. Selecting a per-trip rig does NOT write
  // isDefault on any rig; the only thing it changes is which rigId — or
  // adHocVehicle — gets attached to the Trip when buildItinerary fires.
  const [selectedRig, setSelectedRig] = useState<SelectedRig>(() =>
    user?.rigs?.find(r => r.isDefault) ?? user?.rigs?.[0] ?? null
  )

  // Reconcile selectedRig when user.rigs changes (e.g. after a rehydrate
  // following Set-as-default on the rig profile page, or after a delete).
  // If the previously selected rig is no longer in the list, fall back to
  // the current default. Ad-hoc rigs aren't in user.rigs and are preserved.
  useEffect(() => {
    if (!user?.rigs) return
    if (!selectedRig) {
      setSelectedRig(defaultRig)
      return
    }
    if (isAdHocRig(selectedRig)) return
    if (!user.rigs.some(r => r.id === selectedRig.id)) {
      setSelectedRig(defaultRig)
    }
  }, [user?.rigs, defaultRig, selectedRig])

  // ── FR-RIG-MISMATCH — advisory chat-rig vs profile-rig banner ───────────────
  // statedRig = the rig the user stated in chat (a VehicleType enum), captured by
  // the AI into partialTripData.statedRig (already context-filtered server-side:
  // no friend's/hypothetical rigs). Read on hydration and refreshed after each
  // turn. Compared against the rig that GOVERNS this trip's math — the selected
  // rig, else the profile default. This banner is ADVISORY ONLY: it changes no
  // calc/fuel/rigId/planner behavior (those still use the profile rig).
  const [statedRig, setStatedRig] = useState<string | null>(null)
  const [rigBannerDismissed, setRigBannerDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem(`rig-mismatch-dismissed:${sessionId}`) === '1' } catch { return false }
  })
  const dismissRigBanner = () => {
    setRigBannerDismissed(true)
    try { sessionStorage.setItem(`rig-mismatch-dismissed:${sessionId}`, '1') } catch { /* private mode — fine */ }
  }
  // The rig whose vehicleType governs this trip's estimates. Ad-hoc one-off rigs
  // carry no vehicleType, so fall back to the profile default for the comparison.
  const governingRigType: string | null =
    selectedRig && !isAdHocRig(selectedRig) ? selectedRig.vehicleType
      : defaultRig?.vehicleType ?? null
  // Show ONLY on a real mismatch: a rig was stated AND a governing rig exists
  // (skip none / CAR_CAMPING-only) AND they differ AND not dismissed this session.
  const showRigMismatch =
    !!statedRig &&
    !!governingRigType &&
    governingRigType !== 'CAR_CAMPING' &&
    statedRig !== governingRigType &&
    !rigBannerDismissed

  // Rig chip dropdown state — open flag plus the inline ad-hoc-rig form draft.
  const [rigDropdownOpen, setRigDropdownOpen] = useState(false)
  const [adHocFormOpen, setAdHocFormOpen] = useState(false)
  const [adHocYear, setAdHocYear] = useState('')
  const [adHocMake, setAdHocMake] = useState('')
  const [adHocModel, setAdHocModel] = useState('')
  const [adHocLength, setAdHocLength] = useState('')
  const rigChipRef = useRef<HTMLSpanElement>(null)
  // Viewport coordinates of the chip's bottom-left, recomputed on open and
  // on scroll/resize. Used to position the dropdown panel via position:fixed
  // so it escapes the overflow:hidden on the canvas's parent containers
  // (line ~639, "flex flex-1 gap-4 overflow-hidden min-h-0") — those parents
  // would otherwise clip a position:absolute panel before the maxHeight cap
  // could take effect. Null while the dropdown is closed.
  const [chipRect, setChipRect] = useState<{ top: number; left: number } | null>(null)

  // Close the dropdown on outside click and Escape. Listeners only attach
  // while the dropdown is open so they don't tax every page render.
  useEffect(() => {
    if (!rigDropdownOpen) return
    function onDocMouseDown(e: MouseEvent) {
      if (rigChipRef.current && !rigChipRef.current.contains(e.target as Node)) {
        setRigDropdownOpen(false)
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setRigDropdownOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [rigDropdownOpen])

  // Track the chip's viewport-coordinate bottom-left so the position:fixed
  // dropdown panel stays anchored to the chip as the page scrolls or resizes.
  // Fixed positioning is required because the canvas's parent containers use
  // overflow:hidden (see comment on chipRect state above); position:absolute
  // would get clipped by those parents before maxHeight could take effect.
  // The capture-phase scroll listener picks up scroll events on any ancestor,
  // not just window — necessary because the chat column has its own internal
  // scroll. While not open we leave chipRect as null and don't render the
  // panel, so initial-mount measurement isn't needed.
  useEffect(() => {
    if (!rigDropdownOpen) {
      setChipRect(null)
      return
    }
    function update() {
      const el = rigChipRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setChipRect({ top: r.bottom + 4, left: r.left })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [rigDropdownOpen])

  const profile  = user?.travelProfile

  async function sendMessage(overrideText?: string) {
    // ChatInput wires the Send button as `onClick={onSubmit}`, which means
    // React passes the MouseEvent as the first arg when the user clicks.
    // String-override callers (none currently — the disclosure populates the
    // input rather than calling sendMessage directly) must continue to work,
    // so coerce non-strings (the event) to undefined and fall through to
    // `input` instead of calling .trim() on a SyntheticEvent.
    const safeOverride = typeof overrideText === 'string' ? overrideText : undefined
    const text = (safeOverride ?? input).trim()
    if (!text || typing) return
    const userMsg: ChatMessage = { role: 'user', content: text }
    // _local messages are client-generated notices (one-way strip, truncation)
    // — display-only, never posted to the AI or persisted as conversation.
    const next = [...messages.filter(m => !(m as any)._local), userMsg]
    setMessages(next)
    setInput('')
    setTyping(true)

    if (sessionId && !sessionTitle) {
      const title = deriveTitle(text)
      if (title) {
        setSessionTitle(title)
        sessionsApi.update(sessionId, { title }).catch(() => { /* non-fatal */ })
      }
    }

    try {
      // Phase B — plan for the canvas-selected rig (the same one the chip/nudge
      // shows), not just the user's default. Saved rig → rigId; ad-hoc one-off →
      // adHocVehicle. Read fresh each send, so switching rigs mid-conversation
      // affects subsequent messages. null → omitted → server uses the default.
      const rigArg = selectedRig
        ? isAdHocRig(selectedRig)
          ? { adHocVehicle: { year: selectedRig.year, make: selectedRig.make, model: selectedRig.model, length: selectedRig.length } }
          : { rigId: selectedRig.id }
        : undefined
      const res = await aiApi.chat(next, undefined, undefined, sessionId, rigArg)
      const aiText = res.data.message
      const { itinerary: parsedItin, truncated } = parseItinerary(aiText)
      const shown: ChatMessage[] = [...next, { role: 'assistant', content: aiText }]
      // AI-PACK-1: a truncated <itinerary> is never kept — say so visibly.
      if (truncated) shown.push({ role: 'assistant', content: TRUNCATED_NOTICE, _local: true } as any)
      // `next` holds all messages up to and including the current user message —
      // the correct slice to scan for round-trip intent (the AI reply isn't a
      // user message, so it doesn't affect the check).
      if (parsedItin) {
        const { itinerary: kept, stripped } = stripUnrequestedReturnLeg(parsedItin, next, user?.homeCity)
        // PAST-DATE BACKSTOP — if the AI mis-resolved a yearless start date to a
        // past year, roll it forward to the next future occurrence and tell the
        // user. Keeps the previewed/promoted date out of the past so the trip
        // never builds in as "Completed"; the server (promoteSession) backstops
        // any path that bypasses this.
        let finalItin = kept
        if (typeof kept?.startDate === 'string') {
          const { date: corrected, rolled } = rollYmdForwardIfPast(kept.startDate)
          if (rolled) {
            shown.push({ role: 'assistant', content: pastDateNotice(kept.startDate, corrected), _local: true } as any)
            finalItin = { ...kept, startDate: corrected }
          }
        }
        setItinerary(finalItin)
        // No more silent surgery: deterministic client notice whenever the
        // guard removed a return leg.
        if (stripped) shown.push({ role: 'assistant', content: ONE_WAY_NOTICE, _local: true } as any)
      }
      setMessages(shown)
      // FR-RIG-MISMATCH — re-read the server-owned partialTripData so a rig the
      // user just stated this turn surfaces the advisory banner without a reload.
      // Best-effort, non-fatal; never affects the chat turn itself.
      if (sessionId) {
        sessionsApi.get(sessionId)
          .then(r => setStatedRig(((r.data as any).partialTripData?.statedRig as string | undefined) ?? null))
          .catch(() => { /* non-fatal */ })
      }
    } catch (err: any) {
      // FEATURE_GATED 403 — paywall modal already opened by the central
      // axios interceptor. Skip the generic assistant-bubble error so the
      // user isn't double-narrated by the modal AND a chat message.
      if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') {
        return
      }
      // Daily AI cap — per-user (DAILY_USER_CAP) or free-tier (DAILY_LIMIT). The
      // 429 body carries a friendly, code-specific message ("resets in ~X
      // hours" / "upgrade to Pro"); show it verbatim instead of the generic
      // error. Discriminant is data.error (NOT data.code — that's FEATURE_GATED).
      const capError = err?.response?.data?.error
      if (err?.response?.status === 429 && (capError === 'DAILY_USER_CAP' || capError === 'DAILY_LIMIT')) {
        const capMsg = err.response.data?.message || "You've reached today's AI limit — please try again later."
        setMessages([...next, { role: 'assistant', content: capMsg }])
        return
      }
      setMessages([...next, { role: 'assistant', content: 'Sorry, I had trouble responding. Please try again.' }])
    } finally {
      setTyping(false)
    }
  }

  function applyExample(text: string) {
    setInput(text)
    inputRef.current?.focus()
  }

  function onBuildItineraryClick() {
    if (!itinerary || !sessionId || creating) return
    // Close the mobile itinerary bottom sheet the moment the user commits to
    // building. On the phone the Build button lives INSIDE that sheet (z-81);
    // without this, opening the vehicle-confirmation modal (z-50) below would
    // leave it buried behind the still-open sheet. One overlay at a time — the
    // sheet steps aside so the vehicle picker is reachable. Harmless on the
    // no-rig / ad-hoc paths and a no-op on desktop, where the Build button is an
    // in-flow sidebar control.
    //
    // RV-SAFETY-ACK is gated by the INLINE checkbox above this button (the Build
    // button is disabled until it's checked), so by the time this handler runs the
    // user has already acknowledged — no modal step. Go straight into the rig
    // branches below.
    setSheetOpen(false)
    // RIG-COMPLETENESS NOTICE — non-blocking nudge for a SAVED rig that's missing
    // safety dims (no low-bridge/tunnel/weight-limit warnings) and/or MPG
    // (approximate fuel cost). Skipped for ad-hoc rigs (deliberately minimal —
    // year/make/model/length only) and for complete rigs. Fires AFTER the inline
    // RV-safety ack (the Build button is disabled until rvSafetyAcked is checked),
    // so it never touches the ack state/write/reset — it only defers the rig
    // branches until the user picks Add-details / Build-anyway. "Build anyway"
    // calls the SAME proceedToBuild() so the build + ack-write run unchanged.
    if (
      selectedRig && !isAdHocRig(selectedRig) &&
      (missingSafetyDims(selectedRig).length > 0 || missingMpg(selectedRig))
    ) {
      setShowRigNotice(true)
      return
    }
    proceedToBuild()
  }

  // The rig-branch logic, reached either directly from onBuildItineraryClick (rig
  // complete or ad-hoc) or from the completeness notice's "Build anyway". Kept as
  // ONE code path so the ack-write inside buildItinerary always runs the same way.
  function proceedToBuild() {
    // No rig at all → no toad question to ask, no rigId to attach, no
    // ad-hoc vehicle UI useful (the user hasn't set up their profile yet).
    // Promote with empty vehicle data — matches pre-Block-8 behavior so
    // the canvas stays usable for un-onboarded users.
    if (!selectedRig) {
      buildItinerary({ bringingTowed: null, adHocVehicle: null })
      return
    }
    // Phase B — ad-hoc rig picked from the chip dropdown. The
    // ConfirmVehiclesModal expects a real Rig object (with vehicleType,
    // tow fields, etc.) so we skip it here and ride the ad-hoc fields
    // through the adHocVehicle slot. rigId stays null; bringingTowed
    // stays null because there's no toad question to ask for an ad-hoc.
    if (isAdHocRig(selectedRig)) {
      buildItinerary({
        bringingTowed: null,
        adHocVehicle: {
          year: selectedRig.year,
          make: selectedRig.make,
          model: selectedRig.model,
          length: selectedRig.length,
        },
      })
      return
    }
    // Real rig on file → open the modal. It will call buildItinerary with
    // the captured vehicle decisions once the user confirms.
    setConfirmVehiclesOpen(true)
  }

  async function buildItinerary(vehicleData: ConfirmVehiclesResult) {
    // `creating` guard here too (not only in onBuildItineraryClick): the
    // ConfirmVehiclesModal path calls this directly, so a double-confirm
    // click could otherwise start two builds.
    if (!itinerary || !sessionId || creating) return

    // FR-BUILD-GATE — client backstop (defense in depth). The server gate
    // (controllers/ai.ts) now discards any itinerary missing a pinned start date
    // or a real destination, so the client shouldn't normally see one. But never
    // silently promote a dateless / destination-less plan: surface the same
    // "still need X" message instead of building. WHEN keys on a real ISO
    // startDate (the stated-assumption path sets one, so it passes).
    const buildStops = itinerary.stops ?? []
    const isoStart =
      typeof itinerary.startDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(itinerary.startDate)
    const homeNorm = (buildStops[0]?.locationName ?? '').toLowerCase().trim()
    const hasDestination = buildStops.some(
      (s: any) => s?.type === 'DESTINATION' && (s?.locationName ?? '').toLowerCase().trim() !== homeNorm,
    )
    if (!isoStart || !hasDestination) {
      const needs = [
        !hasDestination ? 'a destination' : null,
        !isoStart ? 'a start date' : null,
      ].filter(Boolean).join(' and ')
      setBuildError(`I still need ${needs} before I can build this trip — just let me know in the chat and I'll finish it.`)
      return
    }

    setCreating(true)
    setBuildError(null)
    try {
      const homeStopName = itinerary.stops?.[0]?.type === 'HOME'
        ? itinerary.stops[0].locationName
        : user?.homeLocation || itinerary.stops?.[0]?.locationName || 'Start'

      // BUG-4 Phase 2 — persist the trip shape so consumers stop re-inferring it.
      // `itinerary` here is already POST-strip (stripUnrequestedReturnLeg ran in
      // setItinerary), so the built stops are the ground truth: it's a ROUND_TRIP
      // exactly when the last stop returns to the origin city (matches the
      // isReturnHome shape used by buildLiveTripState / userFacingStopCount),
      // otherwise ONE_WAY.
      const promoteStops = itinerary.stops ?? []
      const firstStop = promoteStops[0]
      const lastStop = promoteStops[promoteStops.length - 1]
      const isRoundTrip =
        promoteStops.length > 1 &&
        !!firstStop && !!lastStop && lastStop !== firstStop &&
        lastStop.locationName?.toLowerCase().trim() === firstStop.locationName?.toLowerCase().trim()
      const tripType: 'ROUND_TRIP' | 'ONE_WAY' = isRoundTrip ? 'ROUND_TRIP' : 'ONE_WAY'

      console.time('[buildItinerary] total')

      console.time('[buildItinerary] promoteSession')
      const promoted = await sessionsApi.promote(sessionId, {
        // BUG-3 — lock the derived destination-tracking title at build (falls back to
        // the AI's name only if no destination resolved). After this, Trip.name is
        // user-owned: manual rename only; a later destination change won't rewrite it.
        name: deriveTripTitle(itinerary) || itinerary.name,
        // DATE-ANCHOR-1: carry the AI-captured departure date through to
        // Trip.startDate so recomputeStopDates anchors stops on it instead of
        // falling back to today. null when the AI emitted no date (no-date
        // trips keep the today fallback). The promote schema accepts startDate.
        startDate: itinerary.startDate ?? null,
        startLocation: homeStopName,
        endLocation: itinerary.stops?.[itinerary.stops.length - 1]?.locationName || 'End',
        totalMiles: itinerary.totalMiles,
        totalNights: nightsFromStops(itinerary),
        estimatedFuel: itinerary.estimatedFuel,
        estimatedCamp: itinerary.estimatedCamp,
        // Block 8 — wire the rig + vehicle decisions into the promote payload.
        // rigId: scout found no caller was setting this before, so every
        //   pre-Block-8 trip has rigId:null and the rig was implicit (the
        //   user's default). We have the rig in hand here, so populate it.
        // bringingTowed + adHocVehicle: collected by the ConfirmVehiclesModal
        //   (or both null when the modal was skipped — no rig on file).
        // Phase B — rigId comes from the per-trip selectedRig (which the user
        // may have overridden via the chip dropdown). Ad-hoc selections route
        // through onBuildItineraryClick above, never through this modal-confirm
        // path, so by the time we get here selectedRig is guaranteed to be a
        // real Rig with a stable id (or null on the no-rig path).
        rigId: selectedRig && !isAdHocRig(selectedRig) ? selectedRig.id : null,
        bringingTowed: vehicleData.bringingTowed,
        adHocVehicle: vehicleData.adHocVehicle,
        // BUG-4 Phase 2 — forward-only: written now, read in Phase 3.
        tripType,
      })
      const tripId = promoted.data.trip.id
      console.timeEnd('[buildItinerary] promoteSession')

      // BUILD-DUPE-1 — the session was already promoted (back-button + Build
      // again): the trip exists complete with its stops, so re-running the
      // build pipeline below would duplicate them. Treat it exactly like a
      // fresh build and land on the itinerary.
      if (promoted.data.alreadyBuilt) {
        console.timeEnd('[buildItinerary] total')
        sessionStorage.removeItem('lastVisitedSessionId')
        navigate(`/trips/${tripId}/map`)
        return
      }

      // The planning transcript is NOT copied to Trip.aiConversation. It lives
      // on PlanningSession.messages (autosaved during planning) and the
      // promoted Trip is linked to its session via Trip.planningSession, so
      // the conversation is fully recoverable through that relation. The
      // continuity bridge into Modify-AI uses Trip.planningContextSummary
      // (a ~250-word distillation generated at promote time), not the full
      // transcript. A prior version of this code wrote `messages` to
      // Trip.aiConversation here via tripsApi.update — that write 400'd
      // silently against the .strict() TripUpdateSchema, which deliberately
      // omits aiConversation as a server-managed field, and nothing in the
      // app read Trip.aiConversation back anyway. Removed.

      const stops: any[] = itinerary.stops || []
      const lastIdx = stops.length - 1
      console.time('[buildItinerary] createStops')
      for (let i = 0; i < stops.length; i++) {
        const stop = stops[i]
        const isEndpoint = i === 0 || i === lastIdx
        const fixedStop = isEndpoint && stop.type === 'OVERNIGHT_ONLY'
          ? { ...stop, type: 'DESTINATION' }
          : stop
        console.time(`[buildItinerary] createStop[${i}] ${stop.locationName}`)
        // skipLongLegCheck — the approved plan ALREADY carries its transit stops
        // (Part 2 step 2 inserted them during planning), so the per-stop drive-time
        // re-check must NOT run during bulk build assembly: it would fire on the
        // half-built (partial) stop list and waste Directions calls. This is the
        // single opt-OUT; every post-build edit re-checks by default.
        await tripsApi.createStop(tripId, { ...fixedStop, skipLongLegCheck: true })
        console.timeEnd(`[buildItinerary] createStop[${i}] ${stop.locationName}`)
      }
      console.timeEnd('[buildItinerary] createStops')

      console.time('[buildItinerary] reassignPOIs')
      await tripsApi.reassignPOIs(tripId)
      console.timeEnd('[buildItinerary] reassignPOIs')

      // PLAN-IS-TRUTH (Part 1) — the built trip must equal the approved plan
      // VERBATIM. createStop above persisted each plan stop exactly as the user
      // approved it; recomputeStopDates (inside createStop's server path) already
      // stamped per-stop dates and Trip.totalNights from those persisted nights.
      //
      // The two after-approval mutators that used to run HERE are deliberately
      // removed:
      //   - expandLongLegs INSERTED OVERNIGHT_ONLY transit stops (phantom stops
      //     the user never approved), and
      //   - reconcileNights TRIMMED/PADDED DESTINATION nights to hit a separately
      //     captured requestedNights total (silently overriding the per-stop plan).
      // Together they made built != approved. With both gone the trip on the map
      // is exactly the plan panel.
      //
      // Part 2 completed this: the deterministic drive-time check now runs DURING
      // PLANNING (transit stops appear in the panel the user approves) and as the
      // shared recheckLongLegs choke point on every post-build stop edit. The old
      // build-time expandLongLegs/reconcileNights controllers + routes were retired;
      // nights are never reconciled away from explicit per-stop intent.

      // RV-SAFETY-ACK — persist the acknowledgment the user gave in the modal
      // BEFORE this build. Done HERE, after the createStop loop (and reassignPOIs),
      // so it lands AFTER every build-time syncTripEndpoints call — which NULLs the
      // field — and therefore survives. Awaited so it's committed before we navigate
      // away; non-fatal on error (the worst case is the modal re-prompts next build).
      try {
        await tripsApi.acknowledgeRvSafety(tripId)
      } catch (err) {
        console.error('[buildItinerary] acknowledgeRvSafety failed (non-fatal):', err)
      }

      tripsApi.generateItinerary(tripId).catch(err =>
        console.error('[buildItinerary] generateItinerary failed in background:', err)
      )

      console.timeEnd('[buildItinerary] total')
      // Session has been promoted; the user is no longer in a planning context.
      // Clear the visit flag so SessionNewPage doesn't try to silent-route them
      // back to a session that's now COMPLETED.
      sessionStorage.removeItem('lastVisitedSessionId')

      // Home-address capture is handled up front by the HomeBaseCard / full-timer
      // flow (and deterministic origin capture), so the build flow goes straight
      // to the map with no opt-in popup.
      navigate(`/trips/${tripId}/map`)
    } catch (e: any) {
      console.error('[buildItinerary] failed:', e)
      // FEATURE_GATED 403 — paywall modal already opened by the central
      // axios interceptor. Clear loading state and bail; do NOT set
      // buildError, because rendering "This feature requires Pro: ..."
      // raw text alongside the modal double-narrates the failure.
      if (e?.response?.status === 403 && e?.response?.data?.code === 'FEATURE_GATED') {
        setCreating(false)
        return
      }
      setBuildError(e?.response?.data?.message || e?.message || 'Something went wrong. Please try again.')
      setCreating(false)
    }
  }


  // Pre-conversation = the user hasn't sent anything yet. Using "no user
  // message" (rather than messages.length===0) also covers any edge case where
  // an assistant-only message lingers from older builds. Derived here, ABOVE
  // the early returns, because the SESS-LAYOUT-2 hooks below depend on it.
  const isEmptyState = !messages.some(m => m.role === 'user')

  // ONBOARDING — the AI has asked something and it's the user's turn: not mid-
  // generation, and the last message is the assistant's. Drives the action
  // placeholder + the gentle "your turn" pulse on the compact input, so older
  // users realize they need to type a reply (e.g. the origin question).
  const awaitingReply =
    !typing && messages.length > 0 && messages[messages.length - 1].role === 'assistant'

  // SESS-LAYOUT-2 — measured chat-column height. The previous hardcoded
  // h-[calc(100dvh-12.25rem)] subtracted a fixed chrome list (header + main
  // paddings + bottom nav) that silently went stale whenever anything ELSE
  // occupied vertical space — the in-flow VerificationBanner (AppLayout)
  // being the live case: with it mounted, the column over-filled by the
  // banner height and the composer rendered below the viewport edge.
  // Measuring the column's real top edge makes the height correct with the
  // banner present AND absent, and re-measuring on resize + body layout
  // shifts covers banner dismissal and mobile Safari's URL-bar expand /
  // collapse (dvh + a live re-measure). Only the BOTTOM reserve stays as a
  // constant pair (main's pb-32 mobile / pb-6 desktop — the bottom-nav
  // clearance), matching AppLayout's main padding.
  //
  // RULES-OF-HOOKS: this cluster MUST live above the hydrationError /
  // hydrating early returns below — it originally sat after them and crashed
  // every load with "Rendered more hooks than during the previous render"
  // (hooks ran on post-hydration renders only). tsc and vite CANNOT catch
  // this; it only surfaces at runtime. New hooks on this page always go in
  // this unconditional top section. The effect no-ops safely while the ref
  // is unattached (early-return renders never mount the chat column).
  const chatColRef = useRef<HTMLDivElement>(null)
  const [chatColHeight, setChatColHeight] = useState<string | null>(null)
  useEffect(() => {
    if (isEmptyState) { setChatColHeight(null); return }
    const el = chatColRef.current
    if (!el) return
    const measure = () => {
      const top = el.getBoundingClientRect().top + window.scrollY
      const md = window.matchMedia('(min-width: 768px)').matches
      const bottomReserve = md ? 24 : 128 // main pb-6 desktop / pb-32 mobile
      setChatColHeight(`calc(100dvh - ${Math.max(0, Math.round(top))}px - ${bottomReserve}px)`)
    }
    measure()
    window.addEventListener('resize', measure)
    // Catches in-flow chrome changes above the column (verification banner
    // mounting/dismissing) without polling.
    const ro = new ResizeObserver(measure)
    ro.observe(document.body)
    return () => { window.removeEventListener('resize', measure); ro.disconnect() }
  }, [isEmptyState, hydrating])

  if (hydrationError) {
    return (
      <div className="max-w-md mx-auto mt-12 text-center">
        <p className="text-sm text-gray-700 mb-4">{hydrationError}</p>
        <button onClick={() => navigate('/sessions/new')} className="btn-primary">
          Plan a new trip
        </button>
      </div>
    )
  }

  if (hydrating) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        <Loader size={20} className="animate-spin" />
      </div>
    )
  }

  // ── Rig context chip strip pieces (only rendered in empty state) ───────────
  // Phase B — the chip reads selectedRig (per-trip override), not the user's
  // global default. selectedRig may be a real Rig or an AdHocRig; both have
  // year/make/model/length so the same derivation works for either.
  const rigName = selectedRig ? rigDisplayName(selectedRig) : ''
  const rigChipText = rigName
    ? selectedRig?.length
      ? `${rigName} (${selectedRig.length}ft)`
      : rigName
    : ''
  const hasMultipleRigs = (user?.rigs?.length ?? 0) > 1
  // Party chip — read the STRUCTURED default travel party (people + pets), the
  // same source the itinerary/packing already use, falling back to the legacy
  // travelProfile counts ONLY when there's no party. Mirrors the server's
  // resolution in services/ai.ts (party = tripParty ?? defaultParty ?? legacy).
  // Fixes BUG-PARTY-CHIP-LEGACY-COUNT, where the chip showed stale profile
  // counts (e.g. "12 adults, pets") that disagreed with the real party.
  const partyChipText = (() => {
    const defaultParty = user?.parties?.find(p => p.isDefault) ?? user?.parties?.[0] ?? null
    if (defaultParty) {
      const travelingPeople = (defaultParty.people ?? []).filter(p => p.isTraveling)
      const adults = travelingPeople.filter(p => p.role === 'ADULT' || p.role === 'TEEN').length
      const children = travelingPeople.filter(p => p.role === 'CHILD' || p.role === 'INFANT').length
      const hasPets = (defaultParty.pets?.length ?? 0) > 0
      // Guard: a party with 0 traveling adults/teens (shouldn't happen) falls
      // through to the legacy count rather than rendering "0 adults".
      if (adults > 0) {
        const parts = [`${adults} adult${adults !== 1 ? 's' : ''}`]
        if (children > 0) parts.push(`${children} kid${children !== 1 ? 's' : ''}`)
        if (hasPets) parts.push('pets')
        return parts.join(', ')
      }
    }
    // Legacy fallback — no structured party (or an empty one): the original
    // travelProfile-derived string, exactly as before.
    return profile
      ? `${profile.adults} adult${profile.adults !== 1 ? 's' : ''}${profile.hasPets ? ', pets' : ''}`
      : ''
  })()
  const styleChipText = profile?.hookupPreference
    ? profile.hookupPreference.replace(/_/g, ' ').toLowerCase()
    : ''
  const showRigStrip = !!(rigChipText || partyChipText || styleChipText)

  // Most recent 3 PLANNING trips for the strip below the canvas. Sorted by
  // updatedAt desc in the fetch effect.
  const recentPlanning = planningTrips.slice(0, 3)
  const showContinueStrip = isEmptyState && !tripsLoading && planningTrips.length > 0
  // The Journal Maps discovery card shows in the same empty-state Home area, but
  // (unlike the strip) also for users with zero PLANNING trips — its empty state
  // ("no states traveled yet") is the point.
  const showTravelMap = isEmptyState && !tripsLoading
  // "Add your home base" card: shown to ANY no-home user on the empty-state hero,
  // regardless of trip count. Keys purely on no-home-saved + empty-state + not-
  // dismissed-this-session. Saving sets user.homeLocation → this flips false →
  // card unmounts. Skip = local dismiss.
  const showHomeCard = isEmptyState && !user?.homeLocation && !user?.isFullTimeRVer && !user?.dismissedHomePrompt && !homeCardDismissed

  return (
    <>
    {/* Outer wrapper height — active-conversation only (the chat history needs a
        DEFINITE parent height so its flex-1 overflow-y-auto resolves and the
        input pins to the bottom).

        Why a viewport calc and not h-full/min-h-full: the parent <main>
        (AppLayout) is `flex-1` but is NOT itself a flex container, so its
        `height` property is `auto` — a child `height:100%`/`min-height:100%`
        resolves against auto and COLLAPSES to content height (the wrapper sized
        to the conversation, so Δ/GAP shrank as it grew). So size to the viewport
        directly, subtracting the FULL chrome chain ONCE:
          app header ~3.75rem (h-14 56px + 0.5px border + h-1 gradient 4px)
          + main pt-2 (0.5rem) + main pb-32 (8rem mobile) = 12.25rem
          ·  md: header (3.5) + pt-6 (1.5) + pb-6 (1.5) = 6.5rem.
        On mobile the header is now position:fixed, so its ~3.75rem is reserved
        as the app-shell's pt-[3.75rem] (AppLayout) instead of an in-flow header
        — the space is still subtracted here, just sourced from shell padding.
        That equals exactly main's content box, so the wrapper fills it (constant
        Δ/GAP regardless of length) WITHOUT exceeding it — no taller-than-viewport
        document, so iOS has nothing to scroll on keyboard-focus (winY stays 0).
        The bottom-nav clearance is still reserved ONCE (main's pb-32, the 8rem
        term here matches it). The prior min-h-[calc(100dvh-8rem)] under-subtracted
        (only the nav, missing header+pt) → 80px too tall → overflow → the 422px
        keyboard scroll; min-h-full then under-filled. This is the corrected value.
        In empty state we drop the lock so the hero + Continue-planning strip
        stack to natural height.

        Mobile is now a DEFINITE `h-` (was `min-h-`): with the input pinned
        (position:fixed, below) the chat column must give the flex-1 message list
        a bounded box so it scrolls INTERNALLY between the fixed header and the
        fixed input — min-h let the column grow with the conversation and rode the
        in-flow input off-screen. md keeps its existing definite `h` (input in-flow).

        SESS-LAYOUT-2 (fourth pass on this bug class — see history above:
        min-h-[calc(100dvh-8rem)] under-subtracted, min-h-full under-filled,
        then the corrected static calc went stale the moment the in-flow
        VerificationBanner added chrome the arithmetic didn't know about and
        the composer clipped below the viewport). The static calc classes
        below remain ONLY as the first-paint fallback; the measured height
        from the SESS-LAYOUT-2 effect overrides them via inline style and is
        the value that actually governs — it derives the top edge from the
        real layout instead of a hardcoded chrome list, so banner present/
        absent and Safari URL-bar states all resolve correctly. */}
    <div
      ref={chatColRef}
      className={`flex flex-col${isEmptyState ? '' : ' h-[calc(100dvh-12.25rem)] md:h-[calc(100dvh-6.5rem)]'}`}
      style={!isEmptyState && chatColHeight ? { height: chatColHeight } : undefined}
    >
      {/* Header row — title + last-edited timestamp on the left, "New trip" /
          "Cancel this plan" actions on the right. Hidden in the empty state
          because no plan exists yet, so "Cancel this plan" is meaningless and
          "+ New trip" is redundant (the whole canvas IS for starting a trip);
          also removes ~48px of vertical chrome so the greeting starts higher.
          The header is rendered only once the user has sent something — the
          moment a plan actually exists to title, timestamp, restart, or
          discard. The block below is preserved exactly as-is for the active
          conversation. */}
      {!isEmptyState && (
        <div
          className="sticky top-0 z-10 bg-white flex justify-between items-center px-4 py-2 border-b border-gray-100"
          style={{ borderBottomWidth: '0.5px' }}
        >
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-900 truncate">
              {sessionTitle || 'Planning your trip'}
            </div>
            {sessionUpdatedAt && (
              <div className="text-xs text-gray-500 mt-0.5">
                Last edited {relativeTime(sessionUpdatedAt)}
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-shrink-0">
            {/* Report an issue — this page is a planning SESSION (no built trip
                yet), so it tags the feedback with sessionId; the admin link
                routes that to the inspector's session lookup. */}
            <button
              type="button"
              onClick={() => useUIStore.getState().openFeedbackModal('BUG_REPORT', { sessionId })}
              className="px-3 py-1.5 text-xs border border-gray-200 rounded-md hover:bg-gray-50 flex items-center gap-1"
            >
              <Flag size={13} />
              Report an issue
            </button>
            <button
              type="button"
              onClick={handleNewTrip}
              disabled={isProcessing}
              className="px-3 py-1.5 text-xs border border-gray-200 rounded-md hover:bg-gray-50 flex items-center gap-1 disabled:opacity-50"
            >
              <Plus size={13} />
              New trip
            </button>
            <button
              type="button"
              onClick={() => setShowCancelConfirm(true)}
              disabled={isProcessing}
              className="px-3 py-1.5 text-xs border border-red-200 text-red-700 rounded-md hover:bg-red-50 flex items-center gap-1 disabled:opacity-50"
            >
              <X size={13} />
              Cancel this plan
            </button>
          </div>
        </div>
      )}

      {/* Main area: chat column + optional itinerary sidebar */}
      <div className="flex flex-1 gap-4 overflow-hidden min-h-0">

        <div className="flex-1 flex flex-col overflow-hidden min-h-0">

          {isEmptyState ? (
            // ── Pre-conversation: hero greeting + chips + input + tip + watermark.
            //    Layout dropped flex-1/justify-center (which forced vertical centering
            //    inside a viewport-tall parent and pushed the Continue-planning sibling
            //    strip below the fold). Now the content stacks from the top at its
            //    natural height, and the strip lives right beneath it. `relative` makes
            //    this the positioning context for the watermark — which is absolutely
            //    positioned behind the content (see below) so it doesn't add flow height.
            <div className="relative flex flex-col items-center px-2 pt-0 pb-24 overflow-hidden">
              {/* Watermark — absolutely positioned at the bottom of the hero area,
                  behind everything else. Rendered first so subsequent in-flow content
                  naturally paints on top (no z-index acrobatics needed). Sized to
                  always fit within the hero's pb-24 (96px) so its top edge never
                  crosses the disclosure above — at the max clamp (72px) there's a
                  ~24px clearance to the disclosure's bottom; at narrower viewports
                  the watermark gets smaller and the clearance grows. Previously
                  clamp(48,12vw,120) overlapped the disclosure noticeably. */}
              <div
                aria-hidden="true"
                className="pointer-events-none select-none overflow-hidden text-center absolute left-0 right-0 bottom-0"
                // opacity is intentionally inline + full (1) for now so it's a
                // one-line dial-down after seeing it on device (likely ~0.4–0.6).
                style={{ opacity: 1 }}
              >
                <img
                  src="/roamready-wordmark.svg"
                  alt=""
                  className="inline-block"
                  // Match the OLD text watermark's exact responsive sizing:
                  // height tracks the former fontSize clamp(36px,7vw,72px) — same
                  // mobile floor (36px), 7vw mid-range, desktop cap (72px). width
                  // auto keeps the wordmark's aspect ratio.
                  style={{ height: 'clamp(36px, 7vw, 72px)', width: 'auto' }}
                />
              </div>

              {/* Hero greeting */}
              {greeting && (
                <h1
                  className="text-center mx-auto pt-4 md:pt-8"
                  style={{
                    maxWidth: 720,
                    fontSize: 'clamp(22px, 4vw, 28px)',
                    fontWeight: 500,
                    color: '#2C2C2A',
                    letterSpacing: '-0.01em',
                    lineHeight: 1.3,
                  }}
                >
                  {greeting}
                </h1>
              )}

              {/* Rig context chip strip */}
              {showRigStrip && (
                <div
                  role="group"
                  aria-label="Trip context"
                  className="inline-flex flex-wrap items-center justify-center bg-white"
                  style={{
                    border: '0.5px solid #E8E4DA',
                    borderRadius: 8,
                    padding: '7px 14px',
                    gap: 14,
                    marginTop: 14,
                    marginBottom: 32,
                    fontSize: 12,
                    color: '#134756',
                  }}
                >
                  {/* Phase B — rig chip becomes a tappable dropdown for users
                      with multiple rigs. Single-rig users get the static span
                      with no chevron, identical to the original look. The
                      dropdown lets the user pick a different rig (or define
                      an ad-hoc one) for THIS trip without changing the global
                      default — selecting only updates selectedRig in local
                      state, which flows into the promote payload's rigId (or
                      adHocVehicle) and never writes Rig.isDefault. */}
                  {rigChipText && (
                    <span
                      ref={rigChipRef}
                      className="inline-flex items-center"
                      style={{ position: 'relative', gap: 6 }}
                    >
                      {hasMultipleRigs ? (
                        <button
                          type="button"
                          onClick={() => setRigDropdownOpen(o => !o)}
                          aria-haspopup="listbox"
                          aria-expanded={rigDropdownOpen}
                          className="transition-colors"
                          style={{
                            ...CONTEXT_CHIP_STYLE,
                            // Multi-rig discoverability: a calm info tint + soft
                            // blue border at rest marks this as the interactive,
                            // switchable chip (vs. the quiet white travelers /
                            // hookup chips). Open state is unchanged.
                            background: rigDropdownOpen ? '#E0F0F4' : '#F2F8FA',
                            border: rigDropdownOpen ? '0.5px solid #1F6F8B' : '0.5px solid #B8DCE5',
                            cursor: 'pointer',
                          }}
                        >
                          <MapPin size={14} aria-hidden="true" color="#1F6F8B" />
                          {rigChipText}
                          {rigDropdownOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                      ) : (
                        <span style={CONTEXT_CHIP_STYLE}>
                          <MapPin size={14} aria-hidden="true" color="#1F6F8B" />
                          {rigChipText}
                        </span>
                      )}

                      {rigDropdownOpen && hasMultipleRigs && chipRect && (
                        <div
                          role="listbox"
                          aria-label="Pick a rig for this trip"
                          style={{
                            // position:fixed instead of absolute so the panel
                            // escapes the overflow:hidden on the canvas's
                            // parent containers (which clipped the original
                            // absolute version regardless of maxHeight). top
                            // and left come from the chip's bounding rect,
                            // recomputed on scroll/resize so the panel tracks
                            // the chip rather than floating off-screen when
                            // the page moves under it.
                            position: 'fixed',
                            top: chipRect.top,
                            left: chipRect.left,
                            minWidth: 260,
                            // Cap the panel height so the ad-hoc form's
                            // Cancel / Use-for-this-trip buttons never spill
                            // past the viewport — the panel scrolls
                            // internally when the content exceeds the cap.
                            // Effective now that the parent's overflow:hidden
                            // is no longer doing the clipping.
                            maxHeight: 'calc(100vh - 200px)',
                            overflowY: 'auto',
                            background: 'white',
                            border: '0.5px solid #E8E4DA',
                            borderRadius: 6,
                            padding: 4,
                            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
                            zIndex: 50,
                            textAlign: 'left',
                          }}
                        >
                          <div
                            style={{
                              padding: '6px 10px',
                              fontSize: 11,
                              fontWeight: 600,
                              letterSpacing: 0.3,
                              textTransform: 'uppercase',
                              color: '#888',
                            }}
                          >
                            Which rig are you taking?
                          </div>

                          {user?.rigs?.map(r => {
                            const isSelected =
                              selectedRig != null && !isAdHocRig(selectedRig) && selectedRig.id === r.id
                            const display =
                              [r.year, r.make, r.model].filter(Boolean).join(' ').trim() ||
                              VEHICLE_LABELS[r.vehicleType]
                            const secondary: string[] = [VEHICLE_LABELS[r.vehicleType]]
                            if (r.length) secondary.push(`${r.length}ft`)
                            if (r.isDefault) secondary.push('default')
                            return (
                              <button
                                key={r.id}
                                type="button"
                                role="option"
                                aria-selected={isSelected}
                                onClick={() => {
                                  setSelectedRig(r)
                                  setRigDropdownOpen(false)
                                  setAdHocFormOpen(false)
                                }}
                                style={{
                                  display: 'flex',
                                  alignItems: 'flex-start',
                                  gap: 8,
                                  width: '100%',
                                  padding: '8px 10px',
                                  borderRadius: 4,
                                  background: isSelected ? '#E0F0F4' : 'transparent',
                                  border: 'none',
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  color: '#134756',
                                }}
                              >
                                <span style={{ width: 14, flexShrink: 0, paddingTop: 2 }}>
                                  {isSelected && <Check size={14} color="#1F6F8B" />}
                                </span>
                                <span style={{ flex: 1, minWidth: 0 }}>
                                  <span style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{display}</span>
                                  <span
                                    style={{
                                      display: 'block',
                                      fontSize: 11,
                                      color: '#5F6B57',
                                      marginTop: 1,
                                    }}
                                  >
                                    {secondary.join(' · ')}
                                  </span>
                                </span>
                              </button>
                            )
                          })}

                          {/* Add a different rig — inline form for an ad-hoc
                              rig that's used for this trip only and never
                              saved to /users/me. Matches the AdHocVehicle
                              pattern in ConfirmVehiclesModal. */}
                          {!adHocFormOpen ? (
                            <button
                              type="button"
                              onClick={() => setAdHocFormOpen(true)}
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 8,
                                width: '100%',
                                padding: '8px 10px',
                                borderRadius: 4,
                                background: 'transparent',
                                border: 'none',
                                cursor: 'pointer',
                                textAlign: 'left',
                              }}
                            >
                              <span style={{ width: 14, flexShrink: 0 }} />
                              <span style={{ flex: 1, minWidth: 0 }}>
                                <span
                                  style={{
                                    display: 'block',
                                    fontSize: 13,
                                    fontWeight: 500,
                                    color: '#1F6F8B',
                                  }}
                                >
                                  Add a different rig
                                </span>
                                <span
                                  style={{
                                    display: 'block',
                                    fontSize: 11,
                                    color: '#5F6B57',
                                    marginTop: 1,
                                  }}
                                >
                                  Just for this trip, won't save to profile.
                                </span>
                              </span>
                              <Plus size={14} color="#1F6F8B" style={{ flexShrink: 0, marginTop: 2 }} />
                            </button>
                          ) : (
                            <div
                              style={{
                                padding: '8px 10px',
                                margin: '4px 0',
                                background: '#F9F7F2',
                                borderRadius: 4,
                              }}
                            >
                              <p
                                style={{
                                  fontSize: 11,
                                  color: '#5F6B57',
                                  marginBottom: 6,
                                  fontStyle: 'italic',
                                }}
                              >
                                Just for this trip — not saved to your profile.
                              </p>
                              <div
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: 'repeat(3, 1fr)',
                                  gap: 4,
                                  marginBottom: 4,
                                }}
                              >
                                <input
                                  className="input"
                                  style={{ fontSize: 11, padding: '4px 6px' }}
                                  placeholder="Year"
                                  type="number"
                                  value={adHocYear}
                                  onChange={e => setAdHocYear(e.target.value)}
                                />
                                <input
                                  className="input"
                                  style={{ fontSize: 11, padding: '4px 6px' }}
                                  placeholder="Make"
                                  value={adHocMake}
                                  onChange={e => setAdHocMake(e.target.value)}
                                />
                                <input
                                  className="input"
                                  style={{ fontSize: 11, padding: '4px 6px' }}
                                  placeholder="Model"
                                  value={adHocModel}
                                  onChange={e => setAdHocModel(e.target.value)}
                                />
                              </div>
                              <input
                                className="input"
                                style={{
                                  fontSize: 11,
                                  padding: '4px 6px',
                                  marginBottom: 6,
                                  width: '100%',
                                }}
                                placeholder="Length (ft)"
                                type="number"
                                step="0.1"
                                value={adHocLength}
                                onChange={e => setAdHocLength(e.target.value)}
                              />
                              <div
                                style={{
                                  display: 'flex',
                                  gap: 4,
                                  justifyContent: 'flex-end',
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setAdHocFormOpen(false)
                                    setAdHocYear('')
                                    setAdHocMake('')
                                    setAdHocModel('')
                                    setAdHocLength('')
                                  }}
                                  style={{
                                    fontSize: 11,
                                    padding: '4px 8px',
                                    borderRadius: 4,
                                    background: 'transparent',
                                    border: '0.5px solid #E8E4DA',
                                    color: '#5F6B57',
                                    cursor: 'pointer',
                                  }}
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    // Build the ad-hoc rig from the form
                                    // fields. Require at least one populated
                                    // field so an empty Cancel-by-accident
                                    // doesn't replace the selection with a
                                    // blank rig.
                                    const adHoc: AdHocRig = { isAdHoc: true }
                                    if (adHocYear.trim()) {
                                      const y = parseInt(adHocYear.trim(), 10)
                                      if (!isNaN(y)) adHoc.year = y
                                    }
                                    if (adHocMake.trim()) adHoc.make = adHocMake.trim()
                                    if (adHocModel.trim()) adHoc.model = adHocModel.trim()
                                    if (adHocLength.trim()) {
                                      const l = parseFloat(adHocLength.trim())
                                      if (!isNaN(l)) adHoc.length = l
                                    }
                                    if (
                                      adHoc.year == null &&
                                      !adHoc.make &&
                                      !adHoc.model &&
                                      adHoc.length == null
                                    ) {
                                      return
                                    }
                                    setSelectedRig(adHoc)
                                    setRigDropdownOpen(false)
                                    setAdHocFormOpen(false)
                                  }}
                                  style={{
                                    fontSize: 11,
                                    padding: '4px 8px',
                                    borderRadius: 4,
                                    background: '#1F6F8B',
                                    border: 'none',
                                    color: 'white',
                                    cursor: 'pointer',
                                  }}
                                >
                                  Use for this trip
                                </button>
                              </div>
                            </div>
                          )}

                          <div style={{ height: 1, background: '#E8E4DA', margin: '4px 0' }} />

                          <Link
                            to="/profile/rig"
                            onClick={() => setRigDropdownOpen(false)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '8px 10px',
                              fontSize: 12,
                              color: '#1F6F8B',
                              textDecoration: 'none',
                              borderRadius: 4,
                            }}
                          >
                            <span style={{ width: 14, flexShrink: 0 }} />
                            Manage rigs in Profile ↗
                          </Link>
                        </div>
                      )}
                    </span>
                  )}
                  {/* POLISH-1 (PR-9) — these chips share the rig chip's button
                      styling, so they READ as tappable. Make them tappable:
                      party → Travel Party, style → Travel Style. */}
                  {partyChipText && (
                    <Link to="/profile/party" style={CONTEXT_CHIP_STYLE} title="Edit your travel party">
                      <Users size={14} aria-hidden="true" color="#1F6F8B" />
                      {partyChipText}
                    </Link>
                  )}
                  {styleChipText && (
                    <Link to="/profile/style" style={CONTEXT_CHIP_STYLE} title="Edit your travel style">
                      <Tent size={14} aria-hidden="true" color="#1F6F8B" />
                      {styleChipText}
                    </Link>
                  )}
                </div>
              )}

              {/* Multi-rig discoverability nudge — a calm one-line hint directly
                  below the chip row pointing at the (emphasized) rig chip. Light
                  nudge only: muted text, no action required. Single-rig users
                  never see this (hasMultipleRigs gate). Negative marginTop pulls
                  it up under the strip's marginBottom so it reads as attached to
                  the row, not floating. */}
              {hasMultipleRigs && rigChipText && (
                <p
                  className="flex items-center justify-center gap-1 text-center"
                  style={{ marginTop: -20, marginBottom: 24, fontSize: 13, color: '#888780' }}
                >
                  <Info size={13} aria-hidden="true" color="#1F6F8B" />
                  Planning for your {rigName} — tap the rig to switch.
                </p>
              )}

              <div className="w-full max-w-[600px]">
                {/* Option-2 first-trip home-base card — no-home user, no trip
                    built yet. Sits above the hero input; self-terminates once
                    home is saved (gate flips) or Skip is tapped (local state). */}
                {showHomeCard && <HomeBaseCard onSkip={() => setHomeCardDismissed(true)} />}
                <ChatInput
                  ref={inputRef}
                  value={input}
                  onChange={setInput}
                  onSubmit={sendMessage}
                  placeholder="Tell me about your trip — where, when, who's coming, anything special..."
                  disabled={typing}
                  loading={typing}
                  speechSupported={speechSupported}
                  listening={listening}
                  onToggleListening={toggleListening}
                  variant="hero"
                  // "Start here" pulse — this hero block only renders on a fresh
                  // new-session screen, so isAwaiting here means exactly that. It
                  // self-suppresses on focus/typing; !typing avoids pulsing during
                  // the first send's in-flight flash. (Pulse is on the textarea,
                  // not the wrapper — iOS-safe; see ChatInput hero return.)
                  isAwaiting={!typing}
                />

                {/* Learn how to prompt me — single quiet disclosure that replaces the
                    prior chip row, randomized tip card, and italic fallback line. Default
                    collapsed; clicking the header expands to show Simple + Descriptive
                    example sections. Each example button populates the input (no submit)
                    so the user can edit before sending — same pattern the chips used. */}
                <div style={{ marginTop: 20 }}>
                  <button
                    type="button"
                    onClick={() => setHowOpen(v => !v)}
                    aria-expanded={howOpen}
                    aria-controls="how-to-prompt-panel"
                    className="w-full text-left transition-colors bg-white"
                    style={{
                      border: '0.5px solid #E8E4DA',
                      borderRadius: howOpen ? '8px 8px 0 0' : 8,
                      padding: '11px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      fontSize: 13,
                      color: '#5F5E5A',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#FBFAF8' }}
                    onMouseLeave={e => { e.currentTarget.style.backgroundColor = '#FFFFFF' }}
                  >
                    <Sparkles size={14} color="#1F6F8B" aria-hidden="true" />
                    <span style={{ flex: 1 }}>Learn how to prompt me</span>
                    {howOpen
                      ? <ChevronUp size={14} color="#888780" aria-hidden="true" />
                      : <ChevronDown size={14} color="#888780" aria-hidden="true" />}
                  </button>

                  {howOpen && (
                    <div
                      id="how-to-prompt-panel"
                      className="bg-white"
                      style={{
                        border: '0.5px solid #E8E4DA',
                        borderTop: 'none',
                        borderRadius: '0 0 8px 8px',
                        padding: '14px 14px 12px',
                      }}
                    >
                      {/* SIMPLE section */}
                      <div style={{ marginBottom: 16 }}>
                        <div className="flex items-baseline" style={{ gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#2C2C2A', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                            Simple
                          </span>
                          <span style={{ fontSize: 11, color: '#888780', fontStyle: 'italic' }}>
                            quick &amp; casual
                          </span>
                        </div>
                        <div className="flex flex-col" style={{ gap: 6 }}>
                          {SIMPLE_EXAMPLES.map(text => (
                            <button
                              key={text}
                              type="button"
                              onClick={() => applyExample(text)}
                              className="text-left transition-colors"
                              style={{
                                background: 'transparent',
                                border: '0.5px solid #E8E4DA',
                                borderRadius: 6,
                                padding: '8px 12px',
                                fontSize: 13,
                                color: '#5F5E5A',
                                cursor: 'pointer',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#F5F4F2' }}
                              onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
                            >
                              {text}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* DESCRIPTIVE section */}
                      <div>
                        <div className="flex items-baseline" style={{ gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#2C2C2A', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                            Descriptive
                          </span>
                          <span style={{ fontSize: 11, color: '#888780', fontStyle: 'italic' }}>
                            the more you tell me, the better
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => applyExample(DESCRIPTIVE_EXAMPLE)}
                          className="text-left transition-colors w-full"
                          style={{
                            background: 'transparent',
                            border: '0.5px solid #E8E4DA',
                            borderRadius: 6,
                            padding: '10px 12px',
                            fontSize: 13,
                            color: '#5F5E5A',
                            lineHeight: 1.5,
                            cursor: 'pointer',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#F5F4F2' }}
                          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
                        >
                          {DESCRIPTIVE_EXAMPLE}
                        </button>
                      </div>

                      {/* Show less */}
                      <div style={{ marginTop: 12, textAlign: 'center' }}>
                        <button
                          type="button"
                          onClick={() => setHowOpen(false)}
                          className="transition-colors"
                          style={{
                            background: 'transparent',
                            border: 'none',
                            fontSize: 12,
                            color: '#1F6F8B',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            textDecoration: 'underline',
                            textUnderlineOffset: 2,
                          }}
                          onMouseEnter={e => { e.currentTarget.style.color = '#134756' }}
                          onMouseLeave={e => { e.currentTarget.style.color = '#1F6F8B' }}
                        >
                          Show less
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Below-the-fold cue: the Continue-planning strip sits beneath
                  this canvas, so once Home anchors at the top its trips are out
                  of view. A muted, non-CTA hint (gated on the same
                  showContinueStrip condition + live count) nudges the user to
                  scroll. Hidden entirely when there are no in-progress trips. */}
              {showContinueStrip && (
                <p
                  style={{ marginTop: 24, fontSize: 12, color: '#888780', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span aria-hidden="true">↓</span>
                  {planningTrips.length} {planningTrips.length === 1 ? 'trip' : 'trips'} in progress — scroll to see them
                </p>
              )}
            </div>
          ) : (
            // ── Active conversation: history + bottom-pinned input ────────────
            <>
              {/* FR-RIG-MISMATCH — advisory banner ABOVE the chat. Shows only when
                  the AI captured a chat-stated rig that differs from the profile/
                  selected rig that governs this trip's estimates. Display-only:
                  changes no calc. Dismissable; dismissal persists per session. */}
              {showRigMismatch && (
                <div className="mx-3 mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
                  <Info size={16} className="mt-0.5 flex-shrink-0 text-amber-500" aria-hidden="true" />
                  <div className="flex-1">
                    Heads up — your trip's mileage and cost estimates use the rig in your profile
                    {' '}(<span className="font-medium">{VEHICLE_LABELS[governingRigType as keyof typeof VEHICLE_LABELS] ?? governingRigType}</span>),
                    but you mentioned a <span className="font-medium">{VEHICLE_LABELS[statedRig as keyof typeof VEHICLE_LABELS] ?? statedRig}</span>.{' '}
                    <Link to="/profile/rig" className="font-medium underline hover:text-amber-900">Update rig profile</Link> so estimates match.
                  </div>
                  <button type="button" onClick={dismissRigBanner} aria-label="Dismiss" className="flex-shrink-0 text-amber-500 hover:text-amber-700">
                    <X size={15} />
                  </button>
                </div>
              )}
              {/* Mobile bottom padding so the last message scrolls clear of the
                  fixed input; the input's opaque bg masks any overlap. The wrapper's
                  definite height already subtracts main's pb-32 (8rem), so the list
                  bottom sits ~8rem above the viewport — already above the nav. This
                  pb therefore only needs to cover the input's own height above the
                  nav plus the notch inset (env), not the full nav+input again. 4rem
                  replaces the over-reserved 7.5rem guess. md:pb-2 = desktop spacing
                  (input in-flow there). */}
              <div ref={listRef} className="flex-1 min-w-0 overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-2">
                {/* Bottom-anchor at ALL sizes: an inner min-h-full flex column with
                    justify-end rests a SHORT conversation at the bottom (last
                    message just above the input) instead of top-stacking it and
                    leaving a large empty gap below — that gap was the dead space
                    older users mistook for "nothing to do here." When the history
                    overflows min-h-full the wrapper grows and scrolls normally
                    (newest at the bottom) — same on mobile and desktop. Previously
                    desktop reverted to top-anchored flow (md:block md:min-h-0);
                    that revert is removed so the input feels connected to the
                    conversation everywhere. space-y-3 moved here from the scroll box. */}
                <div className="min-h-full flex flex-col justify-end md:justify-start space-y-3">
                {messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${
                        msg.role === 'user'
                          ? 'bg-[#1F6F8B] text-white'
                          : 'bg-white border border-gray-200 text-gray-800'
                      }`}
                      style={{ borderWidth: '0.5px' }}
                    >
                      <p className="whitespace-pre-wrap break-words">{cleanChatText(msg.content)}</p>
                    </div>
                  </div>
                ))}
                {typing && (
                  <div className="flex justify-start">
                    <div className="bg-white border border-gray-200 rounded-xl" style={{ borderWidth: '0.5px' }}>
                      <TypingIndicator />
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
                </div>
              </div>

              {/* Mobile-only peek tab — shown when itinerary is ready.
                  Option B: route + stats on top, explicit full-width gold CTA
                  below. The whole pill stays ONE button (full tap target) and
                  still opens the BottomSheet preview via setSheetOpen(true). */}
              {itinerary && (
                <button
                  type="button"
                  onClick={() => setSheetOpen(true)}
                  aria-label="Preview your itinerary"
                  className="lg:hidden flex flex-col gap-2.5 mt-3 px-4 py-3 bg-[#E0F0F4] border border-[#1F6F8B]/20 rounded-xl text-sm hover:bg-[#1F6F8B]/10 transition-colors"
                  style={{ borderWidth: '0.5px' }}
                >
                  {/* Info row — name (truncates) + nights/camp stats */}
                  <div className="flex items-center gap-2 min-w-0 w-full">
                    <span className="text-base flex-shrink-0">🗺️</span>
                    <span className="font-medium text-[#1F6F8B] truncate">{deriveTripTitle(itinerary) || itinerary.name}</span>
                    <span className="text-xs text-[#134756] flex-shrink-0">
                      · {nightsFromStops(itinerary)}n · ${Math.round(computeTripTotals(itinerary).campEst).toLocaleString()} camp
                    </span>
                  </div>
                  {/* Full-width gold CTA — reuses .btn-primary (white text on
                      #F7A829, hover #C9851A); replaces the old "Review →" span. */}
                  <span className="btn-primary w-full flex items-center justify-center gap-1.5">
                    <MapPin size={15} />
                    Tap to preview your itinerary
                  </span>
                </button>
              )}

              {/* Chat input — pinned to bottom. The mobile bottom-nav clearance
                  is now reserved ONCE, by <main>'s pb-32 (the wrapper fills that
                  content box via min-h-full) — so this input must NOT add another
                  ~64px on top, which was stacking into the dead-space gap. Keep
                  only the iOS home-indicator safe-area inset (env() = 0 on
                  non-notch devices, so no awkward gap). Removed at md (no nav). */}
              {/* Chat input — PINNED on mobile (fixed above the bottom nav),
                  in-flow on desktop (all md: classes restore the prior desktop
                  layout). Mobile: position:fixed so the input can't be pushed
                  off-screen as the conversation grows; bottom = nav height
                  (3.5rem ≈ the 54px md:hidden bottom nav) + the iOS home-indicator
                  safe-area inset, so it rests just above the nav. Opaque bg-rr-bg
                  (the app bg) masks messages scrolling UNDER it. z-30 sits below
                  the nav (z-40) and below modals/sheets/dropdowns (z-50/80/81).
                  The message list (above) carries matching bottom padding so its
                  last message clears this pinned input. */}
              <div
                className="fixed left-0 right-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 bg-rr-bg px-4 pt-2 pb-3 md:static md:bottom-auto md:left-auto md:right-auto md:z-auto md:bg-transparent md:px-2.5 md:pt-2.5 md:pb-2.5 md:mt-3"
              >
                <ChatInput
                  ref={inputRef}
                  value={input}
                  onChange={setInput}
                  onSubmit={sendMessage}
                  // When it's the user's turn, the placeholder itself carries the
                  // "type your answer" cue (not color-only — accessible), and
                  // isAwaiting drives the gentle pulse on the input.
                  placeholder={
                    awaitingReply
                      ? 'Type your answer here…'
                      : isSmAndUp ? 'Message RoamReady AI...' : 'Message RoamReady…'
                  }
                  isAwaiting={awaitingReply}
                  disabled={typing}
                  loading={typing}
                  speechSupported={speechSupported}
                  listening={listening}
                  onToggleListening={toggleListening}
                />
              </div>
            </>
          )}
        </div>

        {/* Mobile-only BottomSheet — same content as desktop sidebar */}
        <BottomSheet
          isOpen={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title={(itinerary && deriveTripTitle(itinerary)) || itinerary?.name || 'Itinerary'}
          locked={creating}
        >
          {itinerary && (
            <div className="px-5 py-4">
              {/* Resolved start date WITH YEAR — see the desktop preview note. */}
              {itinerary.startDate && (
                <p className="text-xs text-gray-500 mb-3">Departs {formatTripDate(itinerary.startDate, 'MMM d, yyyy')}</p>
              )}
              <div className="grid grid-cols-2 gap-2 mb-4 text-xs text-gray-500">
                <div>~{itinerary.totalMiles?.toLocaleString()} mi</div>
                <div>~${Math.round(computeTripTotals(itinerary).campEst).toLocaleString()} camp</div>
              </div>
              <div className="space-y-2 mb-4">
                {itinerary.stops?.map((stop: any, i: number) => (
                  <div key={i} className="flex gap-2">
                    <div className="w-5 h-5 bg-[#1F6F8B] rounded-full flex items-center justify-center text-white text-xs flex-shrink-0">
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-800 truncate">{stop.locationName}, {stop.locationState}</p>
                      {stop.campgroundName && <p className="text-xs text-gray-500 truncate">{stop.campgroundName}</p>}
                      <p className="text-xs text-gray-400">{stop.nights} night{stop.nights !== 1 ? 's' : ''}</p>
                      <RigWarningPill notes={stop.violationNotes} />
                    </div>
                  </div>
                ))}
              </div>
              {buildError && <p className="text-xs text-red-600 mb-3 text-center">{buildError}</p>}
              <RvSafetyInlineAck checked={rvSafetyAcked} onChange={setRvSafetyAcked} disabled={creating} />
              <button
                onClick={onBuildItineraryClick}
                disabled={creating || !rvSafetyAcked}
                className="btn-primary w-full text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? <><Loader size={15} className="animate-spin" /> Building...</> : 'Build full itinerary'}
              </button>
              {!rvSafetyAcked && !creating && (
                <p className="text-[11px] text-gray-400 text-center mt-1.5">Check the box above to continue</p>
              )}
            </div>
          )}
        </BottomSheet>

        {/* Itinerary preview — desktop only */}
        {itinerary && (
          <div className="hidden lg:flex w-80 flex-col">
            <div className="card-lg flex flex-col min-h-0 flex-1">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-medium text-gray-900 text-sm">{deriveTripTitle(itinerary) || itinerary.name}</h3>
                <span className="badge-green text-xs">{nightsFromStops(itinerary)}n</span>
              </div>
              {/* Resolved start date WITH YEAR — lets the user sanity-check the
                  year the planner resolved (complements the past-date backstop). */}
              {itinerary.startDate && (
                <p className="text-xs text-gray-500 mb-4">Departs {formatTripDate(itinerary.startDate, 'MMM d, yyyy')}</p>
              )}
              <div className="grid grid-cols-2 gap-2 mb-4 text-xs text-gray-500">
                <div>~{itinerary.totalMiles?.toLocaleString()} mi</div>
                <div>~${Math.round(computeTripTotals(itinerary).campEst).toLocaleString()} camp</div>
              </div>
              <div className="flex-1 overflow-y-auto min-h-0 space-y-2">
                {itinerary.stops?.map((stop: any, i: number) => (
                  <div key={i} className="flex gap-2">
                    <div className="w-5 h-5 bg-[#1F6F8B] rounded-full flex items-center justify-center text-white text-xs flex-shrink-0">
                      {i + 1}
                    </div>
                    <div className="flex-1">
                      <p className="text-xs font-medium text-gray-800">{stop.locationName}, {stop.locationState}</p>
                      {stop.campgroundName && <p className="text-xs text-gray-500">{stop.campgroundName}</p>}
                      <p className="text-xs text-gray-400">{stop.nights} night{stop.nights !== 1 ? 's' : ''}</p>
                      <RigWarningPill notes={stop.violationNotes} />
                    </div>
                  </div>
                ))}
              </div>
              {buildError && <p className="text-xs text-red-600 mt-3 text-center">{buildError}</p>}
              <div className="mt-4 flex-shrink-0">
                <RvSafetyInlineAck checked={rvSafetyAcked} onChange={setRvSafetyAcked} disabled={creating} />
                <button
                  onClick={onBuildItineraryClick}
                  disabled={creating || !rvSafetyAcked}
                  className="btn-primary w-full text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creating ? <><Loader size={15} className="animate-spin" /> Building...</> : 'Build full itinerary'}
                </button>
                {!rvSafetyAcked && !creating && (
                  <p className="text-[11px] text-gray-400 text-center mt-1.5">Check the box above to continue</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={showCancelConfirm}
        title="Discard this plan?"
        message="You'll lose your in-progress conversation. This can't be undone."
        confirmLabel="Discard plan"
        cancelLabel="Keep planning"
        onConfirm={handleCancel}
        onCancel={() => setShowCancelConfirm(false)}
        danger
        isConfirming={isProcessing}
      />

      {/* RIG-COMPLETENESS NOTICE — build-time nudge. Only when a SAVED (non-ad-hoc)
          rig is missing safety dims and/or MPG. "Add details" round-trips to the rig
          editor with a returnTo back to this session; "Build anyway" proceeds via the
          shared proceedToBuild(); dismiss leaves the user on the plan (no build). */}
      {showRigNotice && selectedRig && !isAdHocRig(selectedRig) && (
        <RigCompletenessNotice
          missingDims={missingSafetyDims(selectedRig)}
          missingMpg={missingMpg(selectedRig)}
          onAddDetails={() => {
            setShowRigNotice(false)
            navigate(`/profile/rig/${selectedRig.id}/edit?returnTo=${encodeURIComponent(`/sessions/${sessionId}`)}`)
          }}
          onBuildAnyway={() => {
            setShowRigNotice(false)
            proceedToBuild()
          }}
          onClose={() => setShowRigNotice(false)}
        />
      )}

      {/* Block 8 — confirm-vehicles modal. Renders only when the per-trip
          selectedRig is a real Rig on file. For users without a rig the
          modal is skipped (handled in onBuildItineraryClick); for ad-hoc
          rigs picked from the chip dropdown the modal is also skipped
          because it expects a real Rig with vehicleType + tow fields,
          which an ad-hoc entry doesn't have. */}
      {selectedRig && !isAdHocRig(selectedRig) && (
        <ConfirmVehiclesModal
          isOpen={confirmVehiclesOpen}
          rig={selectedRig}
          isConfirming={creating}
          onCancel={() => setConfirmVehiclesOpen(false)}
          onConfirm={vehicleData => {
            setConfirmVehiclesOpen(false)
            buildItinerary(vehicleData)
          }}
        />
      )}

    </div>

    {/* Continue planning strip — sibling of the viewport-locked canvas above so it
        sits below the fold on desktop without breaking the active-conversation
        height lock (chat history needs that lock to scroll internally). Renders
        only in the empty state, only after the trips fetch resolves, and only
        when the user has at least one PLANNING trip — for a new user with zero
        in-progress trips, this collapses to nothing and they see just the canvas. */}
    {showContinueStrip && (
      <div
        className="px-2"
        style={{
          borderTop: '0.5px solid #E8E4DA',
          marginTop: 32,
          paddingTop: 24,
          paddingBottom: 8,
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-gray-900">Continue planning</h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
              {planningTrips.length} in progress
            </span>
          </div>
          <Link
            to="/dashboard"
            className="text-xs text-[#1F6F8B] hover:underline flex items-center gap-1"
          >
            View all in Dashboard
            <ChevronRight size={12} />
          </Link>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {recentPlanning.map(trip => (
            <TripCard key={trip.id} trip={trip} variant="compact" />
          ))}
        </div>
      </div>
    )}

    {showTravelMap && (
      <div
        className="px-2"
        style={
          showContinueStrip
            ? { marginTop: 16, paddingBottom: 8 }
            : { borderTop: '0.5px solid #E8E4DA', marginTop: 32, paddingTop: 24, paddingBottom: 8 }
        }
      >
        <HomeJournalMapCard trips={allTrips} />
      </div>
    )}
    </>
  )
}
