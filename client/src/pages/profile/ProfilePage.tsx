import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { Autocomplete, useJsApiLoader } from '@react-google-maps/api'
import { Truck, Map, CreditCard, Shield, ChevronRight, ChevronDown, Save, MapPin, Accessibility, User, Users } from 'lucide-react'
import { usersApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'

const LIBRARIES: Parameters<typeof useJsApiLoader>[0]['libraries'] = ['marker', 'geometry', 'places']

export default function ProfilePage() {
  const { user, setUser } = useAuthStore()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Personal Information is an expand-in-place row (toggles the form below it
  // on /profile — it does NOT navigate, unlike the profileLinks rows).
  const [personalOpen, setPersonalOpen] = useState(false)
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
  const watchedFullTimer = watch('isFullTimeRVer') as boolean | undefined

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
    // Selecting a real address clears the full-timer flag (mutually exclusive).
    setValue('isFullTimeRVer', false, { shouldDirty: true })
  }

  async function onSubmit(data: any) {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await usersApi.updateMe(data)
      setUser({ ...user!, ...res.data })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      console.error('[ProfilePage] save failed:', e?.response?.data || e?.message)
      setSaveError("Couldn't save changes. Please try again.")
    } finally {
      setSaving(false)
    }
  }

  // Per-row brand-colored icons. color = icon (text-*), tint = soft square (bg-*/10).
  // All reference real tokens from tailwind.config.js (rr group + top-level
  // accent/premium/purple/red); see report for the substitutions made where a
  // requested hue had no matching token.
  const profileLinks = [
    { to: '/profile/rig',           icon: Truck,   label: 'Rig & Vehicle',  sub: 'Manage your rigs',       color: 'text-purple',            tint: 'bg-purple/10' },
    { to: '/profile/party',         icon: Users,   label: 'Travel Party',   sub: 'People & pets',          color: 'text-premium',           tint: 'bg-premium/10' },
    { to: '/profile/style',         icon: Map,     label: 'Travel Style',   sub: 'Preferences & budget',   color: 'text-red',               tint: 'bg-red/10' },
    { to: '/profile/accessibility', icon: Accessibility, label: 'Accessibility',  sub: 'Needs & requirements', color: 'text-accent-decorative', tint: 'bg-accent-decorative/10' },
    { to: '/profile/memberships',   icon: Shield,  label: 'Memberships',    sub: 'ATB, Good Sam, etc.',    color: 'text-rr-gold-700',       tint: 'bg-rr-gold/10' },
    // Notifications link removed May 19 — the settings page persists toggles
    // but no downstream code reads them, push/SMS have no providers, and 5
    // of 6 types have no sender. Route stays registered in App.tsx so any
    // bookmarked /profile/notifications URLs still work and re-linking here
    // post-launch is a one-line restoration once delivery is wired up.
    { to: '/profile/billing',       icon: CreditCard, label: 'Billing',     sub: user?.subscriptionTier === 'FREE' ? 'Free plan' : `${user?.subscriptionTier} plan`, color: 'text-rr-pine', tint: 'bg-rr-pine/10' },
  ]

  // Subtitle for the collapsed Personal Information row: full name · home city,
  // each part dropped gracefully when empty (falls back to a generic label).
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()
  const personalSub = [fullName, user?.homeCity].filter(Boolean).join(' · ') || 'Name, address & contact'

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-medium text-gray-900">{user?.firstName ? `${user.firstName}'s profile` : 'Profile'}</h1>

      <div className="space-y-1">
        {/* Personal Information — expand-in-place drill-down row. Matches the
            profileLinks rows visually (card / w-8 icon square / title+subtitle /
            chevron) but is a <button> that toggles the form below IN PLACE
            rather than a <Link> that navigates. First row, above Rig & Vehicle. */}
        <div className="card">
          <button
            type="button"
            onClick={() => setPersonalOpen(o => !o)}
            aria-expanded={personalOpen}
            className="w-full flex items-center gap-3 text-left"
          >
            <div className="w-8 h-8 bg-rr-blue/10 rounded-lg flex items-center justify-center">
              <User size={16} className="text-rr-blue" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">Personal Information</p>
              <p className="text-xs text-gray-500">{personalSub}</p>
            </div>
            <ChevronDown size={16} className={`text-gray-400 transition-transform ${personalOpen ? 'rotate-180' : ''}`} />
          </button>

          {personalOpen && (
            <div className="mt-4 pt-4 border-t border-gray-100">
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
            <label className="label">Home address</label>
            {isLoaded ? (
              <Autocomplete
                onLoad={ac => { autocompleteRef.current = ac }}
                onPlaceChanged={onPlaceChanged}
                options={{ types: ['address'], componentRestrictions: { country: 'us' } }}
              >
                {/* Controlled off RHF state (NOT register()'d, so the Google
                    Autocomplete keeps the input ref it needs). Reading the value
                    via watch() means reset(user) on hydrate — the same path that
                    fills the hidden registered fields below — now also drives
                    what's shown here, fixing the blank-on-load bug where the old
                    uncontrolled defaultValue never re-applied after user arrived.
                    onChange keeps free-text typing in sync for the autocomplete
                    search; onPlaceChanged still commits all 8 fields on select. */}
                <input
                  className="input"
                  placeholder="Start typing your address…"
                  value={(watch('homeAddress') as string | undefined) || (watch('homeLocation') as string | undefined) || ''}
                  onChange={e => setValue('homeAddress', e.target.value, { shouldDirty: true })}
                  disabled={!!watchedFullTimer}
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

          {/* Full-time RVer toggle — mutually exclusive with a saved home base.
              Checking it clears the 8 home fields (and disables the address input
              above); selecting an address clears this (see onPlaceChanged). Saved
              via the same onSubmit → updateMe. */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[#1F6F8B] rounded border-gray-300"
              {...register('isFullTimeRVer')}
              onChange={e => {
                setValue('isFullTimeRVer', e.target.checked, { shouldDirty: true })
                if (e.target.checked) {
                  // Clear to null (NOT ''): homeLat/homeLng are Float? columns and
                  // Prisma rejects '' → Float, which would throw the whole update.
                  // null is valid for all eight (all nullable in schema).
                  (['homeStreet', 'homeCity', 'homeState', 'homeZip', 'homeLat', 'homeLng', 'homeAddress', 'homeLocation'] as const)
                    .forEach(f => setValue(f, null as any, { shouldDirty: true }))
                }
              }}
            />
            <span className="text-sm text-gray-800">I'm a full-time RVer (no fixed home base)</span>
          </label>

          {/* Emergency contact name + phone removed (Block 6) — they were
              write-only (only the account holder sees their own Profile, so
              they'd never look up their own emergency contact) and implied a
              safety capability the product doesn't have. The travel-party
              emergency contact (Person.isEmergencyContact) is the live model
              for that use case and is reachable via /profile/party. */}

          {/* Hidden structured fields — populated by Autocomplete */}
          <input type="hidden" {...register('homeStreet')} />
          <input type="hidden" {...register('homeCity')} />
          <input type="hidden" {...register('homeState')} />
          <input type="hidden" {...register('homeZip')} />
          <input type="hidden" {...register('homeLat')} />
          <input type="hidden" {...register('homeLng')} />
          <input type="hidden" {...register('homeAddress')} />
          <input type="hidden" {...register('homeLocation')} />

          <div className="flex items-center gap-3">
            <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2">
              <Save size={15} /> {saving ? 'Saving...' : saved ? 'Saved!' : 'Save changes'}
            </button>
            {saveError && <p className="text-sm text-red-600">{saveError}</p>}
          </div>
        </form>
            </div>
          )}
        </div>

        {profileLinks.map(({ to, icon: Icon, label, sub, color, tint }) => (
          <Link key={to} to={to} className="card flex items-center gap-3 hover:border-[#1F6F8B]/30 transition-all">
            <div className={`w-8 h-8 ${tint} rounded-lg flex items-center justify-center`}>
              <Icon size={16} className={color} />
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
