import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Plus, Trash2, CheckCircle } from 'lucide-react'
import { usersApi } from '../../services/api'
import { Membership } from '../../types'

const MEMBERSHIP_TYPES = [
  { id: 'ATB', label: 'America the Beautiful Pass', sub: 'Federal recreation lands' },
  { id: 'GOOD_SAM', label: 'Good Sam Club', sub: '10% off campgrounds' },
  { id: 'THOUSAND_TRAILS', label: 'Thousand Trails', sub: 'Preserve network' },
  { id: 'COAST_TO_COAST', label: 'Coast to Coast', sub: 'Private campground network' },
  { id: 'ESCAPEES', label: 'Escapees RV Club', sub: 'RVers support network' },
  { id: 'FMCA', label: 'FMCA', sub: 'Family Motor Coach Association' },
  { id: 'HARVEST_HOSTS', label: 'Harvest Hosts', sub: 'Farm, winery & museum stays' },
  { id: 'BOONDOCKERS_WELCOME', label: 'Boondockers Welcome', sub: 'Driveway camping network' },
]

export default function MembershipsPage() {
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const { register, handleSubmit, reset } = useForm()

  useEffect(() => {
    usersApi.getMemberships().then(res => setMemberships(res.data))
  }, [])

  async function onSubmit(data: any) {
    setSaving(true)
    try {
      const res = await usersApi.createMembership(data)
      setMemberships([...memberships, res.data])
      setShowForm(false)
      reset()
    } finally {
      setSaving(false)
    }
  }

  async function deleteMembership(id: string) {
    await usersApi.deleteMembership(id)
    setMemberships(memberships.filter(m => m.id !== id))
  }

  async function toggleAutoApply(membership: Membership) {
    await usersApi.updateMembership(membership.id, { autoApply: !membership.autoApply })
    setMemberships(memberships.map(m => m.id === membership.id ? { ...m, autoApply: !m.autoApply } : m))
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium text-gray-900">Memberships & Passes</h1>
        <button onClick={() => setShowForm(!showForm)} className="btn-primary flex items-center gap-1.5 text-sm">
          <Plus size={15} /> Add
        </button>
      </div>

      <p className="text-sm text-gray-500">Your memberships are automatically applied when finding compatible campgrounds and calculating discounts.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {MEMBERSHIP_TYPES.map(type => {
          const membership = memberships.find(m => m.type === type.id)
          const active = !!membership
          return (
            <div key={type.id} className={`card flex items-start justify-between ${active ? 'border-[#1E3A8A]/30' : ''}`}>
              <div className="flex items-start gap-2">
                {active ? (
                  <CheckCircle size={16} className="text-[#1E3A8A] flex-shrink-0 mt-0.5" />
                ) : (
                  <div className="w-4 h-4 rounded-full border-2 border-gray-200 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <p className="text-sm font-medium text-gray-900">{type.label}</p>
                  <p className="text-xs text-gray-500">{type.sub}</p>
                  {membership?.memberNumber && (
                    <p className="text-xs text-gray-400 mt-0.5">#{membership.memberNumber}</p>
                  )}
                </div>
              </div>
              {active && membership && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => toggleAutoApply(membership)}
                    className={`text-xs px-2 py-1 rounded ${membership.autoApply ? 'text-[#1E3A8A]' : 'text-gray-400'}`}
                  >
                    Auto-apply {membership.autoApply ? 'on' : 'off'}
                  </button>
                  <button onClick={() => deleteMembership(membership.id)} className="p-1 hover:text-red-500 text-gray-400">
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {showForm && (
        <div className="card-lg">
          <h3 className="font-medium text-gray-900 mb-4">Add membership</h3>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label className="label">Membership type</label>
              <select className="input" {...register('type', { required: true })}>
                {MEMBERSHIP_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Member number (optional)</label>
              <input className="input" {...register('memberNumber')} />
            </div>
            <div>
              <label className="label">Plan tier (optional)</label>
              <input className="input" placeholder="e.g. Premium, Elite" {...register('planTier')} />
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="autoApply" defaultChecked {...register('autoApply')} />
              <label htmlFor="autoApply" className="text-sm text-gray-700">Auto-apply when searching campgrounds</label>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowForm(false)} className="btn-ghost flex-1">Cancel</button>
              <button type="submit" disabled={saving} className="btn-primary flex-1">
                {saving ? 'Adding...' : 'Add membership'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
