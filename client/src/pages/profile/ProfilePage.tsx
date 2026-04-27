import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { Autocomplete, useJsApiLoader } from '@react-google-maps/api'
import { Truck, Map, CreditCard, Bell, Shield, ChevronRight, Save, MapPin, Accessibility } from 'lucide-react'
import { usersApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'

const LIBRARIES: Parameters<typeof useJsApiLoader>[0]['libraries'] = ['marker', 'geometry', 'places']

export default function ProfilePage() {
  const { user, setUser } = useAuthStore()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const { register, handleSubmit, reset, setValue, watch } = useForm({ defaultValues: user || {} })
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
    libraries: LIBRARIES,
  })

  useEffect(() => {
    if (user) reset(user)
  }, [user])

  const watchedCity  = watch('homeCity')  as string | undefined
  const watchedState = watch('homeState') as string | undefined

  function onPlaceChanged() {
    const place = autocompleteRef.current?.getPlace()
    if (!place?.address_components) return

    let streetNum = '', route = '', city = '', state = '', zip = ''
    for (const comp of place.address_components) {
      if (comp.types.includes('street_number'))            streetNum = comp.long_name
      if (comp.types.includes('route'))                    route     = comp.long_name
      if (comp.types.includes('locality'))                 city      = comp.long_name
      if (comp.types.includes('administrative_area_level_1')) state  = comp.short_name
      if (comp.types.includes('postal_code'))              zip       = comp.long_name
    }

    const street  = streetNum ? `${streetNum} ${route}`.trim() : route
    const lat     = place.geometry?.location?.lat()
    const lng     = place.geometry?.location?.lng()
    const full    = place.formatted_address || ''

    setValue('homeStreet',  street,  { shouldDirty: true })
    setValue('homeCity',    city,    { shouldDirty: true })
    setValue('homeState',   state,   { shouldDirty: true })
    setValue('homeZip',     zip,     { shouldDirty: true })
    setValue('homeLat',     lat,     { shouldDirty: true })
    setValue('homeLng',     lng,     { shouldDirty: true })
    setValue('homeAddress', full,    { shouldDirty: true })
    setValue('homeLocation', full,   { shouldDirty: true })
  }

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
    { to: '/profile/rig',           icon: Truck,   label: 'Rig & Vehicle',  sub: 'Manage your rigs' },
    { to: '/profile/style',         icon: Map,     label: 'Travel Style',   sub: 'Preferences & budget' },
    { to: '/profile/accessibility', icon: Accessibility, label: 'Accessibility',  sub: 'Needs & requirements' },
    { to: '/profile/memberships',   icon: Shield,  label: 'Memberships',    sub: 'ATB, Good Sam, etc.' },
    { to: '/profile/notifications', icon: Bell,    label: 'Notifications',  sub: 'Alerts & reminders' },
    { to: '/profile/billing',       icon: CreditCard, label: 'Billing',     sub: user?.subscriptionTier === 'FREE' ? 'Free plan' : `${user?.subscriptionTier} plan` },
  ]

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-medium text-gray-900">Profile</h1>

      <div className="card-lg">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 bg-[#1F6F8B] rounded-full flex items-center justify-center text-white font-medium">
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
            <label className="label">Home address</label>
            {isLoaded ? (
              <Autocomplete
                onLoad={ac => { autocompleteRef.current = ac }}
                onPlaceChanged={onPlaceChanged}
                options={{ types: ['address'], componentRestrictions: { country: 'us' } }}
              >
                <input
                  className="input"
                  placeholder="Start typing your address…"
                  defaultValue={user?.homeAddress || user?.homeLocation || ''}
                />
              </Autocomplete>
            ) : (
              <input
                className="input"
                placeholder="Loading…"
                disabled
              />
            )}
            {watchedCity && watchedState && (
              <p className="mt-1.5 flex items-center gap-1 text-xs text-[#1F6F8B]">
                <MapPin size={11} />
                {watchedCity}, {watchedState}{watch('homeZip') ? ` ${watch('homeZip')}` : ''}
              </p>
            )}
          </div>

          <div>
            <label className="label">Emergency contact name</label>
            <input className="input" {...register('emergencyContact')} />
          </div>
          <div>
            <label className="label">Emergency contact phone</label>
            <input className="input" type="tel" {...register('emergencyPhone')} />
          </div>

          {/* Hidden structured fields — populated by Autocomplete */}
          <input type="hidden" {...register('homeStreet')} />
          <input type="hidden" {...register('homeCity')} />
          <input type="hidden" {...register('homeState')} />
          <input type="hidden" {...register('homeZip')} />
          <input type="hidden" {...register('homeLat')} />
          <input type="hidden" {...register('homeLng')} />
          <input type="hidden" {...register('homeAddress')} />
          <input type="hidden" {...register('homeLocation')} />

          <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2">
            <Save size={15} /> {saving ? 'Saving...' : saved ? 'Saved!' : 'Save changes'}
          </button>
        </form>
      </div>

      <div className="space-y-1">
        {profileLinks.map(({ to, icon: Icon, label, sub }) => (
          <Link key={to} to={to} className="card flex items-center gap-3 hover:border-[#1F6F8B]/30 transition-all">
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
