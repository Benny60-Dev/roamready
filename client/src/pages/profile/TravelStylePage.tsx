import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Save, X } from 'lucide-react'
import { usersApi } from '../../services/api'

const INTERESTS = ['Hiking', 'Water sports', 'Wildlife viewing', 'Photography', 'Star gazing', 'Fishing', 'Mountain biking', 'Rock climbing', 'OHV riding', 'History & culture', 'Wine & food', 'Hot springs']
const CAMPGROUND_TYPES = ['National Parks', 'State Parks', 'National Forest', 'BLM Land', 'Private / KOA', 'Resort / Full amenity', 'Harvest Hosts', 'Boondocking']

export default function TravelStylePage() {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // Interests-section local state — collapse drawer + "Add your own" inline input.
  // Scoped to this component since the data plumbing (interests as String[]) already
  // supports custom values; only the UI affordance is new. showAllInterests defaults
  // false so the resting state hides unselected presets behind the "More interests (N)"
  // toggle; a brand-new user (interests.length === 0) bypasses the toggle and sees the
  // full preset list expanded for discovery (see the JSX below).
  const [showAllInterests, setShowAllInterests] = useState(false)
  const [addingCustom, setAddingCustom] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const { register, handleSubmit, setValue, watch, reset } = useForm()
  const interests = watch('interests') || []
  const campgroundTypes = watch('campgroundTypes') || []

  // Interests bucketing — all derived from the single `interests` form-state array
  // plus the static INTERESTS preset list. No separate selection state needed.
  //   selectedPresets    — presets the user has picked, rendered as first-class blue chips
  //   customInterests    — user-typed strings NOT in INTERESTS, rendered identically to
  //                        selected presets so they feel first-class
  //   unselectedPresets  — presets not yet picked, collapsed behind the "More" drawer
  //                        once any selection exists
  // Removing a chip (preset or custom) is always `toggleArray('interests', item, ...)` —
  // for a preset it falls back into unselectedPresets; for a custom it leaves the array
  // entirely (since it was never in INTERESTS). The asymmetry falls out of the bucketing
  // for free with no flag tracking needed.
  const selectedPresets = INTERESTS.filter(p => interests.includes(p))
  const customInterests = (interests as string[]).filter(i => !INTERESTS.includes(i))
  const unselectedPresets = INTERESTS.filter(p => !interests.includes(p))

  useEffect(() => {
    usersApi.getTravelProfile().then(res => {
      if (res.data) reset(res.data)
    })
  }, [])

  function toggleArray(field: string, value: string, current: string[]) {
    const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value]
    setValue(field as any, next)
  }

  // Append a user-typed interest to the form's `interests` array.
  // Three branches (in priority order) — every one a silent no-op on dup so the
  // user can spam Enter for rapid entry without seeing error chrome:
  //   1. Empty / whitespace-only            → ignore.
  //   2. Already in the user's array        → clear input, no-op.
  //   3. Matches a preset case-insensitively → select the CANONICAL preset name
  //      rather than create a near-duplicate "hiking" alongside the existing "Hiking".
  //   4. Otherwise                          → push as typed (preserving user casing).
  // Input is kept open after a successful add so the user can type another
  // immediately; closing is via the inline × or Escape.
  function addCustomInterest() {
    const trimmed = customInput.trim()
    if (!trimmed) return
    const needle = trimmed.toLowerCase()
    if ((interests as string[]).some(i => i.toLowerCase() === needle)) {
      setCustomInput('')
      return
    }
    const matchingPreset = INTERESTS.find(p => p.toLowerCase() === needle)
    if (matchingPreset) {
      setValue('interests', [...interests, matchingPreset])
      setCustomInput('')
      return
    }
    setValue('interests', [...interests, trimmed])
    setCustomInput('')
  }

  async function onSubmit(data: any) {
    setSaving(true)
    try {
      await usersApi.updateTravelProfile(data)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-medium text-gray-900">Travel Style</h1>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div className="card-lg space-y-4">
          <h2 className="font-medium text-gray-900">Trip Preferences</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Adults</label>
              <input type="number" min="1" className="input" {...register('adults', { valueAsNumber: true })} />
            </div>
            <div>
              <label className="label">Children</label>
              <input type="number" min="0" className="input" {...register('children', { valueAsNumber: true })} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="hasPets" {...register('hasPets')} className="rounded" />
            <label htmlFor="hasPets" className="text-sm text-gray-700">Traveling with pets</label>
          </div>
          <div>
            <label className="label">Max drive hours per day</label>
            <select className="input" {...register('maxDriveHours', { valueAsNumber: true })}>
              {[3, 4, 5, 6, 7, 8].map(h => <option key={h} value={h}>{h} hours</option>)}
            </select>
          </div>
          <div>
            <label className="label">Max miles per day</label>
            <input type="number" className="input" placeholder="300" {...register('maxMilesPerDay', { valueAsNumber: true })} />
          </div>
          <div>
            <label className="label">Nightly campsite budget ($)</label>
            <input type="number" className="input" placeholder="50" {...register('nightlyBudget', { valueAsNumber: true })} />
          </div>
          <div>
            <label className="label">Hookup preference</label>
            <select className="input" {...register('hookupPreference')}>
              <option value="FULL_HOOKUP">Full hookup preferred</option>
              <option value="ELECTRIC">Electric only OK</option>
              <option value="BOTH">Mix of hookup & dry camping</option>
              <option value="DRY_CAMPING">Dry camping / boondocking</option>
            </select>
          </div>
        </div>

        <div className="card-lg space-y-4">
          <h2 className="font-medium text-gray-900">Campground Types</h2>
          <div className="flex flex-wrap gap-2">
            {CAMPGROUND_TYPES.map(type => (
              <button
                key={type}
                type="button"
                onClick={() => toggleArray('campgroundTypes', type, campgroundTypes)}
                className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                  campgroundTypes.includes(type) ? 'bg-[#1F6F8B] text-white border-[#1F6F8B]' : 'border-gray-200 text-gray-600 hover:border-[#1F6F8B]'
                }`}
                style={{ borderWidth: '0.5px' }}
              >
                {type}
              </button>
            ))}
          </div>
        </div>

        <div className="card-lg space-y-4">
          <h2 className="font-medium text-gray-900">Interests</h2>
          <div className="flex flex-wrap gap-2 items-center">
            {/* Active chips: selected presets first (in canonical preset order), then
                customs in the order the user added them. Both are visually identical —
                customs are first-class — and both remove on click. */}
            {[...selectedPresets, ...customInterests].map(item => (
              <button
                key={item}
                type="button"
                onClick={() => toggleArray('interests', item, interests)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border bg-[#1F6F8B] text-white border-[#1F6F8B] hover:bg-[#185975] hover:border-[#185975] transition-colors"
                style={{ borderWidth: '0.5px' }}
                title="Remove"
              >
                {item}
                <X size={12} className="opacity-80" />
              </button>
            ))}

            {/* New-user state (zero selections): show ALL 12 presets expanded for
                discovery. The "More interests" collapse only applies once the user
                has picked something — don't hide options from a blank slate. */}
            {interests.length === 0 && INTERESTS.map(preset => (
              <button
                key={preset}
                type="button"
                onClick={() => toggleArray('interests', preset, interests)}
                className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 text-gray-600 hover:border-[#1F6F8B] transition-colors"
                style={{ borderWidth: '0.5px' }}
              >
                {preset}
              </button>
            ))}

            {/* Resting state (≥1 selection, and unselected presets remain): collapse
                the unselected presets behind a "More interests (N)" toggle. When
                expanded the unselected presets render as normal toggleable chips and
                the toggle flips to "Show fewer". When N === 0 (user picked everything)
                the toggle is suppressed entirely. */}
            {interests.length > 0 && unselectedPresets.length > 0 && (showAllInterests ? (
              <>
                {unselectedPresets.map(preset => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => toggleArray('interests', preset, interests)}
                    className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 text-gray-600 hover:border-[#1F6F8B] transition-colors"
                    style={{ borderWidth: '0.5px' }}
                  >
                    {preset}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setShowAllInterests(false)}
                  className="px-3 py-1.5 text-sm text-gray-500 hover:text-[#1F6F8B] transition-colors"
                >
                  Show fewer
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setShowAllInterests(true)}
                className="px-3 py-1.5 text-sm text-gray-500 hover:text-[#1F6F8B] transition-colors"
              >
                More interests ({unselectedPresets.length})
              </button>
            ))}

            {/* "Add your own" — dashed chip that swaps in-place to an inline input.
                Enter submits, Escape closes, input stays open after a successful add
                so rapid entry is one keystroke per chip. */}
            {addingCustom ? (
              <div className="inline-flex items-center gap-1.5">
                <input
                  type="text"
                  maxLength={40}
                  value={customInput}
                  onChange={e => setCustomInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addCustomInterest()
                    } else if (e.key === 'Escape') {
                      setAddingCustom(false)
                      setCustomInput('')
                    }
                  }}
                  placeholder="e.g. Birdwatching"
                  autoFocus
                  className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 focus:outline-none focus:border-[#1F6F8B]"
                />
                <button
                  type="button"
                  onClick={addCustomInterest}
                  disabled={!customInput.trim()}
                  className="px-3 py-1.5 rounded-lg text-sm bg-[#1F6F8B] text-white hover:bg-[#185975] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => { setAddingCustom(false); setCustomInput('') }}
                  className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
                  title="Done"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingCustom(true)}
                className="px-3 py-1.5 rounded-lg text-sm border border-dashed border-gray-300 text-gray-500 hover:border-[#1F6F8B] hover:text-[#1F6F8B] transition-colors"
              >
                + Add your own
              </button>
            )}
          </div>
        </div>

        <div className="card-lg space-y-4">
          <h2 className="font-medium text-gray-900">Military / First Responder</h2>
          <div>
            <label className="label">Military status</label>
            <select className="input" {...register('militaryStatus')}>
              <option value="">None</option>
              <option value="ACTIVE">Active duty</option>
              <option value="VETERAN">Veteran</option>
              <option value="DEPENDENT">Military dependent</option>
              <option value="RETIRED">Retired military</option>
            </select>
          </div>
          <div>
            <label className="label">First responder</label>
            <select className="input" {...register('firstResponder')}>
              <option value="">None</option>
              <option value="POLICE">Police / Law enforcement</option>
              <option value="FIRE">Fire fighter</option>
              <option value="EMT">EMT / Paramedic</option>
              <option value="HEALTHCARE">Healthcare worker</option>
            </select>
          </div>
        </div>

        <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2">
          <Save size={15} /> {saving ? 'Saving...' : saved ? 'Saved!' : 'Save preferences'}
        </button>
      </form>
    </div>
  )
}
