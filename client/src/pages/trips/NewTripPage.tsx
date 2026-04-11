import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Send, MapPin, Tent, User, Loader, Mic, MicOff } from 'lucide-react'
import { aiApi, tripsApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { ChatMessage, User as UserType } from '../../types'

// Extend window type for cross-browser SpeechRecognition
declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition
    webkitSpeechRecognition: typeof SpeechRecognition
  }
}

// ─── Welcome message helpers ─────────────────────────────────────────────────

type VehicleCategory = 'toyHauler' | 'van' | 'camper' | 'rv'

function getVehicleCategory(user: UserType | null): VehicleCategory {
  const rig = user?.rigs?.[0]
  if (!rig) return 'rv'
  if (rig.isToyHauler || rig.vehicleType === 'TOY_HAULER') return 'toyHauler'
  if (rig.isVan || rig.vehicleType === 'VAN') return 'van'
  if (rig.isCamper || rig.vehicleType === 'CAR_CAMPING' || rig.vehicleType === 'POP_UP') return 'camper'
  return 'rv'
}

function getHomeState(homeLocation: string | undefined): string | null {
  if (!homeLocation) return null
  const m = homeLocation.match(/\b([A-Z]{2})\b/)
  return m ? m[1] : null
}

const STATE_REGION: Record<string, string> = {
  AZ: 'southwest', NM: 'southwest', NV: 'southwest', UT: 'southwest',
  CA: 'pacific', OR: 'pacific', WA: 'pacific',
  CO: 'mountain', ID: 'mountain', MT: 'mountain', WY: 'mountain',
  TX: 'texas', OK: 'texas',
  FL: 'southeast', GA: 'southeast', AL: 'southeast', MS: 'southeast',
  TN: 'southeast', NC: 'southeast', SC: 'southeast', VA: 'southeast',
  WV: 'southeast', KY: 'southeast', AR: 'southeast', LA: 'southeast',
  MN: 'midwest', WI: 'midwest', MI: 'midwest', OH: 'midwest',
  IN: 'midwest', IL: 'midwest', IA: 'midwest', MO: 'midwest',
  ND: 'midwest', SD: 'midwest', NE: 'midwest', KS: 'midwest',
  ME: 'northeast', NH: 'northeast', VT: 'northeast', NY: 'northeast',
  MA: 'northeast', CT: 'northeast', RI: 'northeast', NJ: 'northeast',
  PA: 'northeast', MD: 'northeast', DE: 'northeast',
  AK: 'alaska', HI: 'hawaii',
}

