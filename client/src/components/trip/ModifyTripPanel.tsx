import { useEffect, useRef, useState } from 'react'
import { X, Wand2, AlertTriangle } from 'lucide-react'
import { format } from 'date-fns'
import { aiApi, tripsApi } from '../../services/api'
import { Trip, StopType } from '../../types'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { ChatInput } from '../ChatInput'
import { parseTripDate } from '../../utils/dates'
import BookedShiftModal from './BookedShiftModal'
import { cleanChatText } from '../../utils/cleanChatText'
import { userFacingStopCount } from '../../utils/userFacingStopCount'

// ─── Quick suggestion chips ───────────────────────────────────────────────────

const QUICK_CHIPS = [
  'Add a stop',
  'Remove a stop',
  'Extend my stay somewhere',
  'Find a better campground',
  'Shorten the trip',
]

// ─── Types ────────────────────────────────────────────────────────────────────

interface ModifyAction {
  action: 'add_stop' | 'remove_stop' | 'change_nights' | 'suggest_campground' | 'shift_trip_dates' | 'change_rig'
  // new schema (server-injected prompt)
  locationName?: string
  locationState?: string
  afterStopOrder?: number
  // legacy schema fallbacks (kept for backward-compat with any stored history)
  location?: string
  after_stop?: string
  // shared
  nights?: number
  type?: StopType
  campgroundName?: string
  // shift_trip_dates — ISO YYYY-MM-DD string emitted by the AI; the server
  // parses via z.coerce.date() so a Date instance is unnecessary here.
  newStartDate?: string
  // change_rig (RIG-CHANGE Phase 3) — rigId is the swap target (server-validated,
  // scoped to the user via applyRigChange); rigName is the AI-supplied display
  // name for the confirmation card only.
  rigId?: string
  rigName?: string
}

/** AI-MESA-10 — one server-parsed <modify> action. The SERVER is the single
 *  parse authority: these arrive in the chat envelope's actions[] (emission
 *  order) and on persisted history entries; the client never re-parses prose.
 *  `applied` is persisted truth — it flips only when a trip-mutation endpoint
 *  stamps the action after actually executing it. */
interface ServerModifyAction {
  id: string
  action: ModifyAction
  applied: boolean
  appliedAt?: string | null
}

/** In-session UI overlay for a card that is mid-apply or failed its last
 *  attempt. Keyed by action id, never persisted — on reload everything
 *  re-derives from the per-action `applied` flags (server truth). */
interface ActionUiState {
  status: 'applying' | 'failed'
  error?: string
}

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  /** AI-MESA-10 — the server-parsed proposals for this assistant turn. */
  actions?: ServerModifyAction[]
  /** Set to true when the server reported modifyOutcome==='failed' — modify
   *  mode was active, the server retried once, and the final response carried
   *  neither a <modify> nor a <clarify> tag (a genuine no-op). The render path
   *  adds a small inline warning under the assistant bubble. NOT set for
   *  'clarify' turns (the AI legitimately asking for more info), which render
   *  as a plain question with no warning. */
  modifyFailed?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Strip raw <modify> tags from displayed prose. The envelope keeps them in
// `message` only for old-client compat — this client renders actions[] and
// never re-parses text (the old parseModify took only the FIRST block, which
// silently dropped stops 2-N of a multi-step plan: the Cindy/Mesa incident).

function getConfirmationText(action: ModifyAction): string {
  const name = action.locationName ?? action.location ?? 'stop'
  const state = action.locationState ? `, ${action.locationState}` : ''
  switch (action.action) {
    case 'add_stop': {
      const nights = action.nights ? ` for ${action.nights} night${action.nights !== 1 ? 's' : ''}` : ''
      return `Add ${name}${state}${nights}`
    }
    case 'remove_stop':
      return `Remove ${name}${state} from the trip`
    case 'change_nights':
      return `Change ${name}${state} to ${action.nights} night${action.nights !== 1 ? 's' : ''}`
    case 'suggest_campground':
      return `Switch ${name}${state} campground to ${action.campgroundName}`
    case 'shift_trip_dates': {
      // parseTripDate normalizes "YYYY-MM-DD" (what the AI emits) or any ISO
      // shape to a local-noon Date whose format() output matches the intended
      // calendar day regardless of viewer timezone.
      const parsed = parseTripDate(action.newStartDate)
      const pretty = parsed
        ? format(parsed, 'MMMM d, yyyy')
        : (action.newStartDate ?? 'a new date')
      return `Shift trip to start on ${pretty}`
    }
    case 'change_rig':
      return `Switch this trip's rig to ${action.rigName ?? 'the selected rig'}`
    default:
      return 'Apply this change'
  }
}

