import { useState } from 'react'
import { X, Star } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { feedbackApi } from '../../services/api'
import { FeedbackType } from '../../types'

interface Props {
  onClose: () => void
}

interface FormData {
  type: FeedbackType
  title: string
  body: string
  importance: string
}

export default function FeedbackModal({ onClose }: Props) {
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { register, handleSubmit } = useForm<FormData>({
    defaultValues: { type: 'FEATURE_REQUEST' }
  })

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
