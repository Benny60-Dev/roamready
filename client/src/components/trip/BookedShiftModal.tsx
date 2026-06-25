import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { format } from 'date-fns'
import { parseTripDate } from '../../utils/dates'

/**
 * ADDSTOP-RESLOT — center-screen interrupt for booked-stop date shifts.
 *
 * Fires IN ADDITION to the inline ModifyTripPanel banner: the banner is the
 * persistent record in the chat history, this modal is the unmissable "look at
 * this now" interrupt. Same data shape (shiftedBookedStops), same amber tokens.
 *
 * Must be explicitly dismissed — there is no auto-close timer, and a backdrop
 * click is a no-op so an accidental click outside can't dismiss the warning.
 * The "Got it" button (focused on open) or Escape closes it. The reservation
 * itself is unchanged — only the trip date moved.
 */

export interface BookedShiftStop {
  stopId: string
  name: string
  originalBookedDate: string
  newArrivalDate: string
}

interface Props {
  isOpen: boolean
  newStop: string
  stops: BookedShiftStop[]
  onDismiss: () => void
}

export default function BookedShiftModal({ isOpen, newStop, stops, onDismiss }: Props) {
  const gotItRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return
    gotItRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onDismiss])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      // Backdrop is a no-op — this warning must be explicitly dismissed.
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="booked-shift-title"
        className="bg-white rounded-lg border border-amber-200 w-full max-w-md p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-3">
          <div className="w-9 h-9 rounded-md bg-amber-50 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={18} className="text-amber-600" />
          </div>
          <h2 id="booked-shift-title" className="font-semibold text-lg text-gray-900 leading-snug">
            Heads up — this change affects a booked stop
          </h2>
        </div>

        <div className="space-y-2 mb-6">
          {stops.map(s => {
            const orig = parseTripDate(s.originalBookedDate)
            const next = parseTripDate(s.newArrivalDate)
            const origStr = orig ? format(orig, 'MMM d, yyyy') : s.originalBookedDate
            const nextStr = next ? format(next, 'MMM d, yyyy') : s.newArrivalDate
            return (
              <div
                key={s.stopId}
                className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
                style={{ borderWidth: '0.5px' }}
              >
                <p className="text-sm text-amber-900 leading-relaxed">
                  <span className="font-semibold">{s.name}</span> was booked for{' '}
                  <span className="font-semibold">{origStr}</span>. Adding {newStop} shifted its
                  trip date to <span className="font-semibold">{nextStr}</span>. Your reservation is
                  unchanged — but call the campground to confirm the new dates still work.
                </p>
              </div>
            )
          })}
        </div>

        <div className="flex justify-end">
          <button
            ref={gotItRef}
            type="button"
            onClick={onDismiss}
            className="bg-amber-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-amber-700 transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