const INSPIRATION_BUTTONS: Record<string, Record<VehicleCategory, string[]>> = {
  southwest: {
    toyHauler: ['Glamis & the Imperial Dunes', 'Moab — Fins and slickrock', 'Little Sahara, Utah', 'Baja OHV adventure'],
    van: ['Utah Mighty 5 dispersed loop', 'Nevada Basin & Range BLM run', 'Sedona & Verde Valley', 'Baja Sur coastal route'],
    camper: ['Havasupai & Grand Canyon North Rim', 'Utah Mighty 5 national parks loop', 'White Sands & Guadalupe Mountains', 'Cochise backcountry, Arizona'],
    rv: ['Southwest national parks loop', 'California coast run', 'Rocky Mountain high loop', 'Surprise me with something amazing'],
  },
  pacific: {
    toyHauler: ['Oregon Dunes — ATVs & coast', 'Glamis & Ocotillo Wells', 'Eastern Oregon high desert riding', 'Lake Havasu & Mohave'],
    van: ['Pacific Coast Highway full run', 'Olympic Peninsula dispersed loop', 'Redwoods & Lost Coast', 'Eastern Cascades BLM route'],
    camper: ['Olympic National Park backcountry', 'Redwoods & King Range wilderness', 'North Cascades circuit', 'Crater Lake & Rogue River'],
    rv: ['Pacific Coast Highway run', 'Olympic Peninsula loop', 'California national parks circuit', 'Surprise me with something amazing'],
  },
  mountain: {
    toyHauler: ["Moab — Hell's Revenge & Fins", 'Sand Hollow & Little Sahara', 'Western Colorado — Grand Mesa trails', 'Lander & Pinedale, Wyoming'],
    van: ['Colorado 14ers corridor', 'Beartooth Highway & Absaroka', 'Montana BLM dispersed loop', 'Wind River Range, Wyoming'],
    camper: ['Rocky Mountain NP backcountry', 'Yellowstone & Tetons', 'Colorado Fourteeners circuit', 'Glacier NP off-season gems'],
    rv: ['Yellowstone & Tetons', 'Rocky Mountain high loop', 'Glacier to Banff run', 'Surprise me with something amazing'],
  },
  texas: {
    toyHauler: ['Big Bend Ranch — backcountry riding', 'Palo Duro Canyon, Texas', 'Oklahoma Little Sahara dunes', 'South Texas border run'],
    van: ['Big Bend & Terlingua dispersed', 'Texas Hill Country & Wimberley', 'Davis Mountains & Marfa', 'Gulf Coast barrier islands'],
    camper: ['Big Bend backcountry loop', 'Enchanted Rock & Hill Country', 'Padre Island National Seashore', 'Guadalupe Mountains traverse'],
    rv: ['Big Bend & West Texas loop', 'Hill Country scenic run', 'Gulf Coast snowbird route', 'Surprise me with something amazing'],
  },
  southeast: {
    toyHauler: ['Hatfield-McCoy trail system, WV', 'Tennessee OHV trail network', 'Land Between the Lakes', 'Pocahontas backcountry, WV'],
    van: ['Blue Ridge Parkway dispersed loop', 'Appalachian Trail corridor camps', 'Florida national forests BLM', 'Outer Banks & barrier islands'],
    camper: ['Great Smoky Mountains loop', 'Blue Ridge Parkway full run', 'Florida Keys camping circuit', 'Shenandoah backcountry'],
    rv: ['Great Smoky Mountains loop', 'Blue Ridge Parkway run', 'Florida Gulf Coast circuit', 'Surprise me with something amazing'],
  },
  midwest: {
    toyHauler: ['Black Hills & Badlands OHV', 'Missouri Ozarks trail system', 'Indiana Dunes & sand riding', 'Upper Michigan & Keweenaw'],
    van: ['Great Lakes shoreline loop', 'Boundary Waters canoe country', 'Black Hills & Badlands dispersed', 'Pictured Rocks & Upper Michigan'],
    camper: ['Boundary Waters wilderness', 'Pictured Rocks National Lakeshore', 'Black Hills & Badlands', 'Isle Royale National Park'],
    rv: ['Great Lakes grand loop', 'Black Hills & Badlands', 'Boundary Waters area', 'Surprise me with something amazing'],
  },
  northeast: {
    toyHauler: ['Hatfield-McCoy, West Virginia', 'Vermont & NH mountain trails', 'Pennsylvania Pine Creek OHV', 'New England ATV network'],
    van: ['Maine coast & Acadia dispersed', 'Vermont Green Mountains loop', 'Adirondack backcountry', 'Cape Cod & Islands'],
    camper: ['Acadia National Park', 'Adirondack High Peaks', 'Vermont Long Trail camping', 'White Mountains traverse'],
    rv: ['New England fall foliage loop', 'Acadia & Maine coast run', 'Adirondack circuit', 'Surprise me with something amazing'],
  },
  alaska: {
    toyHauler: ['Kenai Peninsula OHV trails', 'Interior Alaska mining roads', 'Denali access route riding', 'Surprise me with something amazing'],
    van: ['Alaska Highway full run', 'Kenai Fjords & Resurrection Bay', 'Denali Highway interior route', 'Wrangell-St. Elias backcountry'],
    camper: ['Denali backcountry camping', 'Kenai Fjords wilderness', 'Katmai & bear viewing camps', 'Inside Passage adventure'],
    rv: ['Alaska Highway adventure', 'Kenai Peninsula loop', 'Denali & Fairbanks run', 'Surprise me with something amazing'],
  },
  hawaii: {
    toyHauler: ['Maui backcountry Jeep trails', 'Big Island volcanic roads', 'Molokai 4WD coastal route', 'Surprise me with something amazing'],
    van: ['Big Island Saddle Road loop', 'Maui Road to Hana camps', 'Kauai north shore dispersed', 'Oahu Windward coast'],
    camper: ['Na Pali Coast, Kauai', 'Haleakala summit, Maui', 'Big Island Volcanoes NP', 'Waimea Canyon & Kokee'],
    rv: ['Big Island circle tour', 'Maui grand loop', 'Oahu circle island', 'Surprise me with something amazing'],
  },
}

