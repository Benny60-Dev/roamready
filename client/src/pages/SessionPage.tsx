import { useCallback, useState, useRef, useEffect, useLayoutEffect, type CSSProperties } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { MapPin, Tent, Users, Loader, Plus, X, Sparkles, ChevronDown, ChevronUp, ChevronRight, Check, Info } from 'lucide-react'
import { aiApi, sessionsApi, tripsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { ChatMessage, Trip, Rig } from '../types'
import { VEHICLE_LABELS } from './profile/RigPage'
import BottomSheet from '../components/ui/BottomSheet'
import ConfirmModal from '../components/ui/ConfirmModal'
import ConfirmVehiclesModal, { type ConfirmVehiclesResult } from '../components/trip/ConfirmVehiclesModal'
import HomeBaseCard from '../components/trip/HomeBaseCard'
import TripCard from '../components/trip/TripCard'
import { useSessionAutosave } from '../hooks/useSessionAutosave'
import { useVoiceInput } from '../hooks/useVoiceInput'
import { useScrollResetOnReady } from '../hooks/useScrollResetOnReady'
import { ChatInput } from '../components/ChatInput'
import { selectGreeting } from '../utils/greeting'
import { relativeTime } from '../utils/dates'

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

function parseItinerary(text: string) {
  let inner = text.match(/<itinerary>([\s\S]*?)<\/itinerary>/)?.[1]
  if (!inner) inner = text.match(/<itinerary>([\s\S]*)/)?.[1]
  if (!inner) return null
  inner = inner.trim()
  try { return JSON.parse(inner) } catch {
    const m = inner.match(/\{[\s\S]*\}/)
    if (m) { try { return JSON.parse(m[0]) } catch { /* fall through */ } }
    return null
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

const ROUND_TRIP_PHRASES = [
  'round trip', 'round-trip', 'coming back home', 'returning home',
  'back home', 'end at home', 'heading home after',
] as const

function stripUnrequestedReturnLeg(
  itinerary: any,
  messages: ChatMessage[],
  homeCity?: string | null,
): any {
  // Guard: malformed or trivially short stop list — nothing to strip
  const stops: any[] = itinerary?.stops
  if (!Array.isArray(stops) || stops.length < 2) return itinerary

  // Scan all user messages for any explicit round-trip phrase
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => m.content.toLowerCase())
    .join(' ')

  const hasRoundTripPhrase =
    ROUND_TRIP_PHRASES.some(p => userText.includes(p)) ||
    // "back to Mesa" (or whatever homeCity is) also counts
    (homeCity ? userText.includes('back to ' + homeCity.toLowerCase()) : false)

  if (hasRoundTripPhrase) return itinerary  // genuine round trip — no-op

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
  if (turnaroundIdx === -1 || turnaroundIdx === stops.length - 1) return itinerary

  const slicedStops = stops.slice(0, turnaroundIdx + 1)
  const totalNights = slicedStops.reduce((n: number, s: any) => n + ((s.nights as number) ?? 0), 0)

  console.log(
    '[stripUnrequestedReturnLeg] stripped return leg:',
    `${stops.length} → ${slicedStops.length} stops,`,
    `destination="${(stops[turnaroundIdx] as any)?.locationName}"`,
  )

  return { ...itinerary, stops: slicedStops, totalNights, totalMiles: null, estimatedFuel: null }
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
            const parsed = parseItinerary(m.content)
            if (parsed) {
              setItinerary(stripUnrequestedReturnLeg(parsed, persistedMessages, user?.homeCity))
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
        const planning = (res.data as Trip[])
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
    const next = [...messages, userMsg]
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
      setMessages([...next, { role: 'assistant', content: aiText }])
      const parsed = parseItinerary(aiText)
      // `next` holds all messages up to and including the current user message —
      // the correct slice to scan for round-trip phrases (the AI reply isn't a
      // user message, so it doesn't affect the phrase check).
      if (parsed) setItinerary(stripUnrequestedReturnLeg(parsed, next, user?.homeCity))
    } catch (err: any) {
      // FEATURE_GATED 403 — paywall modal already opened by the central
      // axios interceptor. Skip the generic assistant-bubble error so the
      // user isn't double-narrated by the modal AND a chat message.
      if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') {
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
    // leave the modal buried behind the still-open sheet. One overlay at a time
    // — the sheet steps aside so the vehicle picker is reachable. Harmless on
    // the no-rig / ad-hoc paths (the sheet just closes as building begins) and
    // a no-op on desktop, where the Build button is an in-flow sidebar control.
    setSheetOpen(false)
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
    if (!itinerary || !sessionId) return
    setCreating(true)
    setBuildError(null)
    try {
      const homeStopName = itinerary.stops?.[0]?.type === 'HOME'
        ? itinerary.stops[0].locationName
        : user?.homeLocation || itinerary.stops?.[0]?.locationName || 'Start'

      console.time('[buildItinerary] total')

      console.time('[buildItinerary] promoteSession')
      const promoted = await sessionsApi.promote(sessionId, {
        name: itinerary.name,
        // DATE-ANCHOR-1: carry the AI-captured departure date through to
        // Trip.startDate so recomputeStopDates anchors stops on it instead of
        // falling back to today. null when the AI emitted no date (no-date
        // trips keep the today fallback). The promote schema accepts startDate.
        startDate: itinerary.startDate ?? null,
        startLocation: homeStopName,
        endLocation: itinerary.stops?.[itinerary.stops.length - 1]?.locationName || 'End',
        totalMiles: itinerary.totalMiles,
        totalNights: itinerary.totalNights,
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
      })
      const tripId = promoted.data.trip.id
      console.timeEnd('[buildItinerary] promoteSession')

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
        await tripsApi.createStop(tripId, fixedStop)
        console.timeEnd(`[buildItinerary] createStop[${i}] ${stop.locationName}`)
      }
      console.timeEnd('[buildItinerary] createStops')

      console.time('[buildItinerary] reassignPOIs')
      await tripsApi.reassignPOIs(tripId)
      console.timeEnd('[buildItinerary] reassignPOIs')

      // Deterministic per-leg max-drive-time guard: break any leg that exceeds
      // the user's maxDriveHours into OVERNIGHT_ONLY transit stops at real towns.
      // AWAITED and BEFORE generateItinerary so the day-by-day narration sees the
      // corrected stop set. Wrapped so a guard failure never blocks trip creation
      // (the server controller also fails soft per-leg).
      console.time('[buildItinerary] expandLongLegs')
      try {
        await tripsApi.expandLongLegs(tripId)
      } catch (e) {
        console.error('[buildItinerary] expandLongLegs failed (non-fatal):', e)
      }
      console.timeEnd('[buildItinerary] expandLongLegs')

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

  const cleanText = (text: string) => text
    .replace(/<itinerary>[\s\S]*?<\/itinerary>/g, '')
    .replace(/<itinerary>[\s\S]*/g, '')
    .trim()

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

  // Pre-conversation = the user hasn't sent anything yet. Using "no user
  // message" (rather than messages.length===0) also covers any edge case where
  // an assistant-only message lingers from older builds.
  const isEmptyState = !messages.some(m => m.role === 'user')

  // ── Rig context chip strip pieces (only rendered in empty state) ───────────
  // Phase B — the chip reads selectedRig (per-trip override), not the user's
  // global default. selectedRig may be a real Rig or an AdHocRig; both have
  // year/make/model/length so the same derivation works for either.
  const rigName = selectedRig
    ? [selectedRig.year, selectedRig.make, selectedRig.model].filter(Boolean).join(' ').trim()
    : ''
  const rigChipText = rigName
    ? selectedRig?.length
      ? `${rigName} (${selectedRig.length}ft)`
      : rigName
    : ''
  const hasMultipleRigs = (user?.rigs?.length ?? 0) > 1
  const partyChipText = profile
    ? `${profile.adults} adult${profile.adults !== 1 ? 's' : ''}${profile.hasPets ? ', pets' : ''}`
    : ''
  const styleChipText = profile?.hookupPreference
    ? profile.hookupPreference.replace(/_/g, ' ').toLowerCase()
    : ''
  const showRigStrip = !!(rigChipText || partyChipText || styleChipText)

  // Most recent 3 PLANNING trips for the strip below the canvas. Sorted by
  // updatedAt desc in the fetch effect.
  const recentPlanning = planningTrips.slice(0, 3)
  const showContinueStrip = isEmptyState && !tripsLoading && planningTrips.length > 0
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
        in-flow input off-screen. md keeps its existing definite `h` (input in-flow). */}
    <div className={`flex flex-col${isEmptyState ? '' : ' h-[calc(100dvh-12.25rem)] md:h-[calc(100dvh-6.5rem)]'}`}>
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
                  {partyChipText && (
                    <span style={CONTEXT_CHIP_STYLE}>
                      <Users size={14} aria-hidden="true" color="#1F6F8B" />
                      {partyChipText}
                    </span>
                  )}
                  {styleChipText && (
                    <span style={CONTEXT_CHIP_STYLE}>
                      <Tent size={14} aria-hidden="true" color="#1F6F8B" />
                      {styleChipText}
                    </span>
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
              {/* Mobile bottom padding so the last message scrolls clear of the
                  fixed input; the input's opaque bg masks any overlap. The wrapper's
                  definite height already subtracts main's pb-32 (8rem), so the list
                  bottom sits ~8rem above the viewport — already above the nav. This
                  pb therefore only needs to cover the input's own height above the
                  nav plus the notch inset (env), not the full nav+input again. 4rem
                  replaces the over-reserved 7.5rem guess. md:pb-2 = desktop spacing
                  (input in-flow there). */}
              <div ref={listRef} className="flex-1 min-w-0 overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-2">
                {/* Bottom-anchor on mobile: an inner min-h-full flex column with
                    justify-end rests a SHORT conversation at the bottom (last
                    message just above the pinned input) instead of top-stacking it
                    and leaving a large empty gap below — that gap, not the pb, was
                    the remaining dead space. When the history overflows min-h-full
                    the wrapper grows and scrolls normally (newest at the bottom).
                    md:block md:min-h-0 restores desktop's top-anchored flow.
                    space-y-3 moved here from the scroll box. */}
                <div className="min-h-full flex flex-col justify-end space-y-3 md:block md:min-h-0">
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
                      <p className="whitespace-pre-wrap break-words">{cleanText(msg.content)}</p>
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
                    <span className="font-medium text-[#1F6F8B] truncate">{itinerary.name}</span>
                    <span className="text-xs text-[#134756] flex-shrink-0">
                      · {itinerary.totalNights}n · ${Math.round(computeTripTotals(itinerary).campEst).toLocaleString()} camp
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
                className="fixed left-0 right-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 bg-rr-bg px-4 pt-2 md:static md:bottom-auto md:left-auto md:right-auto md:z-auto md:bg-transparent md:px-0 md:pt-0 md:mt-3"
              >
                <ChatInput
                  ref={inputRef}
                  value={input}
                  onChange={setInput}
                  onSubmit={sendMessage}
                  placeholder="Message RoamReady AI..."
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
          title={itinerary?.name || 'Itinerary'}
          locked={creating}
        >
          {itinerary && (
            <div className="px-5 py-4">
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
                    </div>
                  </div>
                ))}
              </div>
              {buildError && <p className="text-xs text-red-600 mb-3 text-center">{buildError}</p>}
              <button
                onClick={onBuildItineraryClick}
                disabled={creating}
                className="btn-primary w-full text-sm flex items-center justify-center gap-2"
              >
                {creating ? <><Loader size={15} className="animate-spin" /> Building...</> : 'Build full itinerary'}
              </button>
            </div>
          )}
        </BottomSheet>

        {/* Itinerary preview — desktop only */}
        {itinerary && (
          <div className="hidden lg:flex w-80 flex-col">
            <div className="card-lg flex flex-col min-h-0 flex-1">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium text-gray-900 text-sm">{itinerary.name}</h3>
                <span className="badge-green text-xs">{itinerary.totalNights}n</span>
              </div>
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
                    </div>
                  </div>
                ))}
              </div>
              {buildError && <p className="text-xs text-red-600 mt-3 text-center">{buildError}</p>}
              <button
                onClick={onBuildItineraryClick}
                disabled={creating}
                className="btn-primary w-full mt-4 text-sm flex items-center justify-center gap-2 flex-shrink-0"
              >
                {creating ? <><Loader size={15} className="animate-spin" /> Building...</> : 'Build full itinerary'}
              </button>
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
    </>
  )
}
