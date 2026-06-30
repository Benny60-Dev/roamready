import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

// Shared admin copy-to-clipboard controls (Session Inspector + Diagnostics).
// Both use navigator.clipboard.writeText and no-op silently if the clipboard
// API is unavailable (insecure context / denied).

// Copy a single value (id / email / name). The icon flips to a check for ~1s to
// confirm. Renders nothing for an empty value.
export function CopyIcon({ value, title }: { value: string; title?: string }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <button
      type="button"
      title={title ?? 'Copy'}
      aria-label={title ?? 'Copy'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1000)
        } catch { /* clipboard unavailable (insecure context / denied) — no-op */ }
      }}
      className="inline-flex items-center justify-center text-gray-400 hover:text-[#1F6F8B] transition-colors flex-shrink-0"
    >
      {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
    </button>
  )
}

// "Copy for support" — copies a multi-line labeled block, briefly showing a
// "Copied" state. Styled as a small btn-outline to match the app.
export function CopyForSupport({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* clipboard unavailable — no-op */ }
      }}
      className="btn-outline text-xs flex items-center gap-1.5 flex-shrink-0"
    >
      {copied
        ? <><Check size={13} className="text-emerald-600" /> Copied</>
        : <><Copy size={13} /> Copy for support</>}
    </button>
  )
}
