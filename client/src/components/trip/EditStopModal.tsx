import { useState } from 'react'
import { Stop } from '../../types'

// Lifted out of TripSummaryPage so the Map page (and any future surface) can
// reuse the same edit affordance. Behavior preserved verbatim from the
// original inline component — same fields, HOME-aware field hiding, same
// Save/Cancel layout. Extended with optional Delete plumbing.

export interface EditStopModalProps {
  stop: Stop
  onSave: (data: Partial<Stop>) => void
  onClose: () => void
  saving: boolean

  // Optional Delete affordance. When `onDelete` is provided AND `canDelete`
  // is not explicitly false, render a Delete button to the LEFT of the
  // Save/Cancel pair, styled in danger red. The parent is responsible for
  // showing a ConfirmModal — `onDelete` should kick off that flow.
  onDelete?: () => void
  canDelete?: boolean
  isDeleting?: boolean
}

export default function EditStopModal({
  stop,
  onSave,
  onClose,
  saving,
  onDelete,
  canDelete,
  isDeleting,
}: EditStopModalProps) {
  const [locationName, setLocationName] = useState(stop.locationName)
  const [campgroundName, setCampgroundName] = useState(stop.campgroundName ?? '')
  const [nights, setNights] = useState(stop.nights)
  const [type, setType] = useState<string>(stop.type)
  const [hookupType, setHookupType] = useState(stop.hookupType ?? '')
  const [notes, setNotes] = useState(stop.notes ?? '')

  const isHome = stop.type === 'HOME'
  const showDelete = !!onDelete && canDelete !== false
  const formBusy = saving || !!isDeleting

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({
      locationName: locationName.trim(),
      campgroundName: campgroundName.trim() || undefined,
      nights: Number(nights),
      type: type as Stop['type'],
      hookupType: hookupType || undefined,
      notes: notes.trim() || undefined,
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={e => { if (e.target === e.currentTarget && !formBusy) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Edit Stop</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="label">Location name</label>
            <input
              className="input"
              value={locationName}
              onChange={e => setLocationName(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">Campground name</label>
            <input
              className="input"
              value={campgroundName}
              onChange={e => setCampgroundName(e.target.value)}
              placeholder="Optional"
            />
          </div>
          {!isHome && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Stop type</label>
                  <select className="input" value={type} onChange={e => setType(e.target.value)}>
                    <option value="DESTINATION">Destination</option>
                    <option value="OVERNIGHT_ONLY">Overnight only</option>
                  </select>
                </div>
                <div>
                  <label className="label">Nights</label>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    className="input"
                    value={nights}
                    onChange={e => setNights(Number(e.target.value))}
                  />
                </div>
              </div>
              <div>
                <label className="label">Hookup preference</label>
                <select className="input" value={hookupType} onChange={e => setHookupType(e.target.value)}>
                  <option value="">Any / not specified</option>
                  <option value="Full hookup">Full hookup</option>
                  <option value="Water & Electric">Water &amp; Electric</option>
                  <option value="Electric only">Electric only</option>
                  <option value="Dry camping">Dry camping</option>
                </select>
              </div>
            </>
          )}
          <div>
            <label className="label">Notes</label>
            <textarea
              className="input resize-none"
              rows={3}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Gate codes, instructions, reminders…"
            />
          </div>
          <div className="flex gap-2 pt-1">
            {showDelete && (
              <button
                type="button"
                onClick={onDelete}
                disabled={formBusy}
                className="bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            )}
            <button
              type="submit"
              disabled={formBusy || !locationName.trim()}
              className="btn-primary flex-1 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" onClick={onClose} disabled={formBusy} className="btn-outline flex-1">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
