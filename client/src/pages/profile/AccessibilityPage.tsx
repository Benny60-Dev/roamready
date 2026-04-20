import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Save } from 'lucide-react'
import { usersApi } from '../../services/api'

export default function AccessibilityPage() {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const { register, handleSubmit } = useForm()

  async function onSubmit(data: any) {
    setSaving(true)
    try {
      await usersApi.updateTravelProfile({ accessibilityNeeds: data })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-xl font-medium text-gray-900">Accessibility Needs</h1>
      <p className="text-sm text-gray-500">Tell us about any accessibility requirements so we can filter campgrounds accordingly.</p>

      <form onSubmit={handleSubmit(onSubmit)} className="card-lg space-y-4">
        <div className="space-y-3">
          {[
            { id: 'wheelchair', label: 'Wheelchair accessible sites required' },
            { id: 'paved_path', label: 'Paved/accessible paths to facilities' },
            { id: 'accessible_restroom', label: 'Accessible restrooms required' },
            { id: 'near_facility', label: 'Site must be near facilities' },
            { id: 'level_site', label: 'Level site required' },
            { id: 'low_elevation', label: 'Prefer low elevation' },
          ].map(({ id, label }) => (
            <label key={id} className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" {...register(id)} className="rounded w-4 h-4 text-[#1E3A8A]" />
              <span className="text-sm text-gray-700">{label}</span>
            </label>
          ))}
        </div>
        <div>
          <label className="label">Other notes</label>
          <textarea className="input resize-none min-h-[80px]" placeholder="Any other accessibility requirements..." {...register('notes')} />
        </div>
        <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2">
          <Save size={15} /> {saving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
        </button>
      </form>
    </div>
  )
}
