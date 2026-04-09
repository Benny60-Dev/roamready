import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { Truck, Map, CreditCard, Bell, Shield, ChevronRight, Save } from 'lucide-react'
import { usersApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'

export default function ProfilePage() {
  const { user, setUser } = useAuthStore()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const { register, handleSubmit, reset } = useForm({ defaultValues: user || {} })

  useEffect(() => {
    if (user) reset(user)
  }, [user])

  async function onSubmit(data: any) {
    setSaving(true)
    try {
      const res = await usersApi.updateMe(data)
      setUser({ ...user!, ...res.data })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const profileLinks = [
    { to: '/profile/rig', icon: Truck, label: 'Rig & Vehicle', sub: 'Manage your rigs' },
    { to: '/profile/style', icon: Map, label: 'Travel Style', sub: 'Preferences & budget' },
    { to: '/profile/memberships', icon: Shield, label: 'Memberships', sub: 'ATB, Good Sam, etc.' },
    { to: '/profile/notifications', icon: Bell, label: 'Notifications', sub: 'Alerts & reminders' },
    { to: '/profile/billing', icon: CreditCard, label: 'Billing', sub: user?.subscriptionTier === 'FREE' ? 'Free plan' : `${user?.subscriptionTier} plan` },
  ]

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-medium text-gray-900">Profile</h1>

      <div className="card-lg">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 bg-[#1D9E75] rounded-full flex items-center justify-center text-white font-medium">
            {user?.firstName?.[0]}{user?.lastName?.[0]}
          </div>
          <div>
            <p className="font-medium text-gray-900">{user?.firstName} {user?.lastName}</p>
            <p className="text-sm text-gray-500">{user?.email}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">First name</label>
              <input className="input" {...register('firstName')} />
            </div>
            <div>
              <label className="label">Last name</label>
              <input className="input" {...register('lastName')} />
            </div>
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input" type="tel" {...register('phone')} />
          </div>
          <div>
            <label className="label">Home base (city)</label>
            <input className="input" placeholder="Phoenix, AZ" {...register('homeLocation')} />
          </div>
          <div>
            <label className="label">Emergency contact name</label>
            <input className="input" {...register('emergencyContact')} />
          </div>
          <div>
            <label className="label">Emergency contact phone</label>
            <input className="input" type="tel" {...register('emergencyPhone')} />
          </div>
          <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2">
            <Save size={15} /> {saving ? 'Saving...' : saved ? 'Saved!' : 'Save changes'}
          </button>
        </form>
      </div>

      <div className="space-y-1">
        {profileLinks.map(({ to, icon: Icon, label, sub }) => (
          <Link key={to} to={to} className="card flex items-center gap-3 hover:border-[#1D9E75]/30 transition-all">
            <div className="w-8 h-8 bg-gray-50 rounded-lg flex items-center justify-center">
              <Icon size={16} className="text-gray-600" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">{label}</p>
              <p className="text-xs text-gray-500">{sub}</p>
            </div>
            <ChevronRight size={16} className="text-gray-400" />
          </Link>
        ))}
      </div>
    </div>
  )
}
