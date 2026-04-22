import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Send, MapPin, Tent, User, Loader, Mic, MicOff, CalendarDays, X, Home } from 'lucide-react'
import { DayPicker, DateRange } from 'react-day-picker'
import 'react-day-picker/style.css'
import { Autocomplete, useJsApiLoader } from '@react-google-maps/api'
import { aiApi, tripsApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { ChatMessage, User as UserType } from '../../types'

const LIBRARIES: Parameters<typeof useJsApiLoader>[0]['libraries'] = ['marker', 'geometry', 'places']

declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition
    webkitSpeechRecognition: typeof SpeechRecognition
  }
}

// ─── Greeting helpers ─────────────────────────────────────────────────────────

function buildGreeting(user: UserType | null): string {
  const name = user?.firstName || 'there'
  const rig = user?.rigs?.[0]
  const profile = user?.travelProfile
  const rigLabel = rig
    ? [rig.year, rig.make, rig.model].filter(Boolean).join(' ') || 'your rig'
    : 'your rig'
  const hasPets = profile?.hasPets ?? false
  const petName: string | undefined = profile?.petDetails?.name
  const petLine = hasPets ? `${petName ?? 'your pet'} is packed` : "let's hit the road"
  return `Hey ${name}! Your ${rigLabel} is ready to roll and ${petLine}.`
}

