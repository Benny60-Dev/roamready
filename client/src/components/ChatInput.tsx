import { forwardRef, KeyboardEvent, useState } from 'react'
import { Loader, Send } from 'lucide-react'
import { VoiceInputButton } from './VoiceInputButton'

/**
 * Shared chat input — textarea (NOT input) so long messages wrap to new lines
 * instead of overflowing horizontally. Three sites in the app render this:
 *
 *   1. SessionPage empty-state hero      → variant='hero' (gold Send, pill wrapper)
 *   2. SessionPage active conversation   → variant='compact' (btn-primary Send)
 *   3. ModifyTripPanel                   → variant='compact'
 *
 * The two variants share textarea behavior and keyboard handling; only the
 * visual chrome (wrapper, Send button color/shape) differs.
 *
 * Auto-grow uses CSS `field-sizing: content` (modern Chrome 123+, Safari 18+,
 * Firefox 137+). On older browsers it gracefully degrades to a fixed-row
 * textarea — text still wraps, just no auto-grow. maxHeight caps growth at
 * ~6 lines so a long message can't push the page off-screen; overflow-y-auto
 * gives an internal scrollbar past that.
 *
 * Enter submits, Shift+Enter inserts a newline. Mic button (VoiceInputButton)
 * is rendered only when onToggleListening is provided. maxLength=4000 prevents
 * accidental megabyte pastes from locking the UI; well above any real prompt.
 */
interface ChatInputProps {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  placeholder: string
  /** Combined "can't type / submit" flag — covers typing, applying, etc. */
  disabled?: boolean
  /** AI is generating a response — Send button shows a spinner. */
  loading?: boolean
  /** Voice-input wiring. Mic button only renders when onToggleListening is set. */
  speechSupported?: boolean
  listening?: boolean
  onToggleListening?: () => void
  /** 'hero' = pill wrapper + gold square Send (empty-state CTA);
   *  'compact' = bare flex row + btn-primary Send (in-conversation). */
  variant?: 'hero' | 'compact'
  /** Drives the gentle brand blue↔gold pulse (.chat-input-awaiting) so the user
   *  notices it's their turn / where to start. Self-suppresses once the field is
   *  focused or has text. Honored by BOTH variants: compact = "it's your turn to
   *  reply"; hero = "start here" on a fresh new-session screen. Compact pulses
   *  the textarea (.chat-input-awaiting); hero pulses the rounded wrapper with a
   *  box-shadow-only glow (.hero-input-awaiting) — see the hero return for the
   *  iOS-Safari reason. */
  isAwaiting?: boolean
}

export const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(function ChatInput(
  {
    value,
    onChange,
    onSubmit,
    placeholder,
    disabled = false,
    loading = false,
    speechSupported = false,
    listening = false,
    onToggleListening,
    variant = 'compact',
    isAwaiting = false,
  },
  ref,
) {
  // Pulse only while it's the user's turn AND they haven't engaged yet — stops
  // the moment they focus the field or type anything (and when isAwaiting clears
  // on send). Compact: pulse on the textarea; hero: box-shadow glow on the
  // rounded wrapper (iOS-safe).
  const [focused, setFocused] = useState(false)
  const showAwaitingPulse = isAwaiting && !focused && !value.trim()
  // MIC-SEND-1: submit while the mic is still listening. Recognition runs
  // continuous:true, so we must STOP it on submit — otherwise stray dictation
  // would repopulate the next turn's input and the recording UI would stay on.
  // onToggleListening (= toggleListening) calls stopListening() when active;
  // optional-chained because it's absent when the mic isn't wired (showMic false).
  const handleSubmit = () => {
    if (listening) onToggleListening?.()
    onSubmit()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!disabled && value.trim()) handleSubmit()
    }
  }

  const sendDisabled = !value.trim() || disabled
  const showMic = speechSupported && !!onToggleListening

  // Use `items-end` (NOT items-center) so when the textarea grows multi-line,
  // Mic + Send stick to the BOTTOM of the row rather than vertically centering
  // against a tall textarea — which looks awkward at 3+ lines.
  if (variant === 'hero') {
    // The "start here" pulse is a BOX-SHADOW-ONLY glow on this rounded WRAPPER
    // so it hugs the whole rounded box (border-radius below) instead of drawing
    // a sharp rectangle on the inner textarea. Animating only box-shadow (never
    // border-color or geometry) on this flex parent avoids the WebKit "child
    // stops painting during a parent animation" quirk that previously hid the
    // mic on iOS Safari; the mic button also carries `isolation: isolate`.
    return (
      <div
        className={`flex items-end gap-2 bg-white${showAwaitingPulse ? ' hero-input-awaiting' : ''}`}
        style={{ border: '0.5px solid #E8E4DA', borderRadius: 8, padding: '6px 6px 6px 16px' }}
      >
        <textarea
          ref={ref}
          rows={1}
          aria-label="Message RoamReady AI"
          className="chat-textarea-hero caret-[#1F6F8B] flex-1 bg-transparent outline-none text-sm py-2 resize-none overflow-y-auto"
          // fieldSizing isn't yet in TS lib types, so cast through CSSProperties.
          // The runtime CSS property is `field-sizing: content`; React/JSX accepts
          // it as the camelCased key via inline style. Falls back silently on
          // older browsers — text still wraps, just no auto-grow.
          // minHeight floors the box at TWO lines so the multi-line placeholder
          // ("Tell me about your trip — …") shows fully on mobile. fieldSizing:
          // content sizes to the (empty) VALUE, not the placeholder, so an empty
          // box would otherwise collapse to one line and clip the wrapped
          // placeholder — worse now that the iOS guard forces 16px. 3.5rem =
          // 2×20px line-height (text-sm) + 8+8px padding, border-box. fieldSizing
          // + maxHeight still let it grow for real multi-line input.
          style={{ fieldSizing: 'content', minHeight: '3.5rem', maxHeight: '8rem', paddingTop: 8, paddingBottom: 8 } as React.CSSProperties}
          placeholder={placeholder}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={disabled}
          maxLength={4000}
        />
        {showMic && (
          <VoiceInputButton
            listening={listening}
            onClick={onToggleListening!}
            disabled={disabled}
          />
        )}
        <button
          type="button"
          onClick={() => handleSubmit()}
          disabled={sendDisabled}
          aria-label="Send message"
          className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: '#F7A829' }}
          onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#C9851A' }}
          onMouseLeave={e => { if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#F7A829' }}
        >
          {loading ? <Loader size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
    )
  }

  // 'compact' variant — used inside SessionPage active-conversation and
  // ModifyTripPanel. .input class provides the same border/padding the legacy
  // <input className="input"> rendered, so the field is visually identical
  // until the user types past one line and the textarea grows.
  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={ref}
        rows={1}
        aria-label="Message RoamReady AI"
        className={`input caret-[#1F6F8B] flex-1 min-w-0 text-sm resize-none overflow-y-auto${showAwaitingPulse ? ' chat-input-awaiting' : ''}`}
        style={{ fieldSizing: 'content', maxHeight: '8rem' } as React.CSSProperties}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        maxLength={4000}
      />
      {showMic && (
        <VoiceInputButton
          listening={listening}
          onClick={onToggleListening!}
          disabled={disabled}
        />
      )}
      <button
        type="button"
        onClick={() => handleSubmit()}
        disabled={sendDisabled}
        aria-label="Send message"
        className="btn-primary px-3 flex items-center gap-1 disabled:opacity-50"
      >
        {loading ? <Loader size={16} className="animate-spin" /> : <Send size={16} />}
      </button>
    </div>
  )
})