/** Action-specific Apply button label. The default is "✓ Apply"; only
 *  shift_trip_dates currently overrides it. Kept as a helper alongside
 *  getConfirmationText so future actions have an obvious place to add
 *  their own custom button text. */
function getApplyButtonLabel(action: ModifyAction): string {
  switch (action.action) {
    case 'shift_trip_dates':
      return 'Shift dates'
    case 'change_rig':
      return 'Change rig'
    default:
      return '✓ Apply'
  }
}

/** Secondary "fine print" line beneath the main confirmation text, shown
 *  only for actions where the consequence isn't fully captured by the
 *  one-line summary. Returns null when no sub-line should render so the
 *  card stays compact for simpler actions. */
function getConfirmationSubText(action: ModifyAction, trip: Trip): string | null {
  if (action.action !== 'shift_trip_dates') return null
  if (!action.newStartDate) return null
  // trip.startDate is typically null in this codebase — the canonical anchor
  // is the first stop's arrivalDate (same convention as buildTimeline and the
  // server-side shift handler). Falling back here means the "X days later"
  // preview still renders for the common case.
  const firstStopArrival = trip.stops?.find(s => s.arrivalDate)?.arrivalDate
  const oldStartStr = trip.startDate ?? firstStopArrival
  if (!oldStartStr) return null
  // Use parseTripDate on both ends so the delta math operates on calendar-day
  // semantics. Raw `new Date("2026-07-10T00:00:00Z") - new Date("2026-07-10")`
  // can yield a 7-hour negative offset that rounds to ±1 day in some TZs.
  // Local-noon Dates from parseTripDate sit far from midnight boundaries, so
  // the delta is always an exact multiple of 86_400_000 ms.
  const newStart = parseTripDate(action.newStartDate)
  const oldStart = parseTripDate(oldStartStr)
  if (!newStart || !oldStart) return null
  const dayDelta = Math.round((newStart.getTime() - oldStart.getTime()) / 86400000)
  if (dayDelta === 0) return 'No change — trip already starts on that date.'
  // User-facing count (excludes HOME origin + return-home stop) so the message
  // matches what the user sees on the trip — see userFacingStopCount.
  const stopCount = userFacingStopCount(trip.stops)
  const direction = dayDelta > 0 ? 'later' : 'earlier'
  const absDelta = Math.abs(dayDelta)
  return `All ${stopCount} stop${stopCount === 1 ? '' : 's'} will move ${absDelta} day${absDelta === 1 ? '' : 's'} ${direction}. Trip length stays the same.`
}

// ─── Typing dots ──────────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex gap-1 items-center px-3 py-2.5">
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
    </div>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ModifyTripPanelProps {
  trip: Trip
  isOpen: boolean
  onClose: () => void
  onTripUpdated: (trip: Trip) => void
}

// ─── Component ────────────────────────────────────────────────────────────────

const GREETING = (name: string) =>
  `I can help you modify ${name}! What changes would you like to make?`

