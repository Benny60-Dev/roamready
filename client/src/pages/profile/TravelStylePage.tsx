import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Save } from 'lucide-react'
import { usersApi } from '../../services/api'

const INTERESTS = ['Hiking', 'Water sports', 'Wildlife viewing', 'Photography', 'Star gazing', 'Fishing', 'Mountain biking', 'Rock climbing', 'OHV riding', 'History & culture', 'Wine & food', 'Hot springs']
const CAMPGROUND_TYPES = ['National Parks', 'State Parks', 'National Forest', 'BLM Land', 'Private / KOA', 'Resort / Full amenity', 'Harvest Hosts', 'Boondocking']

export default function TravelStylePage() {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const { register, handleSubmit, setValue, watch, reset } = useForm()
  const interests = watch('interests') || []
  const campgroundTypes = watch('campgroundTypes') || []

  useEffect(() => {
    usersApi.getTravelProfile().then(res => {
      if (res.data) reset(res.data)
    })
  }, [])

  function toggleArray(field: string, value: string, current: string[]) {
    const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value]
    setValue(field as any, next)
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
          <div className="flex flex-wrap gap-2">
            {INTERESTS.map(interest => (
              <button
                key={interest}
                type="button"
                onClick={() => toggleArray('interests', interest, interests)}
                className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                  interests.includes(interest) ? 'bg-[#1F6F8B] text-white border-[#1F6F8B]' : 'border-gray-200 text-gray-600 hover:border-[#1F6F8B]'
                }`}
                style={{ borderWidth: '0.5px' }}
              >
                {interest}
              </button>
            ))}
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
