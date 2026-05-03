import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Send, MapPin, Tent, Users, Loader, Mic, MicOff } from 'lucide-react'
import { aiApi, sessionsApi, tripsApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { ChatMessage } from '../types'
import BottomSheet from '../components/ui/BottomSheet'
import SessionTipCard from '../components/sessions/SessionTipCard'
import { useSessionAutosave } from '../hooks/useSessionAutosave'
import { selectGreeting } from '../utils/greeting'

declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition
    webkitSpeechRecognition: typeof SpeechRecognition
  }
}

// Take the first 40 chars of a user message, cut at the last word boundary if reasonable.
function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 40) return trimmed
  const slice = trimmed.slice(0, 40)
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > 20 ? slice.slice(0, lastSpace) : slice).trim()
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STARTER_CHIPS = [
  'Plan me a surprise trip',
  'I have a destination in mind',
  'Just camping this weekend',
  'Help me pick dates',
]

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
  const [listening, setListening] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [greeting, setGreeting] = useState<string | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const { user } = useAuthStore()
  const navigate = useNavigate()

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
              setItinerary(parsed)
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
      partialTripData: {},
      ...(sessionTitle ? { title: sessionTitle } : {}),
    }
  )

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    setSpeechSupported(!!SR)
  }, [])

  const stopListening = useCallback(() => {
    if (recognitionRef.current) { recognitionRef.current.stop(); recognitionRef.current = null }
    setListening(false)
  }, [])

  const toggleListening = useCallback(() => {
    if (listening) { stopListening(); return }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return
    const rec = new SR()
    rec.continuous = false
    rec.interimResults = false
    rec.lang = 'en-US'
    rec.onstart  = () => setListening(true)
    rec.onresult = (e: SpeechRecognitionEvent) => {
      const t = e.results[0][0].transcript
      setInput(prev => prev ? `${prev} ${t}` : t)
    }
    rec.onerror = () => { setListening(false); recognitionRef.current = null }
    rec.onend   = () => { setListening(false); recognitionRef.current = null }
    recognitionRef.current = rec
    rec.start()
  }, [listening, stopListening])

  useEffect(() => () => stopListening(), [stopListening])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typing])

  const rig      = user?.rigs?.[0]
  const profile  = user?.travelProfile

  async function sendMessage(overrideText?: string) {
    const text = (overrideText ?? input).trim()
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
      const res = await aiApi.chat(next, undefined, undefined, sessionId)
      const aiText = res.data.message
      setMessages([...next, { role: 'assistant', content: aiText }])
      const parsed = parseItinerary(aiText)
      if (parsed) setItinerary(parsed)
    } catch {
      setMessages([...next, { role: 'assistant', content: 'Sorry, I had trouble responding. Please try again.' }])
    } finally {
      setTyping(false)
    }
  }

  function applyChip(text: string) {
    setInput(text)
    inputRef.current?.focus()
  }

  async function buildItinerary() {
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
        startLocation: homeStopName,
        endLocation: itinerary.stops?.[itinerary.stops.length - 1]?.locationName || 'End',
        totalMiles: itinerary.totalMiles,
        totalNights: itinerary.totalNights,
        estimatedFuel: itinerary.estimatedFuel,
        estimatedCamp: itinerary.estimatedCamp,
      })
      const tripId = promoted.data.trip.id
      console.timeEnd('[buildItinerary] promoteSession')

      tripsApi.update(tripId, { aiConversation: messages }).catch(err =>
        console.error('[buildItinerary] failed to attach aiConversation to trip:', err)
      )

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

      tripsApi.generateItinerary(tripId).catch(err =>
        console.error('[buildItinerary] generateItinerary failed in background:', err)
      )

      console.timeEnd('[buildItinerary] total')
      navigate(`/trips/${tripId}/map`)
    } catch (e: any) {
      console.error('[buildItinerary] failed:', e)
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
  const rigName = rig
    ? [rig.year, rig.make, rig.model].filter(Boolean).join(' ').trim()
    : ''
  const rigChipText = rigName
    ? rig?.length
      ? `${rigName} (${rig.length}ft)`
      : rigName
    : ''
  const partyChipText = profile
    ? `${profile.adults} adult${profile.adults !== 1 ? 's' : ''}${profile.hasPets ? ', pets' : ''}`
    : ''
  const styleChipText = profile?.hookupPreference
    ? profile.hookupPreference.replace(/_/g, ' ').toLowerCase()
    : ''
  const showRigStrip = !!(rigChipText || partyChipText || styleChipText)

  return (
    <div className="flex flex-col min-h-[calc(100dvh-8rem)] md:h-[calc(100dvh-8rem)]">
      {/* Main area: chat column + optional itinerary sidebar */}
      <div className="flex flex-1 gap-4 overflow-hidden min-h-0">

        <div className="flex-1 flex flex-col overflow-hidden min-h-0">

          {isEmptyState ? (
            // ── Pre-conversation: hero greeting + chips + input + tip + watermark
            <div className="flex-1 flex flex-col items-center justify-center px-2">
              {/* Hero greeting */}
              {greeting && (
                <h1
                  className="text-center mx-auto pt-6 md:pt-12"
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
                  {rigChipText && (
                    <span className="inline-flex items-center" style={{ gap: 6 }}>
                      <MapPin size={14} aria-hidden="true" color="#1F6F8B" />
                      {rigChipText}
                    </span>
                  )}
                  {partyChipText && (
                    <span className="inline-flex items-center" style={{ gap: 6 }}>
                      <Users size={14} aria-hidden="true" color="#1F6F8B" />
                      {partyChipText}
                    </span>
                  )}
                  {styleChipText && (
                    <span className="inline-flex items-center" style={{ gap: 6 }}>
                      <Tent size={14} aria-hidden="true" color="#1F6F8B" />
                      {styleChipText}
                    </span>
                  )}
                </div>
              )}

              <div className="w-full max-w-[600px]">
                <div
                  className="flex items-center gap-2 bg-white"
                  style={{
                    border: '0.5px solid #E8E4DA',
                    borderRadius: 8,
                    padding: '6px 6px 6px 16px',
                  }}
                >
                  <input
                    ref={inputRef}
                    aria-label="Message RoamReady AI"
                    className="flex-1 bg-transparent outline-none text-sm py-2"
                    style={{ paddingTop: 8, paddingBottom: 8 }}
                    placeholder="Tell me about your trip — where, when, who's coming, anything special..."
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
                    disabled={typing}
                  />
                  {speechSupported && (
                    <button
                      type="button"
                      onClick={toggleListening}
                      disabled={typing}
                      title={listening ? 'Stop listening' : 'Speak your message'}
                      className={`relative flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                        listening
                          ? 'bg-red-50 text-red-600 hover:bg-red-100'
                          : 'text-gray-500 hover:bg-gray-100'
                      }`}
                    >
                      {listening && (
                        <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                      )}
                      {listening ? <MicOff size={16} /> : <Mic size={16} />}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => sendMessage()}
                    disabled={!input.trim() || typing}
                    aria-label="Send message"
                    className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: '#F7A829' }}
                    onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#C9851A' }}
                    onMouseLeave={e => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#F7A829' }}
                  >
                    {typing ? <Loader size={16} className="animate-spin" /> : <Send size={16} />}
                  </button>
                </div>

                {/* Starter chips */}
                <div className="flex flex-wrap gap-2 justify-center mt-3">
                  {STARTER_CHIPS.map(chip => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => applyChip(chip)}
                      className="transition-colors"
                      style={{
                        background: 'transparent',
                        border: '0.5px solid #E8E4DA',
                        borderRadius: 8,
                        padding: '8px 14px',
                        fontSize: 13,
                        color: '#5F5E5A',
                        minHeight: 36,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#F5F4F2' }}
                      onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
                    >
                      {chip}
                    </button>
                  ))}
                </div>

                {/* Tip card */}
                <div style={{ marginTop: 24 }}>
                  <SessionTipCard />
                </div>

                {/* Example fallback line */}
                <p
                  className="italic text-center"
                  style={{ fontSize: 12, color: '#888780', marginTop: 16 }}
                >
                  or try: "Plan a 5-night trip to Moab starting next Saturday"
                </p>
              </div>
              {/* Watermark — flow-positioned below the empty-state content */}
              <div
                aria-hidden="true"
                className="pointer-events-none select-none whitespace-nowrap overflow-hidden text-center"
                style={{
                  width: '100%',
                  marginTop: 48,
                  opacity: 0.12,
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  lineHeight: 1,
                  fontSize: 'clamp(48px, 12vw, 120px)',
                }}
              >
                <span style={{ color: '#1F6F8B' }}>Roam</span>
                <span style={{ color: '#F7A829' }}>Ready</span>
                <span style={{ color: '#1F6F8B' }}>.ai</span>
              </div>
            </div>
          ) : (
            // ── Active conversation: history + bottom-pinned input ────────────
            <>
              <div className="flex-1 overflow-y-auto space-y-3 pb-2">
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
                      <p className="whitespace-pre-wrap">{cleanText(msg.content)}</p>
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

              {/* Mobile-only peek tab — shown when itinerary is ready */}
              {itinerary && (
                <button
                  type="button"
                  onClick={() => setSheetOpen(true)}
                  className="lg:hidden flex items-center justify-between gap-2 mt-3 px-4 py-2.5 bg-[#E0F0F4] border border-[#1F6F8B]/20 rounded-xl text-sm hover:bg-[#1F6F8B]/10 transition-colors"
                  style={{ borderWidth: '0.5px' }}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="text-base flex-shrink-0">🗺️</span>
                    <span className="font-medium text-[#1F6F8B] truncate">{itinerary.name}</span>
                    <span className="text-xs text-[#134756] flex-shrink-0">
                      · {itinerary.totalNights}n · ${((itinerary.estimatedFuel || 0) + (itinerary.estimatedCamp || 0)).toLocaleString()}
                    </span>
                  </div>
                  <span className="text-sm text-[#1F6F8B] font-medium flex-shrink-0">Review →</span>
                </button>
              )}

              {/* Chat input — pinned to bottom */}
              <div className="flex gap-2 mt-3">
                <input
                  ref={inputRef}
                  aria-label="Message RoamReady AI"
                  className="input flex-1"
                  placeholder="Message RoamReady AI..."
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
                  disabled={typing}
                />
                {speechSupported && (
                  <button
                    type="button"
                    onClick={toggleListening}
                    disabled={typing}
                    title={listening ? 'Stop listening' : 'Speak your message'}
                    className={`relative px-3 rounded-lg border transition-colors flex items-center justify-center ${
                      listening
                        ? 'bg-red-50 border-red-300 text-red-600 hover:bg-red-100'
                        : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {listening && (
                      <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                    )}
                    {listening ? <MicOff size={16} /> : <Mic size={16} />}
                  </button>
                )}
                <button
                  onClick={() => sendMessage()}
                  disabled={!input.trim() || typing}
                  className="btn-primary px-3 flex items-center gap-1"
                >
                  {typing ? <Loader size={16} className="animate-spin" /> : <Send size={16} />}
                </button>
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
                <div>~${((itinerary.estimatedFuel || 0) + (itinerary.estimatedCamp || 0)).toLocaleString()}</div>
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
                onClick={buildItinerary}
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
                <div>~${((itinerary.estimatedFuel || 0) + (itinerary.estimatedCamp || 0)).toLocaleString()}</div>
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
                onClick={buildItinerary}
                disabled={creating}
                className="btn-primary w-full mt-4 text-sm flex items-center justify-center gap-2 flex-shrink-0"
              >
                {creating ? <><Loader size={15} className="animate-spin" /> Building...</> : 'Build full itinerary'}
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}
