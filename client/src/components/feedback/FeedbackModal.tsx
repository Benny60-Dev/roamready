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
  isPublic: boolean
}

export default function FeedbackModal({ onClose }: Props) {
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [submitted, setSubmitted] = useState(false)
  const { register, handleSubmit } = useForm<FormData>({
    defaultValues: { type: 'FEATURE_REQUEST', isPublic: true }
  })

  async function onSubmit(data: FormData) {
    await feedbackApi.submit({ ...data, rating, screen: window.location.pathname })
    setSubmitted(true)
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
            <div className="w-12 h-12 bg-[#E1F5EE] rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-2xl">🎉</span>
            </div>
            <p className="font-medium text-gray-900 mb-1">Thanks for your feedback!</p>
            <p className="text-sm text-gray-500">It helps us make RoamReady better for everyone.</p>
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
                <option value="CAMPGROUND_REVIEW">Campground Review</option>
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

            <div className="flex items-center gap-2">
              <input type="checkbox" id="isPublic" {...register('isPublic')} className="rounded" />
              <label htmlFor="isPublic" className="text-sm text-gray-600">Add to public roadmap</label>
            </div>

            <div className="flex gap-2 pt-2">
              <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
              <button type="submit" className="btn-primary flex-1">Submit</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
