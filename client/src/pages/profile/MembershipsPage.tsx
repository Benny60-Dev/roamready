import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { PlusCircle, Trash2, CheckCircle } from 'lucide-react'
import { usersApi } from '../../services/api'
import { Membership } from '../../types'
import { MEMBERSHIP_TYPES } from '../../constants/memberships'

// Module-level so it survives page unmount/remount. Tracks isActive toggles that
// have been optimistically applied but whose PUT may still be in flight (or may
// have just landed but raced ahead of a fresh GET /memberships on a remount).
// Key = membership id, Value = the intended isActive. The mount-GET reconciles
// any id present here against the server response so a fast navigate-away-and-back
// doesn't repaint with stale pre-toggle data.
const pendingMembershipWrites = new Map<string, boolean>()

export default function MembershipsPage() {
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [selectedType, setSelectedType] = useState<string>('')
  const { register, handleSubmit, reset } = useForm()

  useEffect(() => {
    usersApi.getMemberships().then(res => {
      // Reconcile: for any membership whose PUT is still in flight (or just
      // landed but raced this GET), override the server's isActive with the
      // value we know the user intended. Once the PUT settles, its `finally`
      // clears the map entry so subsequent GETs use the server value as-is.
      const reconciled = (res.data as Membership[]).map(m =>
        pendingMembershipWrites.has(m.id)
          ? { ...m, isActive: pendingMembershipWrites.get(m.id)! }
          : m
      )
      setMemberships(reconciled)
    })
  }, [])

  async function onSubmit(data: any) {
    setSaving(true)
    try {
      const res = await usersApi.createMembership(data)
      setMemberships([...memberships, res.data])
      setShowForm(false)
      setSelectedType('')
      reset()
    } finally {
      setSaving(false)
    }
  }

  async function deleteMembership(id: string) {
    await usersApi.deleteMembership(id)
    setMemberships(memberships.filter(m => m.id !== id))
  }

  async function toggleActive(membership: Membership) {
    const next = !membership.isActive
    // Optimistic update first so the UI reflects the click instantly, even if
    // the user navigates away before the PUT resolves.
    setMemberships(prev => prev.map(m => m.id === membership.id ? { ...m, isActive: next } : m))
    // Park the intended value so the on-mount GET on any remount during the
    // PUT's lifetime keeps the optimistic value instead of the stale server one.
    pendingMembershipWrites.set(membership.id, next)
    try {
      await usersApi.updateMembership(membership.id, { isActive: next })
    } catch (err) {
      // Roll back local state. If the component already unmounted, this setState
      // is a safe no-op in React 18; the next mount's GET will get the true
      // server value because we clear the map below.
      setMemberships(prev => prev.map(m => m.id === membership.id ? { ...m, isActive: !next } : m))
      throw err
    } finally {
      pendingMembershipWrites.delete(membership.id)
    }
  }

  function openAddForm(typeId?: string) {
    reset()
    setSelectedType(typeId || '')
    setShowForm(true)
  }

  function closeAddForm() {
    setShowForm(false)
    setSelectedType('')
    reset()
  }

  const ownedTypes = MEMBERSHIP_TYPES.filter(t => memberships.some(m => m.type === t.id))
  const availableTypes = MEMBERSHIP_TYPES.filter(t => !memberships.some(m => m.type === t.id))

  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-xl font-medium text-gray-900">Memberships & Passes</h1>

      <p className="text-sm text-gray-500">Saved memberships help RoamReady find campgrounds you have access to and surface the right discounts.</p>

      {/* Your memberships */}
      <div className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500">Your memberships</h2>
        {ownedTypes.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No memberships added yet</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ownedTypes.map(type => {
              const membership = memberships.find(m => m.type === type.id)!
              const active = membership.isActive
              return (
                <div key={type.id} className={`card flex items-start justify-between ${active ? 'border-[#1F6F8B]/30' : ''}`}>
                  <div className="flex items-start gap-2">
                    {active ? (
                      <CheckCircle size={16} className="text-[#1F6F8B] flex-shrink-0 mt-0.5" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border-2 border-gray-200 flex-shrink-0 mt-0.5" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-gray-900">{type.label}</p>
                      <p className="text-xs text-gray-500">{type.sub}</p>
                      {membership.memberNumber && (
                        <p className="text-xs text-gray-400 mt-0.5">#{membership.memberNumber}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => toggleActive(membership)}
                      className={`text-xs px-2 py-1 rounded ${membership.isActive ? 'text-[#1F6F8B]' : 'text-gray-400'}`}
                    >
                      Active {membership.isActive ? 'on' : 'off'}
                    </button>
                    <button onClick={() => deleteMembership(membership.id)} className="p-1 hover:text-red-500 text-gray-400">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Available to add */}
      {availableTypes.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500">Available to add</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {availableTypes.map(type => (
              <button
                key={type.id}
                type="button"
                onClick={() => openAddForm(type.id)}
                className="card border-dashed flex items-start justify-between text-left hover:border-[#1F6F8B]/40 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-start gap-2">
                  <div className="w-4 h-4 rounded-full border-2 border-dashed border-gray-300 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-gray-500">{type.label}</p>
                    <p className="text-xs text-gray-400">{type.sub}</p>
                  </div>
                </div>
                <PlusCircle size={16} className="text-[#1F6F8B] flex-shrink-0 mt-0.5" />
              </button>
            ))}
          </div>
        </div>
      )}

      {showForm && (
        <div className="card-lg">
          <h3 className="font-medium text-gray-900 mb-4">Add membership</h3>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label className="label">Membership type</label>
              <select
                className="input"
                defaultValue={selectedType || MEMBERSHIP_TYPES[0].id}
                {...register('type', { required: true })}
              >
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
            <div className="flex gap-2">
              <button type="button" onClick={closeAddForm} className="btn-ghost flex-1">Cancel</button>
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
