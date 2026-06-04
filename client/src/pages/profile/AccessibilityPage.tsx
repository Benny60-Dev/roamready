import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Save } from 'lucide-react'
import { usersApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { Person, TravelParty } from '../../types'

export default function AccessibilityPage() {
  const { user } = useAuthStore()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // The user's default party. Accessibility is read from / written to the
  // user's OWN person within it (Person.isSelf === true) because that's the
  // row the AI planner actually consults — Person.accessibilityNeeds,
  // aggregated across traveling people. The legacy
  // TravelProfile.accessibilityNeeds this page used to write is ignored by
  // the planner, so it's no longer touched here.
  const [party, setParty] = useState<TravelParty | null>(null)
  const { register, handleSubmit, reset } = useForm()

  // Hydrate the 6 booleans + notes from the self person's accessibilityNeeds.
  // A user may have no default party yet, or a party with no isSelf person
  // yet — both hydrate empty (checkboxes unchecked) rather than crashing. The
  // party/person is lazily created on first save (see onSubmit), mirroring
  // TravelPartyPage's ensureParty pattern.
  useEffect(() => {
    usersApi.getDefaultParty()
      .then(res => {
        const p: TravelParty | null = res.data
        setParty(p)
        const self = p?.people?.find(person => person.isSelf)
        reset(self?.accessibilityNeeds ?? {})
      })
      .catch(() => {
        setParty(null)
        reset({})
      })
  }, [reset])

  async function onSubmit(data: any) {
    setSaving(true)
    try {
      // 1) Ensure a default party exists (lazy-create on first write).
      let target = party
      if (!target) {
        const res = await usersApi.createParty({})
        target = res.data as TravelParty
      }
      // 2) Find the user's own person; create one (stamped isSelf) if none
      //    exists yet. isSelf is accepted on create only — see
      //    schemas/travelParty.ts PersonCreateSchema.
      let self: Person | undefined = target.people?.find(p => p.isSelf)
      if (!self) {
        const res = await usersApi.createPerson(target.id, {
          role: 'ADULT',
          name: user?.firstName?.trim() || 'Me',
          isTraveling: true,
          isSelf: true,
        })
        self = res.data as Person
        target = { ...target, people: [...(target.people ?? []), self] }
      }
      // 3) Persist the 6 booleans + notes (exact shape the form produces and
      //    the planner reads) onto the self person.
      const updated = await usersApi.updatePerson(target.id, self.id, { accessibilityNeeds: data })
      // Keep local state in sync so a subsequent save reuses the same self row
      // instead of creating a duplicate.
      setParty({
        ...target,
        people: (target.people ?? []).map(p => (p.id === updated.data.id ? updated.data : p)),
      })
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

      <div className="rounded-lg border border-[#1F6F8B]/20 bg-[#1F6F8B]/5 px-4 py-3 text-sm text-gray-600">
        RoamReady uses these preferences to prioritize sites that report matching accessibility features. Availability and accuracy aren't guaranteed — always confirm specific accessibility details directly with the campground before booking.
      </div>

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
              <input type="checkbox" {...register(id)} className="rounded w-4 h-4 text-[#1F6F8B]" />
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