const DEFAULT_BUTTONS: Record<VehicleCategory, string[]> = {
  toyHauler: ['Moab OHV adventure', 'Glamis & California dunes', 'Hatfield-McCoy trail system', 'Surprise me with something amazing'],
  van: ['Utah Mighty 5 dispersed loop', 'Pacific Coast Highway run', 'Rocky Mountain BLM route', 'Surprise me with something amazing'],
  camper: ['National parks grand loop', 'Pacific coastline route', 'Rocky Mountain backcountry', 'Surprise me with something amazing'],
  rv: ['Southwest national parks loop', 'Pacific Coast Highway run', 'Yellowstone & Tetons', 'Surprise me with something amazing'],
}

function buildInspirationButtons(_user: UserType | null): string[] {
  return ['Leaving from home', 'Starting from another city', 'Surprise me!']
}

function buildWelcomeMessage(user: UserType | null): string {
  const name = user?.firstName || 'there'
  const rig = user?.rigs?.[0]
  const profile = user?.travelProfile

  const rigLabel = rig
    ? [rig.year, rig.make, rig.model].filter(Boolean).join(' ') || 'your rig'
    : 'your rig'

  const hasPets = profile?.hasPets ?? false
  const petName: string | undefined = profile?.petDetails?.name
  const petClause = hasPets
    ? ` and ${petName ? petName : 'your pet'} is packed`
    : ''

  return `Hey ${name}! Your ${rigLabel} is ready to roll${petClause}. Where are you starting from and where are we headed? If you're leaving from home just say "home" and I'll use your home city automatically.`
}

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
  // Try with closing tag first (well-formed response)
  let inner = text.match(/<itinerary>([\s\S]*?)<\/itinerary>/)?.[1]
  // Fallback: closing tag missing (truncated response) — grab everything after opening tag
  if (!inner) inner = text.match(/<itinerary>([\s\S]*)/)?.[1]
  if (!inner) return null
  inner = inner.trim()
  try {
    return JSON.parse(inner)
  } catch {
    // Try extracting just the JSON object in case there's trailing noise
    const jsonMatch = inner.match(/\{[\s\S]*\}/)
    if (jsonMatch) { try { return JSON.parse(jsonMatch[0]) } catch { /* fall through */ } }
    return null
  }
}

