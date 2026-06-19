import { useCallback, useEffect, useRef, useState } from 'react'

interface UseVoiceInputOptions {
  /** Called when interim or final transcript is available. Replaces the input value. */
  onTranscript: (text: string) => void
  /** Called once when listening starts, optionally to capture the input value at start. */
  onStart?: () => string  // return current input value to preserve as prefix
  /** Optional language code, defaults to en-US */
  lang?: string
}

interface UseVoiceInputReturn {
  /** Whether the browser supports the Web Speech API. */
  supported: boolean
  /** Whether recording is currently active. */
  listening: boolean
  /** Toggle recording on/off. */
  toggleListening: () => void
  /** Force stop (e.g. on unmount or send). */
  stopListening: () => void
}

/**
 * Apple-style press-to-start / press-to-stop dictation.
 *
 *   - `continuous: true` so the session does NOT auto-stop when the user
 *     pauses to think. The user always taps the mic again to stop.
 *   - `interimResults: true` so the input field shows live transcript while
 *     the user speaks instead of staying frozen until the engine commits.
 *   - Each onresult call replaces the input value with the prefix (the
 *     value typed BEFORE the user tapped the mic) plus the full
 *     accumulated transcript so far. Replacement, not append: every
 *     onresult delivers the entire current transcript, so concatenating
 *     onto the previous value would double-write.
 *   - Cleanup on unmount terminates the active recognition session.
 */
export function useVoiceInput({ onTranscript, onStart, lang = 'en-US' }: UseVoiceInputOptions): UseVoiceInputReturn {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const prefixRef = useRef<string>('')
  // MIC-CLEAR-1: stop() fires one final onresult ASYNC after it returns. Without
  // this guard that trailing result calls onTranscript AFTER the consumer's send
  // handler already cleared the input — re-filling the box. We flip stoppedRef
  // true before stop() and drop any onresult that arrives while it's set.
  const stoppedRef = useRef(false)

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    setSupported(!!SR)
  }, [])

  const stopListening = useCallback(() => {
    stoppedRef.current = true
    if (recognitionRef.current) {
      // Detach the handler on the LIVE rec object too — nulling recognitionRef
      // alone doesn't unbind the closure's onresult, which can still fire post-stop.
      recognitionRef.current.onresult = null
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
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return

    // Capture the current input value as a prefix so dictation appends rather than replaces.
    prefixRef.current = onStart?.() ?? ''
    // New session — clear the post-stop guard so results flow again.
    stoppedRef.current = false

    const rec = new SR()
    // Press-to-start / press-to-stop: don't auto-stop on pause, show interim results.
    rec.continuous = true
    rec.interimResults = true
    rec.lang = lang

    rec.onstart = () => setListening(true)

    rec.onresult = (e: SpeechRecognitionEvent) => {
      // Drop any trailing result that arrives after stopListening() — otherwise
      // it would re-fill an input the consumer just cleared on send (MIC-CLEAR-1).
      if (stoppedRef.current) return
      // Concatenate ALL results (final + interim) into one string for live transcript display.
      let combined = ''
      for (let i = 0; i < e.results.length; i++) {
        combined += e.results[i][0].transcript
      }
      const prefix = prefixRef.current
      const next = prefix ? `${prefix} ${combined}`.trim() : combined.trim()
      onTranscript(next)
    }

    rec.onerror = () => {
      setListening(false)
      recognitionRef.current = null
    }

    // onend fires when the user taps stop OR the browser ends the session.
    // We only update listening state — don't try to auto-restart.
    rec.onend = () => {
      setListening(false)
      recognitionRef.current = null
    }

    recognitionRef.current = rec
    rec.start()
  }, [listening, stopListening, onTranscript, onStart, lang])

  // Cleanup on unmount
  useEffect(() => () => stopListening(), [stopListening])

  return { supported, listening, toggleListening, stopListening }
}