// Used as messages[0] content (conversation context sent to AI)
function buildWelcomeMessage(user: UserType | null): string {
  return (
    buildGreeting(user) +
    "\n\nFill out the form below to get started — the form is optional. You can also type everything in the chat and I'll ask about dates, nights, and destination as we go."
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDateRange(range: DateRange | undefined): string {
  if (!range?.from) return ''
  if (!range.to || range.to.getTime() === range.from.getTime()) return fmtDate(range.from)
  return `${fmtDate(range.from)} – ${fmtDate(range.to)}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function NewTripPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const [itinerary, setItinerary] = useState<any>(null)
  const [creating, setCreating] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(false)

  // Committed date range (shown in trigger, included in message)
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined)
  // In-progress range inside the open calendar (2-step selection)
  const [liveRange, setLiveRange] = useState<DateRange | undefined>(undefined)
  // Range that was committed before the current calendar session (for cancel)
  const prevRangeRef = useRef<DateRange | undefined>(undefined)
  const [calendarOpen, setCalendarOpen] = useState(false)

  const [nights, setNights] = useState('')
  // Starting location: empty string = use home default; non-empty = custom override
  const [startLocation, setStartLocation] = useState('')
  const [editingStart, setEditingStart] = useState(false)
  const startAutoRef = useRef<google.maps.places.Autocomplete | null>(null)
  const [destination, setDestination] = useState('')
  const destAutoRef  = useRef<google.maps.places.Autocomplete | null>(null)
  const destInputRef = useRef<HTMLInputElement | null>(null)
  const calendarRef = useRef<HTMLDivElement>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const { user } = useAuthStore()
  const navigate = useNavigate()

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
    libraries: LIBRARIES,
  })

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    setSpeechSupported(!!SR)
  }, [])

  // Auto-calc nights from committed range (stays manually editable)
  useEffect(() => {
    if (dateRange?.from && dateRange?.to) {
      const diff = Math.round((dateRange.to.getTime() - dateRange.from.getTime()) / 86_400_000)
      // Same-day selection → treat as 1 night per spec
      setNights(String(diff === 0 ? 1 : diff))
    }
  }, [dateRange])

  // Close calendar on outside click → cancel (revert live to committed)
  useEffect(() => {
    if (!calendarOpen) return
    function handleOutside(e: MouseEvent) {
      if (calendarRef.current && !calendarRef.current.contains(e.target as Node)) {
        setLiveRange(prevRangeRef.current)
        setCalendarOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [calendarOpen])

  function openCalendar() {
    prevRangeRef.current = dateRange
    setLiveRange(dateRange)
    setCalendarOpen(true)
  }

  // 2-step selection:
  // • First click  → set from only, stay open
  // • Second click → set complete range, commit + close
  //
  // addToRange (react-day-picker internals) sets to:=date on first click when initial
  // range is empty (min=0). We detect "first click" by whether liveRange currently has
  // a from but no to — if not, this is the start of a new selection.
  function handleDateSelect(incoming: DateRange | undefined) {
    const hadFrom = !!(liveRange?.from)
    const hadTo   = !!(liveRange?.to)

    if (!hadFrom || hadTo) {
      // No prior from, OR range was already complete → start fresh, first click only
      // Force to:undefined regardless of what addToRange computed
      setLiveRange(incoming ? { from: incoming.from, to: undefined } : undefined)
      // Stay open — waiting for arrival date
    } else {
      // from was set, to was not → this is the second click
      const final = incoming ?? undefined
      setLiveRange(final)
      setDateRange(final)
      setCalendarOpen(false)
    }
  }

  function clearDates() {
    setDateRange(undefined)
    setLiveRange(undefined)
    setNights('')
  }

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
    setMessages([{ role: 'assistant', content: buildWelcomeMessage(user) }])
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typing])

  const rig      = user?.rigs?.[0]
  const profile  = user?.travelProfile
  // Show full street address when available; fall back to homeLocation or city/state
  const homeLabel = user?.homeAddress || user?.homeLocation
    || (user?.homeCity && user?.homeState ? `${user.homeCity}, ${user.homeState}` : 'Home')

  function onDestPlaceChanged() {
    const place = destAutoRef.current?.getPlace()
    const name = place?.name || ''
    const addr = place?.formatted_address || ''
    const hasName = name && addr && !addr.startsWith(name)
    const value = hasName ? `${name}, ${addr}` : addr || name
    setDestination(value)
    if (destInputRef.current) destInputRef.current.value = value
  }

  function onStartPlaceChanged() {
    const place = startAutoRef.current?.getPlace()
    const name = place?.name || ''
    const addr = place?.formatted_address || ''
    // Prefer "Place Name, City, State" for POIs; plain address for street addresses
    const hasName = name && addr && !addr.startsWith(name)
    setStartLocation(hasName ? `${name}, ${addr}` : addr || name)
    setEditingStart(false)
  }

  async function sendMessage(overrideText?: string) {
    const text = (overrideText ?? input).trim()
    if (!text || typing) return
    const userMsg: ChatMessage = { role: 'user', content: text }
    const next = [...messages, userMsg]
    setMessages(next)
    setInput('')
    setTyping(true)
    try {
      const res = await aiApi.chat(next)
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

  function handleFormSubmit() {
    const dest       = destination.trim()
    const isSurprise = !dest
    const from       = startLocation.trim()  // empty = home (AI knows from profile)
    const nightsNum  = nights !== '' ? parseInt(nights, 10) : NaN
    const nightsStr  = !isNaN(nightsNum) ? `${nightsNum} night${nightsNum !== 1 ? 's' : ''}` : ''

    let msg: string
    if (isSurprise) {
      msg = 'Plan a surprise trip'
      if (from)            msg += ` from ${from}`
      if (dateRange?.from) msg += `, leaving ${fmtDate(dateRange.from)}`
      if (nightsStr)       msg += `, ${nightsStr}`
      else if (dateRange?.to) msg += `, arriving at destination around ${fmtDate(dateRange.to)}`
      msg += '. Pick a destination you think would be great for me based on my rig, travel style, pet-friendly requirements, and the season. Explain briefly why you chose it, then plan the itinerary.'
    } else {
      msg = from ? `Plan a one-way trip from ${from} to ${dest}` : `Plan a one-way trip to ${dest}`
      if (dateRange?.from) msg += `, leaving ${fmtDate(dateRange.from)}`
      if (nightsStr)       msg += `, ${nightsStr}`
      else if (dateRange?.to) msg += `, arriving at destination around ${fmtDate(dateRange.to)}`
      msg += '.'
    }
    sendMessage(msg)
  }

  async function buildItinerary() {
    if (!itinerary) return
    setCreating(true)
    setBuildError(null)
    try {
      const homeStopName = itinerary.stops?.[0]?.type === 'HOME'
        ? itinerary.stops[0].locationName
        : user?.homeLocation || itinerary.stops?.[0]?.locationName || 'Start'

      console.time('[buildItinerary] total')

      console.time('[buildItinerary] createTrip')
      const trip = await tripsApi.create({
        name: itinerary.name,
        startLocation: homeStopName,
        endLocation: itinerary.stops?.[itinerary.stops.length - 1]?.locationName || 'End',
        totalMiles: itinerary.totalMiles,
        totalNights: itinerary.totalNights,
        estimatedFuel: itinerary.estimatedFuel,
        estimatedCamp: itinerary.estimatedCamp,
        status: 'PLANNING',
        aiConversation: messages,
      })
      console.timeEnd('[buildItinerary] createTrip')

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
        await tripsApi.createStop(trip.data.id, fixedStop)
        console.timeEnd(`[buildItinerary] createStop[${i}] ${stop.locationName}`)
      }
      console.timeEnd('[buildItinerary] createStops')

      console.time('[buildItinerary] reassignPOIs')
      await tripsApi.reassignPOIs(trip.data.id)
      console.timeEnd('[buildItinerary] reassignPOIs')

      console.time('[buildItinerary] generateItinerary')
      await tripsApi.generateItinerary(trip.data.id)
      console.timeEnd('[buildItinerary] generateItinerary')

      console.timeEnd('[buildItinerary] total')
      navigate(`/trips/${trip.data.id}/map`)
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

  // Trigger label: show live range while calendar is open (so user sees partial selection)
  const displayRange  = calendarOpen ? liveRange : dateRange
  const dateRangeLabel = fmtDateRange(displayRange)

  // Calendar footer hint — tells user which step they're on
  const calendarFooter = (
    <p className="text-xs text-center text-gray-400 py-2 border-t border-gray-100 mt-1">
      {liveRange?.from && !liveRange?.to
        ? '✈️ Now pick your arrival date'
        : '📅 Pick your departure date'}
    </p>
  )

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Google Places pac-container overrides — wider dropdown, app styling */}
      <style>{`
        .pac-container {
          min-width: 420px !important;
          max-width: 90vw !important;
          z-index: 9999 !important;
          border-radius: 0.75rem !important;
          border: 0.5px solid #e5e7eb !important;
          box-shadow: 0 10px 25px -5px rgba(0,0,0,0.12), 0 4px 6px -2px rgba(0,0,0,0.06) !important;
          font-family: inherit !important;
          margin-top: 4px !important;
        }
        .pac-item {
          padding: 8px 12px !important;
          font-size: 0.8125rem !important;
          cursor: pointer !important;
          white-space: normal !important;
          line-height: 1.4 !important;
        }
        .pac-item:hover, .pac-item.pac-item-selected {
          background-color: #EFF6FF !important;
        }
        .pac-item-query {
          font-size: 0.8125rem !important;
          color: #111827 !important;
        }
        .pac-matched { font-weight: 600 !important; }
        .pac-icon { margin-top: 3px !important; }
      `}</style>

      {/* Profile context bar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-[#EFF6FF] rounded-xl mb-3 text-xs text-[#1E3A8A] flex-shrink-0">
        {rig && (
          <span className="flex items-center gap-1">
            <MapPin size={12} />
            {rig.year} {rig.make} {rig.model} ({rig.length}ft)
          </span>
        )}
        {profile && (
          <span className="flex items-center gap-1">
            <User size={12} />
            {profile.adults} adult{profile.adults !== 1 ? 's' : ''}
            {profile.children > 0 ? `, ${profile.children} kids` : ''}
            {profile.hasPets ? ', pets' : ''}
          </span>
        )}
        {profile && (
          <span className="flex items-center gap-1">
            <Tent size={12} />
            {profile.hookupPreference?.replace('_', ' ').toLowerCase() || 'any hookup'}
          </span>
        )}
      </div>

      {/* Block A — Greeting */}
      <div className="flex items-center gap-3 border-l-4 border-[#1E3A8A] bg-[#EFF6FF] rounded-r-xl px-4 py-3 mb-2 flex-shrink-0">
        <span className="text-2xl leading-none flex-shrink-0">🏕️</span>
        <p className="text-base font-medium text-gray-900">{buildGreeting(user)}</p>
      </div>

      {/* Block B — Instructions */}
      <div className="flex items-start gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3 mb-3 flex-shrink-0" style={{ borderWidth: '0.5px' }}>
        <span className="text-lg leading-none mt-0.5 flex-shrink-0">💡</span>
        <div className="text-sm text-gray-600 min-w-0">
          <p>
            Fill out the form below to get started —{' '}
            <span className="font-medium text-gray-800">the form is optional.</span>{' '}
            You can also just type everything in the chat and I'll ask about dates, destination, and nights as we go.
          </p>
          <p className="mt-1 text-gray-400 italic text-xs">
            Example: "Plan a trip to Moab for 3 nights starting next Saturday."
          </p>
        </div>
      </div>

      {/* Compact form row — horizontal on desktop, stacked on mobile */}
      <div
        className="bg-white border border-gray-200 rounded-xl px-4 py-3 mb-3 flex-shrink-0"
        style={{ borderWidth: '0.5px' }}
      >
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:items-end">

          {/* Trip dates — range picker */}
          <div className="w-full sm:w-64 relative flex-shrink-0" ref={calendarRef}>
            <label className="block text-xs text-gray-500 mb-1">Trip dates</label>
            <button
              type="button"
              onClick={openCalendar}
              className="input w-full text-sm text-left flex items-center justify-between gap-1"
            >
              <span className={dateRangeLabel ? 'text-gray-800 truncate' : 'text-gray-400'}>
                {dateRangeLabel || 'Select dates…'}
              </span>
              <span className="flex items-center gap-0.5 text-gray-400 flex-shrink-0">
                {dateRangeLabel && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={e => { e.stopPropagation(); clearDates() }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); clearDates() } }}
                    className="hover:text-gray-600 cursor-pointer p-0.5"
                  >
                    <X size={12} />
                  </span>
                )}
                <CalendarDays size={14} />
              </span>
            </button>

            {calendarOpen && (
              <div
                className="absolute left-0 top-full z-50 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden"
                style={{ borderWidth: '0.5px' }}
              >
                {/* Brand color overrides for react-day-picker */}
                <div style={{ '--rdp-accent-color': '#1E3A8A', '--rdp-accent-background-color': '#EFF6FF' } as React.CSSProperties}>
                  <DayPicker
                    mode="range"
                    selected={liveRange}
                    onSelect={handleDateSelect}
                    disabled={{ before: new Date() }}
                    numberOfMonths={2}
                    pagedNavigation
                    footer={calendarFooter}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Nights */}
          <div className="w-full sm:w-20 flex-shrink-0">
            <label className="block text-xs text-gray-500 mb-1">Nights</label>
            <input
              type="number"
              min={0}
              value={nights}
              onChange={e => setNights(e.target.value)}
              placeholder="—"
              className="input w-full text-sm"
            />
          </div>

          {/* Starting location */}
          <div className="w-full sm:w-56 flex-shrink-0">
            <label className="block text-xs text-gray-500 mb-1">Starting from</label>
            {editingStart ? (
              <div className="flex items-center gap-1">
                {isLoaded ? (
                  <Autocomplete
                    onLoad={ac => { startAutoRef.current = ac }}
                    onPlaceChanged={onStartPlaceChanged}
                    options={{ types: [] }}
                  >
                    <input
                      autoFocus
                      className="input w-full text-sm"
                      placeholder="Address, campground, city…"
                      defaultValue={startLocation}
                      onKeyDown={e => { if (e.key === 'Escape') setEditingStart(false) }}
                    />
                  </Autocomplete>
                ) : (
                  <input
                    autoFocus
                    className="input w-full text-sm"
                    placeholder="Address, campground, city…"
                    value={startLocation}
                    onChange={e => setStartLocation(e.target.value)}
                    onBlur={() => setEditingStart(false)}
                  />
                )}
                <button
                  type="button"
                  onClick={() => { setStartLocation(''); setEditingStart(false) }}
                  className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                  title="Reset to home"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditingStart(true)}
                title={startLocation || homeLabel}
                className="input w-full text-sm text-left flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 transition-colors overflow-hidden"
              >
                {startLocation ? (
                  <span className="text-gray-800 truncate min-w-0 flex-1">{startLocation}</span>
                ) : (
                  <>
                    <Home size={13} className="text-[#1E3A8A] flex-shrink-0" />
                    <span className="text-gray-700 truncate min-w-0 flex-1">{homeLabel}</span>
                  </>
                )}
                {startLocation && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={e => { e.stopPropagation(); setStartLocation('') }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); setStartLocation('') } }}
                    className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                  >
                    <X size={12} />
                  </span>
                )}
              </button>
            )}
          </div>

          {/* Destination */}
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-500 mb-1">Destination</label>
            {isLoaded ? (
              <Autocomplete
                onLoad={ac => { destAutoRef.current = ac }}
                onPlaceChanged={onDestPlaceChanged}
                options={{ types: [] }}
              >
                <input
                  ref={destInputRef}
                  className="input w-full text-sm"
                  placeholder="Where to? Leave blank to let me plan a random trip for you"
                  defaultValue={destination}
                  onChange={e => setDestination(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleFormSubmit() }}
                />
              </Autocomplete>
            ) : (
              <input
                className="input w-full text-sm"
                placeholder="Where to? Leave blank to let me plan a random trip for you"
                value={destination}
                onChange={e => setDestination(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleFormSubmit() }}
              />
            )}
          </div>

          {/* Submit — spacer label keeps button bottom-aligned with inputs on desktop */}
          <div className="w-full sm:w-auto flex-shrink-0 flex flex-col">
            <span className="hidden sm:block text-xs mb-1 opacity-0" aria-hidden>x</span>
            <button
              onClick={handleFormSubmit}
              disabled={typing}
              className="w-full sm:w-auto px-5 py-[7px] bg-[#EA6A0A] hover:bg-[#C2580A] active:bg-[#A84D09] text-white font-semibold text-sm rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap"
            >
              Plan my trip →
            </button>
          </div>
        </div>
      </div>

      {/* Main area: chat column + optional itinerary sidebar */}
      <div className="flex flex-1 gap-4 overflow-hidden min-h-0">

        {/* Chat column — messages + input only */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <div className="flex-1 overflow-y-auto space-y-3 pb-2">
            {messages.slice(1).map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${
                    msg.role === 'user'
                      ? 'bg-[#1E3A8A] text-white'
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

          {/* Chat input */}
          <div className="flex gap-2 mt-3">
            <input
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
        </div>

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
                    <div className="w-5 h-5 bg-[#1E3A8A] rounded-full flex items-center justify-center text-white text-xs flex-shrink-0">
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
