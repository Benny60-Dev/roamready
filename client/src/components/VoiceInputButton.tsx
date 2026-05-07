import { Mic, MicOff } from 'lucide-react'

interface VoiceInputButtonProps {
  listening: boolean
  onClick: () => void
  disabled?: boolean
}

/**
 * Mic button that toggles voice dictation. Visual is a 36×36 (w-9 h-9) icon
 * tile matching the existing chat-input button shape used elsewhere in the
 * app. While `listening` is true, the button shows a red MicOff icon and a
 * pulsing red overlay so the recording state is unmistakable.
 */
export function VoiceInputButton({ listening, onClick, disabled = false }: VoiceInputButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={listening ? 'Stop voice input' : 'Start voice input'}
      title={listening ? 'Tap to stop recording' : 'Tap to dictate your message'}
      className={`relative flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-colors disabled:opacity-50 ${
        listening
          ? 'bg-red-50 text-red-600 hover:bg-red-100'
          : 'text-gray-500 hover:bg-gray-100'
      }`}
    >
      {listening && (
        <span
          className="absolute inset-0 rounded-lg bg-red-500 opacity-30 animate-pulse"
          aria-hidden="true"
        />
      )}
      <span className="relative z-10">
        {listening ? <MicOff size={16} /> : <Mic size={16} />}
      </span>
    </button>
  )
}