export default function NewTripPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const [itinerary, setItinerary] = useState<any>(null)
  const [creating, setCreating] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(false)
  const [inspirationDismissed, setInspirationDismissed] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const { user } = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition
    setSpeechSupported(!!SpeechRecognitionAPI)
  }, [])

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setListening(false)
  }, [])

  const toggleListening = useCallback(() => {
    if (listening) {
      stopListening()
      return
    }

    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognitionAPI) return

    const recognition = new SpeechRecognitionAPI()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onstart = () => setListening(true)

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript
      setInput(prev => prev ? `${prev} ${transcript}` : transcript)
    }

    recognition.onerror = () => {
      setListening(false)
      recognitionRef.current = null
    }

    recognition.onend = () => {
      setListening(false)
      recognitionRef.current = null
    }

    recognitionRef.current = recognition
    recognition.start()
  }, [listening, stopListening])

  // Clean up on unmount
  useEffect(() => {
    return () => { stopListening() }
  }, [stopListening])

  useEffect(() => {
    setMessages([{ role: 'assistant', content: buildWelcomeMessage(user) }])
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typing])

  const rig = user?.rigs?.[0]
  const profile = user?.travelProfile

  async function sendMessage(overrideText?: string) {
    const text = overrideText ?? input
    if (!text.trim() || typing) return

    setInspirationDismissed(true)
    const userMsg: ChatMessage = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setTyping(true)

    try {
      const res = await aiApi.chat(newMessages)
      const aiText = res.data.message
      const aiMsg: ChatMessage = { role: 'assistant', content: aiText }
      setMessages([...newMessages, aiMsg])

      const parsed = parseItinerary(aiText)
      if (parsed) setItinerary(parsed)
    } catch (e) {
      setMessages([...newMessages, { role: 'assistant', content: 'Sorry, I had trouble responding. Please try again.' }])
    } finally {
      setTyping(false)
    }
  }

  async function buildItinerary() {
    if (!itinerary) return
    setCreating(true)
    setBuildError(null)
    try {
      // Use user's homeLocation as the trip startLocation so the server-side HOME
      // stop guard has the correct departure city, even if the AI omits the HOME stop.
      const homeStopName = itinerary.stops?.[0]?.type === 'HOME'
        ? itinerary.stops[0].locationName
        : user?.homeLocation || itinerary.stops?.[0]?.locationName || 'Start'

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

      // Create stops — enforce that first and last stops are never OVERNIGHT_ONLY
      const stops: any[] = itinerary.stops || []
      const lastIdx = stops.length - 1
      for (let i = 0; i < stops.length; i++) {
        const stop = stops[i]
        const isEndpoint = i === 0 || i === lastIdx
        const fixedStop = isEndpoint && stop.type === 'OVERNIGHT_ONLY'
          ? { ...stop, type: 'DESTINATION' }
          : stop
        await tripsApi.createStop(trip.data.id, fixedStop)
      }

      navigate(`/trips/${trip.data.id}/map`)
    } catch (e: any) {
      console.error('[buildItinerary] failed:', e)
      const msg = e?.response?.data?.message || e?.message || 'Something went wrong. Please try again.'
      setBuildError(msg)
      setCreating(false)
    }
  }

  const cleanText = (text: string) => text
    .replace(/<itinerary>[\s\S]*?<\/itinerary>/g, '')  // complete tag
    .replace(/<itinerary>[\s\S]*/g, '')                // truncated (no closing tag)
    .trim()

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Profile context bar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-[#E1F5EE] rounded-xl mb-4 text-xs text-[#085041]">
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

      <div className="flex flex-1 gap-4 overflow-hidden">
        {/* Chat */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto space-y-3 pb-2">
            {messages.map((msg, i) => (
              <div key={i}>
                <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${
                    msg.role === 'user'
                      ? 'bg-[#1D9E75] text-white'
                      : 'bg-white border border-gray-200 text-gray-800'
                  }`} style={{ borderWidth: '0.5px' }}>
                    <p className="whitespace-pre-wrap">{cleanText(msg.content)}</p>
                  </div>
                </div>
                {/* Inspiration buttons — shown below welcome message only */}
                {i === 0 && msg.role === 'assistant' && !inspirationDismissed && messages.length === 1 && (
                  <div className="mt-3 flex flex-wrap gap-2 pl-1">
                    {buildInspirationButtons(user).map((label, idx) => (
                      <button
                        key={idx}
                        onClick={() => sendMessage(label)}
                        disabled={typing}
                        className="text-xs px-3 py-1.5 rounded-full border border-[#1D9E75] text-[#1D9E75] bg-white hover:bg-[#E1F5EE] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
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

          {/* Input */}
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

        {/* Itinerary preview (desktop) */}
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
              {/* Stop list scrolls independently — button stays pinned below */}
              <div className="flex-1 overflow-y-auto min-h-0 space-y-2">
                {itinerary.stops?.map((stop: any, i: number) => (
                  <div key={i} className="flex gap-2">
                    <div className="w-5 h-5 bg-[#1D9E75] rounded-full flex items-center justify-center text-white text-xs flex-shrink-0">
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
              {buildError && (
                <p className="text-xs text-red-600 mt-3 text-center">{buildError}</p>
              )}
              <button
                onClick={buildItinerary}
                disabled={creating}
                className="btn-primary w-full mt-4 text-sm flex items-center justify-center gap-2 flex-shrink-0"
              >
                {creating ? (
                  <><Loader size={15} className="animate-spin" /> Building...</>
                ) : (
                  'Build full itinerary'
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Itinerary ready — sticky banner + full-width build button (all screen sizes) */}
      {itinerary && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#E1F5EE] border border-[#1D9E75] rounded-xl">
            <span className="text-[#085041] text-sm font-medium">Your itinerary is ready! Click below to build your full trip.</span>
          </div>
          {buildError && (
            <p className="text-xs text-red-600 text-center">{buildError}</p>
          )}
          <button
            onClick={buildItinerary}
            disabled={creating}
            className="w-full py-3.5 bg-[#1D9E75] hover:bg-[#178a64] active:bg-[#136e54] text-white font-semibold text-base rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm"
          >
            {creating ? (
              <><Loader size={18} className="animate-spin" /> Building your trip...</>
            ) : (
              'Build Full Itinerary →'
            )}
          </button>
        </div>
      )}
    </div>
  )
}
