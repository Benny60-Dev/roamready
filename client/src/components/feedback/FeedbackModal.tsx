import { useRef, useState } from 'react'
import { X, Star, ImagePlus } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { feedbackApi } from '../../services/api'
import { FeedbackType } from '../../types'
import { useUIStore } from '../../store/uiStore'

interface Props {
  onClose: () => void
}

interface FormData {
  type: FeedbackType
  title: string
  body: string
  importance: string
}

interface Attachment {
  filename: string
  data: string // base64, no data: prefix
}

const MAX_ATTACHMENTS = 3
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
const MAX_EDGE_PX = 1920

// Downscale to ≤1920px on the long edge and re-encode as JPEG q0.8 — keeps
// payloads small enough for the JSON submission path. Returns base64 without
// the data: prefix (the server schema validates raw base64 + magic bytes).
async function toJpegAttachment(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const data = canvas.toDataURL('image/jpeg', 0.8).split(',')[1]
  return { filename: file.name.replace(/\.[^.]+$/, '') + '.jpg', data }
}

export default function FeedbackModal({ onClose }: Props) {
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Preselect the category when a caller passed one (e.g. the pin-drop "Report
  // this bug" link → 'BUG_REPORT'). The modal mounts fresh on each open (App.tsx
  // gates it on feedbackModalOpen), so reading the prefill here sets the right
  // default per-open; a plain no-arg open leaves prefill undefined → the
  // FEATURE_REQUEST fallback below.
  const prefillType = useUIStore(s => s.feedbackPrefillType)
  const { register, handleSubmit } = useForm<FormData>({
    defaultValues: { type: prefillType ?? 'FEATURE_REQUEST' }
  })

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // allow re-picking the same file after a remove
    if (!files.length) return
    setAttachError(null)

    if (attachments.length + files.length > MAX_ATTACHMENTS) {
      setAttachError(`You can attach up to ${MAX_ATTACHMENTS} screenshots.`)
      return
    }

    const added: Attachment[] = []
    for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        setAttachError(`${file.name} isn't a supported image (PNG, JPEG, or WebP).`)
        continue
      }
      try {
        const att = await toJpegAttachment(file)
        // base64 → bytes: 3/4 ratio, ignore padding (close enough for a cap check)
        if (att.data.length * 0.75 > MAX_ATTACHMENT_BYTES) {
          setAttachError(`${file.name} is still over 4MB after downscaling — try cropping it.`)
          continue
        }
        added.push(att)
      } catch {
        setAttachError(`Couldn't read ${file.name} — is it a valid image?`)
      }
    }
    if (added.length) setAttachments(prev => [...prev, ...added])
  }

  function removeAttachment(index: number) {
    setAttachments(prev => prev.filter((_, i) => i !== index))
    setAttachError(null)
  }

  async function onSubmit(data: FormData) {
    setError(null)
    setSubmitting(true)
    try {
      // Empty optional fields are omitted (not sent as '' / 0) — the server's
      // .strict() Zod schema expects absent, not empty.
      await feedbackApi.submit({
        type: data.type,
        title: data.title.trim() || undefined,
        body: data.body,
        importance: data.importance || undefined,
        rating: rating || undefined,
        screen: window.location.pathname,
        attachments: attachments.length ? attachments : undefined,
      })
      setSubmitted(true)
    } catch (err: any) {
      const status = err?.response?.status
      if (status === 403 && err?.response?.data?.error === 'EMAIL_VERIFICATION_REQUIRED') {
        setError('Please verify your email to send feedback.')
      } else if (status === 401) {
        setError('Please log in to send feedback.')
      } else {
        setError('Could not send feedback — please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30">
      <div className="bg-white rounded-xl border border-gray-200 w-full max-w-md p-6" style={{ borderWidth: '0.5px' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-medium text-gray-900">Share Feedback</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100"><X size={18} /></button>
        </div>

        {submitted ? (
          <div className="text-center py-8">
            <div className="w-12 h-12 bg-[#CCFBF1] rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-2xl">🎉</span>
            </div>
            <p className="font-medium text-gray-900 mb-1">Thanks for your feedback!</p>
            <p className="text-sm text-gray-500">It helps us make RoamReady better for everyone.</p>
            <p className="text-xs text-gray-400 mt-2">We read every submission. Items appear on the public roadmap once they're planned.</p>
            <button onClick={onClose} className="btn-primary mt-4">Close</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label className="label">Type</label>
              <select className="input" {...register('type')}>
                <option value="FEATURE_REQUEST">Feature Request</option>
                <option value="BUG_REPORT">Bug Report</option>
                <option value="GENERAL">General Feedback</option>
              </select>
            </div>

            <div>
              <label className="label">Overall Rating</label>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map(n => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setRating(n)}
                    onMouseEnter={() => setHoverRating(n)}
                    onMouseLeave={() => setHoverRating(0)}
                  >
                    <Star
                      size={20}
                      className={`transition-colors ${n <= (hoverRating || rating) ? 'text-amber-400 fill-amber-400' : 'text-gray-300'}`}
                    />
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="label">Title</label>
              <input className="input" placeholder="Short summary" {...register('title')} />
            </div>

            <div>
              <label className="label">Description <span className="text-red-500">*</span></label>
              <textarea
                className="input min-h-[80px] resize-none"
                placeholder="Tell us more..."
                {...register('body', { required: true })}
              />
            </div>

            <div>
              <label className="label">Importance</label>
              <select className="input" {...register('importance')}>
                <option value="">Select...</option>
                <option value="nice_to_have">Nice to have</option>
                <option value="important">Important</option>
                <option value="critical">Critical / Blocking</option>
              </select>
            </div>

            <div>
              <label className="label">Attach screenshots <span className="text-gray-400 font-normal">(optional, up to {MAX_ATTACHMENTS})</span></label>
              <div className="flex items-center gap-2 flex-wrap">
                {attachments.map((a, i) => (
                  <div key={i} className="relative">
                    <img
                      src={`data:image/jpeg;base64,${a.data}`}
                      alt={a.filename}
                      className="w-14 h-14 object-cover rounded-lg border border-gray-200"
                      style={{ borderWidth: '0.5px' }}
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      aria-label={`Remove ${a.filename}`}
                      className="absolute -top-1.5 -right-1.5 bg-white border border-gray-200 rounded-full p-0.5 hover:bg-gray-100"
                      style={{ borderWidth: '0.5px' }}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
                {attachments.length < MAX_ATTACHMENTS && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Attach screenshots"
                    className="w-14 h-14 rounded-lg border border-dashed border-gray-300 flex items-center justify-center text-gray-400 hover:border-[#1F6F8B] hover:text-[#1F6F8B] transition-colors"
                  >
                    <ImagePlus size={18} />
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                className="hidden"
                onChange={handleFiles}
              />
              {attachError && <p className="text-xs text-red-600 mt-1">{attachError}</p>}
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2" style={{ borderWidth: '0.5px' }}>
                {error}
              </p>
            )}

            <div className="flex gap-2 pt-2">
              <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
              <button type="submit" disabled={submitting} className="btn-primary flex-1 disabled:opacity-60">
                {submitting ? 'Sending...' : 'Submit'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
