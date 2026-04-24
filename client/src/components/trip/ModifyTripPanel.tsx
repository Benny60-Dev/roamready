import { useEffect, useRef, useState } from 'react'
import { X, Send, Wand2 } from 'lucide-react'
import { aiApi, tripsApi } from '../../services/api'
import { Trip, StopType } from '../../types'

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
  action: 'add_stop' | 'remove_stop' | 'change_nights' | 'suggest_campground'
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
}

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  modifyAction?: ModifyAction
  modifyApplied?: boolean
  modifyCancelled?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseModify(text: string): ModifyAction | null {
  const match = text.match(/<modify>([\s\S]*?)<\/modify>/)
  if (!match) return null
  try {
    return JSON.parse(match[1].trim()) as ModifyAction
  } catch {
    return null
  }
}

function cleanText(text: string): string {
  return text.replace(/<modify>[\s\S]*?<\/modify>/g, '').trim()
}

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
    default:
      return 'Apply this change'
  }
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
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Load persisted modify conversation when trip changes OR panel is opened.
  // isOpen is included so the history refreshes from DB every time the panel
  // is opened — otherwise cleared/updated history won't appear until navigation.
  useEffect(() => {
    if (!isOpen) return
    setHistoryLoaded(false)
    aiApi.getModifyHistory(trip.id)
      .then(res => {
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = res.data ?? []
        if (history.length === 0) {
          setMessages([{ role: 'assistant', content: GREETING(trip.name) }])
        } else {
          setMessages(history.map(m => {
            if (m.role !== 'assistant') return m
            const modifyAction = parseModify(m.content)
            return modifyAction ? { ...m, modifyAction, modifyApplied: true } : m
          }))
        }
      })
      .catch(() => {
        setMessages([{ role: 'assistant', content: GREETING(trip.name) }])
      })
      .finally(() => setHistoryLoaded(true))
  }, [trip.id, isOpen])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typing])

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 300)
    }
  }, [isOpen])

  async function sendMessage(overrideText?: string) {
    const text = (overrideText ?? input).trim()
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
      const apiMessages = newMessages.map(m => ({ role: m.role, content: m.content }))
      const res = await aiApi.chat(apiMessages, trip.id, 'modify')
      const aiText: string = res.data.message

      const modifyAction = parseModify(aiText)
      const aiMsg: ChatMsg = {
        role: 'assistant',
        content: aiText,
        ...(modifyAction ? { modifyAction } : {}),
      }
      setMessages(prev => [...prev, aiMsg])
    } catch {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: 'Sorry, I had trouble responding. Please try again.' },
      ])
    } finally {
      setTyping(false)
    }
  }

  async function applyModification(msgIndex: number, action: ModifyAction) {
    console.log('[applyMod] ENTRY — msgIndex:', msgIndex, '| action:', JSON.stringify(action))
    setApplying(true)
    try {
      // Fetch fresh trip data from the DB so position math uses current stop orders,
      // not the (potentially stale) React prop captured at last render.
      const freshRes = await tripsApi.get(trip.id)
      const freshStops = freshRes.data.stops ?? []
      const sortedStops = [...freshStops].sort((a: any, b: any) => a.order - b.order)
      console.log('[applyMod] freshStops count:', sortedStops.length, '| stops:', sortedStops.map((s: any) => s.order + ':' + s.locationName))

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

      if (action.action === 'add_stop') {
        // Duplicate guard — block if a stop with a matching name already exists
        const locationNeedle = cleanName.toLowerCase()
        const duplicate = locationNeedle ? sortedStops.find(
          (s: any) =>
            s.locationName.toLowerCase().includes(locationNeedle) ||
            locationNeedle.includes(s.locationName.toLowerCase())
        ) : undefined
        console.log('[applyMod] duplicate check — needle:', locationNeedle, '| duplicate:', duplicate ? duplicate.locationName : 'none')
        if (duplicate) {
          setMessages(prev => [
            ...prev,
            { role: 'assistant', content: `${duplicate.locationName} is already on your trip (stop #${duplicate.order}). No change was made.` },
          ])
          setApplying(false)
          return
        }

        // Resolve insertion position: new schema uses afterStopOrder (number), legacy uses after_stop (name).
        // Server uses integer shift-up, so we send afterOrder + 1 (no fractional midpoints needed).
        const afterStop = action.afterStopOrder != null
          ? sortedStops.find((s: any) => s.order === action.afterStopOrder)
          : (findStop(action.after_stop) ?? sortedStops[sortedStops.length - 2])
        const afterOrder = afterStop?.order ?? (sortedStops[sortedStops.length - 1]?.order ?? 0)
        const newOrder = afterOrder + 1
        console.log('[applyMod] position — afterStop:', afterStop?.locationName, '| afterOrder:', afterOrder, '| newOrder:', newOrder)

        const payload = {
          locationName: cleanName,
          locationState: resolvedState || undefined,
          nights: action.nights ?? 1,
          type: action.type ?? 'DESTINATION',
          order: newOrder,
          bookingStatus: 'NOT_BOOKED',
          isCompatible: true,
        }
        console.log('[applyMod] calling createStop with payload:', JSON.stringify(payload))
        const createRes = await tripsApi.createStop(trip.id, payload)
        console.log('[applyMod] createStop response status:', createRes.status, '| data:', JSON.stringify(createRes.data))
      } else if (action.action === 'remove_stop') {
        const stop = findStop(cleanName)
        if (stop) await tripsApi.deleteStop(trip.id, stop.id)
        else throw new Error(`Could not find stop: ${cleanName}`)
      } else if (action.action === 'change_nights') {
        const stop = findStop(cleanName)
        if (stop && action.nights) await tripsApi.updateStop(trip.id, stop.id, { nights: action.nights })
        else throw new Error(`Could not find stop or nights missing: ${cleanName}`)
      } else if (action.action === 'suggest_campground') {
        const stop = findStop(cleanName)
        if (stop && action.campgroundName) {
          await tripsApi.updateStop(trip.id, stop.id, { campgroundName: action.campgroundName })
        } else throw new Error(`Could not find stop or campground name missing`)
      }

      // Refresh trip data and propagate upward
      const res = await tripsApi.get(trip.id)
      onTripUpdated(res.data)

      // Mark this message's confirmation card as applied
      setMessages(prev =>
        prev.map((m, i) => (i === msgIndex ? { ...m, modifyApplied: true } : m))
      )

      // Follow-up success message
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: '✅ Done! The change has been applied. Would you like to make any other modifications?',
        },
      ])
    } catch (err: any) {
      console.error('[applyMod] CAUGHT ERROR:', err?.message, err?.response?.status, err?.response?.data)
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: `Sorry, I couldn't apply that change: ${err?.message ?? 'unknown error'}. Want to try a different approach?`,
        },
      ])
    } finally {
      setApplying(false)
    }
  }

  function cancelModification(msgIndex: number) {
    setMessages(prev =>
      prev.map((m, i) => (i === msgIndex ? { ...m, modifyCancelled: true } : m))
    )
    setMessages(prev => [
      ...prev,
      { role: 'assistant', content: 'No problem! What would you like to do instead?' },
    ])
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

      {/* Slide-in panel */}
      <div
        className={`fixed top-0 right-0 h-full w-full sm:w-[22rem] bg-white border-l border-gray-200 flex flex-col z-40 shadow-2xl transition-transform duration-300 ease-in-out ${
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
            <div className="w-6 h-6 rounded-full bg-[#1E3A8A] flex items-center justify-center flex-shrink-0">
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
                className="flex-shrink-0 text-[11px] px-2.5 py-1 rounded-full border border-[#1E3A8A] text-[#1E3A8A] bg-white hover:bg-[#EFF6FF] transition-colors disabled:opacity-40 whitespace-nowrap"
              >
                {chip}
              </button>
            ))}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
          {!historyLoaded && (
            <div className="flex justify-center pt-8">
              <div className="w-4 h-4 border-2 border-[#1E3A8A] border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {historyLoaded && messages.map((msg, i) => (
            <div key={i}>
              {/* Bubble */}
              <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[88%] rounded-xl px-3 py-2.5 text-[13px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-[#1E3A8A] text-white'
                      : 'bg-gray-50 border border-gray-200 text-gray-800'
                  }`}
                  style={{ borderWidth: '0.5px' }}
                >
                  <p className="whitespace-pre-wrap">{cleanText(msg.content)}</p>
                </div>
              </div>

              {/* Confirmation card */}
              {msg.role === 'assistant' &&
                msg.modifyAction &&
                !msg.modifyApplied &&
                !msg.modifyCancelled && (
                  <div className="mt-2 mr-4 bg-white border border-[#1E3A8A]/25 rounded-xl p-3 shadow-sm">
                    <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Proposed change</p>
                    <p className="text-sm font-medium text-gray-900 mb-2.5">
                      {getConfirmationText(msg.modifyAction)}
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => applyModification(i, msg.modifyAction!)}
                        disabled={applying}
                        className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-[#F7A829] text-white hover:bg-[#C9851A] transition-colors disabled:opacity-50"
                      >
                        {applying ? 'Applying…' : '✓ Apply'}
                      </button>
                      <button
                        onClick={() => cancelModification(i)}
                        disabled={applying}
                        className="flex-1 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
                        style={{ borderWidth: '0.5px' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

              {/* Applied / cancelled status */}
              {msg.role === 'assistant' && msg.modifyAction && msg.modifyApplied && (
                <div className="mt-1 ml-0.5 text-[11px] text-[#0F766E] font-medium">
                  ✅ Applied to trip
                </div>
              )}
              {msg.role === 'assistant' && msg.modifyAction && msg.modifyCancelled && (
                <div className="mt-1 ml-0.5 text-[11px] text-gray-400">Cancelled</div>
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
          <div className="flex gap-2">
            <input
              ref={inputRef}
              className="input flex-1 text-sm"
              placeholder="Ask AI to modify your trip…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e =>
                e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())
              }
              disabled={typing || applying}
            />
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() || typing || applying}
              className="btn-primary px-3 flex items-center disabled:opacity-50"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