export default function ModifyTripPanel({ trip, isOpen, onClose, onTripUpdated }: ModifyTripPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const [applying, setApplying] = useState(false)
  // Per-action in-session overlay (applying spinner / failed error). Reset on
  // every history load — persisted `applied` flags are the durable state.
  const [actionUi, setActionUi] = useState<Record<string, ActionUiState>>({})
  // ADDSTOP-RESLOT Phase B — transient "your insert shifted a booked stop's
  // itinerary date" heads-up, set from the createStop response after an add_stop
  // apply. The reservation itself is unchanged; this just flags the date move.
  const [bookedShiftWarning, setBookedShiftWarning] = useState<
    { newStop: string; stops: Array<{ stopId: string; name: string; originalBookedDate: string; newArrivalDate: string }> } | null
  >(null)
  // ADDSTOP-RESLOT — separate open-flag for the center-screen interrupt modal.
  // Kept distinct from bookedShiftWarning so dismissing the modal ("Got it")
  // does NOT clear the inline banner, which persists as the chat-history record.
  const [bookedShiftModalOpen, setBookedShiftModalOpen] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // MODIFY-RESET-1: number of messages seeded from persisted history when the
  // panel opened. Loaded history is shown as scrollback but NOT posted to
  // /ai/chat — sendMessage posts only messages added AFTER this boundary, so a
  // reopened (even hard-capped) session starts fresh and never re-fires the cap.
  const sessionStartLenRef = useRef(0)

  // Apple-style press-to-start / press-to-stop dictation. The hook captures
  // whatever the user has already typed before tapping the mic so dictation
  // extends rather than overwrites. See hooks/useVoiceInput.ts.
  const { supported: speechSupported, listening, toggleListening } = useVoiceInput({
    onTranscript: (text) => setInput(text),
    onStart: () => input,
  })

  // Load persisted modify conversation when trip changes OR panel is opened.
  // isOpen is included so the history refreshes from DB every time the panel
  // is opened — otherwise cleared/updated history won't appear until navigation.
  useEffect(() => {
    if (!isOpen) return
    setHistoryLoaded(false)
    setActionUi({})
    aiApi.getModifyHistory(trip.id)
      .then(res => {
        const history: Array<{ role: 'user' | 'assistant'; content: string; actions?: ServerModifyAction[] }> =
          res.data ?? []
        if (history.length === 0) {
          setMessages([{ role: 'assistant', content: GREETING(trip.name) }])
          // Only the greeting was seeded → boundary 1, so a first send posts just
          // the user's message.
          sessionStartLenRef.current = 1
        } else {
          // AI-MESA-10 — apply state comes from the persisted per-action
          // `applied` flags, stamped server-side at execution time. (The old
          // path re-parsed the first <modify> tag and marked it applied:true
          // unconditionally — a reload-time lie.)
          setMessages(history.map(m =>
            m.role === 'assistant' && Array.isArray(m.actions) && m.actions.length
              ? { role: m.role, content: m.content, actions: m.actions }
              : { role: m.role, content: m.content }
          ))
          // history.length messages seeded → boundary excludes all loaded history
          // from the posted array (it's displayed as scrollback only).
          sessionStartLenRef.current = history.length
        }
      })
      .catch(() => {
        setMessages([{ role: 'assistant', content: GREETING(trip.name) }])
        sessionStartLenRef.current = 1
      })
      .finally(() => setHistoryLoaded(true))
  }, [trip.id, isOpen])

  // block:'nearest' so it no-ops when the latest message is already visible and
  // only scrolls the minimum when the list overflows (consistent with
  // SessionPage). This panel is fixed-position so the window was never an
  // ancestor here, but matching the option keeps both chat surfaces identical.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [messages, typing])

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 300)
    }
  }, [isOpen])

  async function sendMessage(overrideText?: string) {
    // ChatInput wires the Send button as `onClick={onSubmit}`, which means
    // React passes the MouseEvent as the first arg when the user clicks. We
    // need `overrideText` to remain a real string-or-undefined contract so
    // suggestion-chip callers (which DO pass real string overrides) keep
    // working. Coerce non-strings (i.e. the event) to undefined so they fall
    // through to `input` instead of crashing on .trim().
    const safeOverride = typeof overrideText === 'string' ? overrideText : undefined
    const text = (safeOverride ?? input).trim()
    if (!text || typing || applying) return

    const userMsg: ChatMsg = { role: 'user', content: text }
    const newMessages: ChatMsg[] = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setTyping(true)

    try {
      // The server injects a live ground-truth state message on every modify call,
      // so we no longer send the (potentially stale) client-side system prompt.
      // Sending it would give Claude two conflicting stop lists.
      // MODIFY-RESET-1: post ONLY messages added during the current open session
      // (everything after the seeded-history boundary). The full thread is still
      // displayed above (setMessages(newMessages)); only the POSTED array is sliced,
      // so reopening a hard-capped session starts fresh and never re-fires the cap.
      const apiMessages = newMessages
        .slice(sessionStartLenRef.current)
        .map(m => ({ role: m.role, content: m.content }))
      const res = await aiApi.chat(apiMessages, trip.id, 'modify')
      const aiText: string = res.data.message
      // modifyOutcome is the server's three-state classification of a modify
      // turn: 'proposal' (Apply card), 'clarify' (the AI asked for more info —
      // NOT an error), or 'failed' (neither tag after a retry). We only surface
      // the inline warning for 'failed'; 'clarify' renders as a plain question.
      // See the ChatMsg interface above + the notice block in the render.
      const modifyOutcome: string | undefined = res.data?.modifyOutcome

      // AI-MESA-10 — the server's parsed actions[] is the only apply source;
      // the prose is display-only (tags stripped at render by cleanChatText).
      const serverActions: ServerModifyAction[] = Array.isArray(res.data?.actions) ? res.data.actions : []
      const aiMsg: ChatMsg = {
        role: 'assistant',
        content: aiText,
        ...(serverActions.length ? { actions: serverActions } : {}),
        ...(modifyOutcome === 'failed' ? { modifyFailed: true } : {}),
      }
      setMessages(prev => [...prev, aiMsg])
    } catch (err: any) {
      // FEATURE_GATED 403 — paywall modal already opened by the central
      // axios interceptor (see services/api.ts). Skip the generic
      // assistant-bubble error so the user isn't double-narrated by both
      // the modal AND a chat message saying "Sorry, I had trouble".
      // Other errors (network, 5xx, etc.) keep the existing fallback.
      if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') {
        return
      }
      // Daily AI cap — per-user (DAILY_USER_CAP) or free-tier (DAILY_LIMIT). Show
      // the 429 body's friendly message verbatim rather than the generic error.
      // Discriminant is data.error (NOT data.code — that's FEATURE_GATED).
      const capError = err?.response?.data?.error
      if (err?.response?.status === 429 && (capError === 'DAILY_USER_CAP' || capError === 'DAILY_LIMIT')) {
        const capMsg = err.response.data?.message || "You've reached today's AI limit — please try again later."
        setMessages(prev => [...prev, { role: 'assistant', content: capMsg }])
        return
      }
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: 'Sorry, I had trouble responding. Please try again.' },
      ])
    } finally {
      setTyping(false)
    }
  }

  /** Executes one server-parsed action against the trip-mutation endpoints,
   *  threading the action id so the SERVER stamps applied=true at execution
   *  time (AI-MESA-10 — the client never self-reports apply success as the
   *  source of truth). Throws on any failure; callers own the card state. */
  async function executeAction(action: ModifyAction, modifyActionId: string) {
    // Fetch fresh trip data from the DB so position math uses current stop orders,
    // not the (potentially stale) React prop captured at last render.
    const freshRes = await tripsApi.get(trip.id)
    const freshStops = freshRes.data.stops ?? []
    const sortedStops = [...freshStops].sort((a: any, b: any) => a.order - b.order)
    console.log('[applyMod] action:', JSON.stringify(action), '| freshStops:', sortedStops.map((s: any) => s.order + ':' + s.locationName))

    // Fuzzy match a stop by location name
    function findStop(name?: string) {
      if (!name) return undefined
      const needle = name.toLowerCase()
      return sortedStops.find(
        (s: any) =>
          s.locationName.toLowerCase().includes(needle) ||
          needle.includes(s.locationName.toLowerCase())
      )
    }

    // Resolve location name from either new schema (locationName) or legacy (location)
    const resolvedName = action.locationName ?? action.location ?? ''
    const resolvedState = action.locationState ?? (() => {
      const raw = action.location ?? ''
      const commaIdx = raw.lastIndexOf(',')
      return commaIdx >= 0 ? raw.slice(commaIdx + 1).trim() : undefined
    })()
    const cleanName = action.locationName
      ? resolvedName
      : (() => { const raw = resolvedName; const c = raw.lastIndexOf(','); return c >= 0 ? raw.slice(0, c).trim() : raw.trim() })()

    // Dispatch the action. The `default:` branch throws on any unknown action —
    // a hallucinated action name surfaces as a card error, never silent success.
    switch (action.action) {
      case 'add_stop': {
        // Duplicate guard — block if a stop with a matching name already exists
        const locationNeedle = cleanName.toLowerCase()
        const duplicate = locationNeedle ? sortedStops.find(
          (s: any) =>
            s.locationName.toLowerCase().includes(locationNeedle) ||
            locationNeedle.includes(s.locationName.toLowerCase())
        ) : undefined

        // Round-trip exception: a return-home add_stop legitimately re-uses
        // the home city. Allow when the incoming stop is type=HOME, the matched
        // duplicate is the trip's STARTING HOME (first HOME in sortedStops),
        // and there is not already a closing HOME on the trip.
        const homeStops = sortedStops.filter((s: any) => s.type === 'HOME')
        const startingHome = homeStops[0]
        const isReturnHomeAdd =
          !!duplicate &&
          action.type === 'HOME' &&
          duplicate.type === 'HOME' &&
          duplicate === startingHome &&
          homeStops.length === 1

        if (duplicate && !isReturnHomeAdd) {
          // Throw instead of the old silent no-op bubble: the card shows this
          // verbatim and stays unapplied — never a false success.
          // Report the USER-VISIBLE stop number: the displayed list labels the
          // HOME departure "Starting point" and numbers only the stops after
          // it, while DB `order` counts HOME — duplicate.order would be off
          // by one (e.g. Moab shown as #3 but order=4).
          const visibleNumber =
            sortedStops.filter((s: any) => s.type !== 'HOME').findIndex((s: any) => s.id === duplicate.id) + 1
          const where = duplicate.type === 'HOME'
            ? 'as your home stop'
            : `(stop #${visibleNumber})`
          throw new Error(`${duplicate.locationName} is already on your trip ${where}`)
        }

        // Position resolution:
        // 1. Return-home adds (type=HOME on a trip that already has a HOME start) ALWAYS land at the end.
        //    The AI cannot reliably compute "the end" when stop orders are non-contiguous, so the client forces it.
        // 2. Otherwise resolve the bracket stop by NAME first (MODIFY-ANCHOR-1) —
        //    the numeric afterStopOrder is a fragile fallback.
        // 3. Otherwise, append after the last stop.
        const lastStop = sortedStops[sortedStops.length - 1]
        const forceAppendAsReturnHome =
          action.type === 'HOME' &&
          sortedStops.some((s: any) => s.type === 'HOME')

        let afterStop: any
        if (forceAppendAsReturnHome) {
          afterStop = lastStop
        } else {
          const byName = action.after_stop ? findStop(action.after_stop) : undefined
          const byOrder = action.afterStopOrder != null
            ? sortedStops.find((s: any) => s.order === action.afterStopOrder)
            : undefined
          afterStop = byName ?? byOrder ?? lastStop
        }

        const afterOrder = afterStop?.order ?? (lastStop?.order ?? 0)
        const newOrder = afterOrder + 1
        console.log('[applyMod] add_stop position — after_stop:', action.after_stop, '| afterStop:', afterStop?.locationName, '| newOrder:', newOrder)

        const createRes = await tripsApi.createStop(trip.id, {
          locationName: cleanName,
          locationState: resolvedState || undefined,
          nights: action.nights ?? 1,
          type: action.type ?? 'DESTINATION',
          order: newOrder,
          bookingStatus: 'NOT_BOOKED',
          isCompatible: true,
          modifyActionId, // server stamps the proposal applied=true after the insert
        })
        // ADDSTOP-RESLOT Phase B — the server may have re-slotted the new stop ahead
        // of a booked stop, shifting that booked stop's itinerary date. Surface the
        // heads-up (reservation unchanged; only the trip date moved).
        const shifted = createRes.data?.shiftedBookedStops
        if (Array.isArray(shifted) && shifted.length > 0) {
          setBookedShiftWarning({ newStop: cleanName, stops: shifted })
          // Also fire the center-screen interrupt — grabs attention now while the
          // banner above persists as the record.
          setBookedShiftModalOpen(true)
        }
        break
      }
      case 'remove_stop': {
        const stop = findStop(cleanName)
        if (!stop) throw new Error(`Could not find stop: ${cleanName}`)
        await tripsApi.deleteStop(trip.id, stop.id, modifyActionId)
        break
      }
      case 'change_nights': {
        const stop = findStop(cleanName)
        if (!stop || !action.nights) throw new Error(`Could not find stop or nights missing: ${cleanName}`)
        await tripsApi.updateStop(trip.id, stop.id, { nights: action.nights, modifyActionId })
        break
      }
      case 'suggest_campground': {
        const stop = findStop(cleanName)
        if (!stop || !action.campgroundName) throw new Error('Could not find stop or campground name missing')
        await tripsApi.updateStop(trip.id, stop.id, { campgroundName: action.campgroundName, modifyActionId })
        break
      }
      case 'shift_trip_dates': {
        if (!action.newStartDate) throw new Error('shift_trip_dates missing newStartDate')
        // The shift endpoint returns the full trip (with stops, journal-included)
        // — same shape as tripsApi.get — so we can skip the trailing refetch
        // and pass the response straight to onTripUpdated. Saves one round-trip.
        const shiftRes = await tripsApi.shiftDates(trip.id, { newStartDate: action.newStartDate, modifyActionId })
        onTripUpdated(shiftRes.data)
        return
      }
      case 'change_rig': {
        // RIG-CHANGE Phase 3 — route through the SAME PUT /trips/:id path the
        // trip-page rig selector uses; the server runs the guarded applyRigChange
        // (repoint + larger-rig delta + booked-stop re-verify + NOT_BOOKED
        // refilter) and stamps this proposal via modifyActionId. No parallel
        // rig-change logic here. The trailing refetch below picks up the new rig
        // so the data-derived banner/labels (Phase 2) update.
        if (!action.rigId) throw new Error('change_rig missing rigId')
        await tripsApi.update(trip.id, { rigId: action.rigId, modifyActionId })
        break
      }
      default:
        console.error('Unsupported modify action:', action)
        throw new Error(`Unsupported modify action: ${(action as any).action}`)
    }

    // Refresh trip data and propagate upward
    const res = await tripsApi.get(trip.id)
    onTripUpdated(res.data)
  }

  /** Applies one action with per-card state: applying (disabled, spinner
   *  label) → ✓ applied (mirrors the server's stamp) or failed (server error
   *  shown verbatim on the card, which stays applicable for retry). Returns
   *  success so applyAll can stop on the first failure. */
  async function applyAction(msgIndex: number, sa: ServerModifyAction): Promise<boolean> {
    setApplying(true)
    setBookedShiftWarning(null) // clear any prior heads-up; executeAction re-sets it if this add shifts a booking
    setActionUi(prev => ({ ...prev, [sa.id]: { status: 'applying' } }))
    try {
      await executeAction(sa.action, sa.id)
      // Mirror the server's stamp locally — the mutation endpoint succeeded
      // and stamped applied=true; a reload renders the same state from
      // persisted truth.
      setMessages(prev => prev.map((m, i) =>
        i === msgIndex && m.actions
          ? { ...m, actions: m.actions.map(a => (a.id === sa.id ? { ...a, applied: true } : a)) }
          : m
      ))
      setActionUi(prev => { const { [sa.id]: _gone, ...rest } = prev; return rest })
      return true
    } catch (err: any) {
      console.error('[applyMod] FAILED:', err?.message, err?.response?.status, err?.response?.data)
      // Surface the server's structured error VERBATIM (date conflicts from
      // out-of-order applies, HOME_STOP_PROTECTED, MIN_STOPS_VIOLATION, …) —
      // never swallowed. Axios message is the transport-level fallback.
      const reason = err?.response?.data?.error || err?.message || 'unknown error'
      setActionUi(prev => ({ ...prev, [sa.id]: { status: 'failed', error: reason } }))
      return false
    } finally {
      setApplying(false)
    }
  }

  /** "Apply all" — sequential, in emission order (the model emits execution
   *  order per the AI-MESA-10 contract). Stops on the first failure: that
   *  card shows its error, the rest stay pending. */
  async function applyAll(msgIndex: number, actions: ServerModifyAction[]) {
    for (const sa of actions) {
      if (sa.applied) continue
      const ok = await applyAction(msgIndex, sa)
      if (!ok) break
    }
  }

  return (
    <>
      {/* Backdrop — mobile only */}
      <div
        className={`fixed inset-0 bg-black/25 z-30 transition-opacity duration-300 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        } md:hidden`}
        onClick={onClose}
      />

      {/* Slide-in panel — inset between AppLayout's chrome rather than
          covering it. top-14 clears the sticky header (h-14 = 56px:
          hamburger, logo, clock/bell/profile menu). bottom-14 on mobile
          clears the fixed bottom nav (Home/Trips/Plan/Bookings/Profile),
          which is also ~56px tall; md:bottom-0 lets the panel extend to
          the viewport edge on desktop where there's no bottom nav.

          No h-[100dvh] needed — using top+bottom insets means the panel
          adapts automatically when iOS Safari's URL bar shows/hides.

          z-40 matches the chrome's z-index. Since the panel no longer
          OVERLAPS the chrome (it sits inset between header and bottom
          nav), the same z-index is fine — chrome remains interactive at
          the top and bottom, panel owns the middle. App-level modals
          (Paywall, Feedback) at z-50 still stack above this panel,
          preserving the modal hierarchy. */}
      <div
        className={`fixed top-14 right-0 bottom-14 md:bottom-0 w-full sm:w-[22rem] bg-white border-l border-gray-200 flex flex-col z-40 shadow-2xl transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ borderLeftWidth: '0.5px' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0"
          style={{ borderBottomWidth: '0.5px' }}
        >
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-[#1F6F8B] flex items-center justify-center flex-shrink-0">
              <Wand2 size={12} className="text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 leading-tight">Modify with AI</p>
              <p className="text-[10px] text-gray-400 truncate max-w-[200px]">{trip.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors flex-shrink-0">
            <X size={15} />
          </button>
        </div>

        {/* Quick suggestion chips */}
        <div
          className="px-3 py-2 border-b border-gray-100 flex-shrink-0 overflow-x-auto"
          style={{ borderBottomWidth: '0.5px' }}
        >
          <div className="flex gap-1.5 w-max">
            {QUICK_CHIPS.map(chip => (
              <button
                key={chip}
                onClick={() => sendMessage(chip)}
                disabled={typing || applying}
                className="flex-shrink-0 text-[11px] px-2.5 py-1 rounded-full border border-[#1F6F8B] text-[#1F6F8B] bg-white hover:bg-[#E0F0F4] transition-colors disabled:opacity-40 whitespace-nowrap"
              >
                {chip}
              </button>
            ))}
          </div>
        </div>

        {/* ADDSTOP-RESLOT — center-screen interrupt. Fires alongside the inline
            banner below; "Got it" closes only the modal, the banner persists. */}
        {bookedShiftWarning && (
          <BookedShiftModal
            isOpen={bookedShiftModalOpen}
            newStop={bookedShiftWarning.newStop}
            stops={bookedShiftWarning.stops}
            onDismiss={() => setBookedShiftModalOpen(false)}
          />
        )}

        {/* ADDSTOP-RESLOT Phase B — booked-stop date-shift heads-up (transient,
            set from the createStop response after an add_stop apply). Amber, mirrors
            the rig warning tokens. The reservation is unchanged — only the trip date. */}
        {bookedShiftWarning && (
          <div className="px-3 py-2 border-b border-amber-200 bg-amber-50 flex-shrink-0" style={{ borderBottomWidth: '0.5px' }}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-[11px] font-semibold text-amber-800 flex items-center gap-1">
                <AlertTriangle size={12} className="flex-shrink-0" /> Booked-stop date shifted
              </p>
              <button onClick={() => setBookedShiftWarning(null)} className="text-amber-700 hover:text-amber-900 flex-shrink-0">
                <X size={12} />
              </button>
            </div>
            {bookedShiftWarning.stops.map(s => {
              const orig = parseTripDate(s.originalBookedDate)
              const next = parseTripDate(s.newArrivalDate)
              return (
                <p key={s.stopId} className="text-[11px] text-amber-800 leading-snug mt-0.5">
                  Adding {bookedShiftWarning.newStop} shifted the itinerary date for your booked stop {s.name}. Your reservation is unchanged (still booked for {orig ? format(orig, 'MMM d, yyyy') : s.originalBookedDate}), but its trip date is now {next ? format(next, 'MMM d, yyyy') : s.newArrivalDate}. Verify your booked dates still work, or contact the campground.
                </p>
              )
            })}
          </div>
        )}

        {/* Messages — flex-1 absorbs available vertical space, min-h-0 lets
            this child shrink below its content's intrinsic height (without it
            a tall message list would push the ChatInput sibling offscreen).
            Messages stack from the top via normal block flow; bottomRef +
            scrollIntoView keep the latest message visible on new arrivals. */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5">
          {!historyLoaded && (
            <div className="flex justify-center pt-8">
              <div className="w-4 h-4 border-2 border-[#1F6F8B] border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {historyLoaded && messages.map((msg, i) => (
            <div key={i}>
              {/* Bubble */}
              <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[88%] rounded-xl px-3 py-2.5 text-[13px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-[#1F6F8B] text-white'
                      : 'bg-gray-50 border border-gray-200 text-gray-800'
                  }`}
                  style={{ borderWidth: '0.5px' }}
                >
                  <p className="whitespace-pre-wrap">{cleanChatText(msg.content)}</p>
                </div>
              </div>

              {/* AI-MESA-10 — one card per server-parsed action, rendered in
                  emission order (= execution order per the prompt contract).
                  States: pending (Apply) / applying (disabled, spinner label) /
                  ✓ applied (persisted truth — survives reload) / failed
                  (server error verbatim, card stays applicable for retry). */}
              {msg.role === 'assistant' && msg.actions && msg.actions.length > 0 && (() => {
                const pending = msg.actions.filter(a => !a.applied)
                return (
                  <div className="mt-2 mr-4 space-y-1.5">
                    {msg.actions.map((sa, idx) => {
                      const ui = actionUi[sa.id]
                      if (sa.applied) {
                        return (
                          <div key={sa.id} className="ml-0.5 text-[11px] text-[#0F766E] font-medium">
                            ✅ Applied — {getConfirmationText(sa.action)}
                          </div>
                        )
                      }
                      return (
                        <div key={sa.id} className="bg-white border border-[#1F6F8B]/25 rounded-xl p-3 shadow-sm">
                          <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">
                            Proposed change{msg.actions!.length > 1 ? ` ${idx + 1} of ${msg.actions!.length}` : ''}
                          </p>
                          <p className="text-sm font-medium text-gray-900 mb-1">
                            {getConfirmationText(sa.action)}
                          </p>
                          {(() => {
                            const sub = getConfirmationSubText(sa.action, trip)
                            return sub ? <p className="text-[11px] text-gray-500 mb-2">{sub}</p> : <div className="mb-1.5" />
                          })()}
                          {ui?.status === 'failed' && (
                            <p className="text-[11px] text-red-600 mb-2">⚠️ {ui.error}</p>
                          )}
                          <button
                            onClick={() => applyAction(i, sa)}
                            disabled={applying}
                            className="w-full py-1.5 text-xs font-medium rounded-lg bg-[#F7A829] text-white hover:bg-[#C9851A] transition-colors disabled:opacity-50"
                          >
                            {ui?.status === 'applying'
                              ? 'Applying…'
                              : ui?.status === 'failed'
                                ? 'Try again'
                                : getApplyButtonLabel(sa.action)}
                          </button>
                        </div>
                      )
                    })}
                    {pending.length >= 2 && (
                      <button
                        onClick={() => applyAll(i, msg.actions!)}
                        disabled={applying}
                        className="w-full py-1.5 text-xs font-medium rounded-lg bg-[#1F6F8B] text-white hover:bg-[#17566C] transition-colors disabled:opacity-50"
                      >
                        {applying ? 'Applying…' : `✓ Apply all ${pending.length} changes in order`}
                      </button>
                    )}
                  </div>
                )
              })()}
              {/* Modify-failed notice — server retried once and still got prose
                  with neither a <modify> nor a <clarify> tag (a genuine no-op).
                  Clarifying questions (modifyOutcome==='clarify') do NOT set
                  this flag, so they render without a warning. Matches the
                  styling tier of the Applied / Cancelled siblings above
                  (text-[11px], ml-0.5, font-medium), in amber to signal
                  "warning, action needed" without escalating to a destructive red. */}
              {msg.role === 'assistant' && msg.modifyFailed && (
                <div className="mt-1 ml-0.5 text-[11px] text-amber-700 font-medium">
                  ⚠️ I couldn't apply that change automatically — try rephrasing your request.
                </div>
              )}
            </div>
          ))}

          {/* Typing indicator */}
          {typing && (
            <div className="flex justify-start">
              <div
                className="bg-gray-50 border border-gray-200 rounded-xl"
                style={{ borderWidth: '0.5px' }}
              >
                <TypingIndicator />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div
          className="p-3 border-t border-gray-100 flex-shrink-0"
          style={{ borderTopWidth: '0.5px' }}
        >
          <ChatInput
            ref={inputRef}
            value={input}
            onChange={setInput}
            onSubmit={sendMessage}
            placeholder="Ask AI to modify your trip…"
            disabled={typing || applying}
            loading={typing}
            speechSupported={speechSupported}
            listening={listening}
            onToggleListening={toggleListening}
          />
        </div>
      </div>
    </>
  )
}
