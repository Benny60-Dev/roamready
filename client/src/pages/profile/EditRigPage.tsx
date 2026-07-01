import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { usersApi } from '../../services/api'
import { Rig, VehicleType } from '../../types'
import { VEHICLE_LABELS } from './RigPage'
import { deriveSecondVehicle, buildTowedFields, type TowingChoice } from '../../utils/rigs'
import { useScrollResetOnReady } from '../../hooks/useScrollResetOnReady'
import RigFormFields from '../../components/forms/RigFormFields'

// Mirrors RigPage's add-form shape exactly so users see the same inputs in
// the same order. Differences vs the add form:
//   1. Pre-populates from an existing Rig fetched on mount
//   2. Saves via usersApi.updateRig instead of createRig
//   3. Routes back to /profile/rig on success
//   4. Shows a "Loading..." state while the rig is being fetched
export default function EditRigPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [rig, setRig] = useState<Rig | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [saving, setSaving] = useState(false)
  const [towingChoice, setTowingChoice] = useState<TowingChoice>('NONE')
  const { register, handleSubmit, reset, watch, control } = useForm()
  const vehicleType: VehicleType | undefined = watch('vehicleType') as VehicleType | undefined
  // Direction is derived from vehicleType; RigFormFields owns the towingChoice
  // sync effect and second-vehicle UI. The page keeps `direction` only for the
  // save-time payload (buildTowedFields).
  const { direction } = deriveSecondVehicle(vehicleType)

  // No /users/me/rigs/:id endpoint exists — fetch all and filter. Cheap query.
  useEffect(() => {
    if (!id) return
    usersApi.getRigs().then(res => {
      const found = (res.data as Rig[]).find(r => r.id === id)
      if (!found) {
        setNotFound(true)
        return
      }
      setRig(found)
      // Hydrate the form. Convert the structured isTowing/towedType pair back
      // into the local TowingChoice radio state.
      reset({
        vehicleType: found.vehicleType,
        year: found.year,
        make: found.make,
        model: found.model,
        length: found.length,
        height: found.height,
        gvwr: found.gvwr,
        fuelType: found.fuelType,
        mpg: found.mpg,
        // Pre-fill the new towing-mpg field (Pass 2 of towing-aware fuel
        // estimate). Same hydration pattern as the existing solo `mpg`
        // above — RHF binds `register('mpgTowing', { valueAsNumber: true })`
        // in the form below to this value. Null is fine — the field
        // renders empty and the server preserves null if the user doesn't
        // touch it.
        mpgTowing: found.mpgTowing,
        tankSize: found.tankSize,
        electricalAmps: found.electricalAmps,
        garageLength: found.garageLength,
        toys: found.toys,
        licensePlate: found.licensePlate,
        towedYear: found.towedYear,
        towedMake: found.towedMake,
        towedModel: found.towedModel,
        towedLength: found.towedLength,
        towedLicensePlate: found.towedLicensePlate,
        // Block 7 — tow-vehicle-only fields. The form omits these inputs in
        // toad direction, so they'll be no-ops there, but seeding them
        // anyway lets users see the previously-saved value when switching
        // a rig's vehicleType from trailer back to a different trailer.
        towedHeight: found.towedHeight,
        towedFuelType: found.towedFuelType,
      })
      setTowingChoice(found.isTowing && found.towedType ? found.towedType : 'NONE')
    })
  }, [id, reset])

  // Reset window scroll to the top once the rig loads and the tall edit form
  // mounts (ready = rig is non-null; the page shows "Loading…" until then).
  // See hooks/useScrollResetOnReady for the full rationale.
  useScrollResetOnReady(!!rig)

  async function onSubmit(data: any) {
    if (!rig) return
    setSaving(true)
    try {
      // Direction-aware towed-field payload (shared with RigPage +
      // OnboardingPage — see utils/rigs.buildTowedFields).
      const { isTowing, towed } = buildTowedFields(data, direction, towingChoice)
      await usersApi.updateRig(rig.id, {
        ...data,
        isToyHauler: data.vehicleType === 'TOY_HAULER',
        isVan: data.vehicleType === 'VAN',
        isCamper: data.vehicleType === 'CAR_CAMPING',
        isTowing,
        ...towed,
      })
      // RIG-COMPLETENESS round-trip: when launched from the build-time notice the
      // URL carries ?returnTo=/sessions/:id — land the user back on their planning
      // session (now with a complete rig) instead of the rig list. Only honor an
      // internal path (leading '/') to avoid an open-redirect; otherwise default.
      const returnTo = searchParams.get('returnTo')
      navigate(returnTo && returnTo.startsWith('/') ? returnTo : '/profile/rig')
    } finally {
      setSaving(false)
    }
  }

  if (notFound) {
    return (
      <div className="space-y-4 max-w-2xl">
        <h1 className="text-xl font-medium text-gray-900">Edit rig</h1>
        <div className="card text-center py-10 text-sm text-gray-500">
          Rig not found.
          <div className="mt-3">
            <Link to="/profile/rig" className="text-[#1F6F8B] hover:underline">Back to my rigs</Link>
          </div>
        </div>
      </div>
    )
  }

  if (!rig) {
    return (
      <div className="space-y-4 max-w-2xl">
        <h1 className="text-xl font-medium text-gray-900">Edit rig</h1>
        <div className="card text-center py-10 text-sm text-gray-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <Link to="/profile/rig" className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" title="Back">
          <ArrowLeft size={16} />
        </Link>
        <h1 className="text-xl font-medium text-gray-900">Edit rig</h1>
      </div>

      <div className="card-lg">
        <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">{VEHICLE_LABELS[rig.vehicleType]}</p>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <RigFormFields
            variant="full"
            vehicleType={vehicleType}
            control={control}
            register={register}
            towingChoice={towingChoice}
            setTowingChoice={setTowingChoice}
          />

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={() => navigate('/profile/rig')} className="btn-ghost flex-1">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary flex-1">
              {saving ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
