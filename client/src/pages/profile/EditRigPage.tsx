import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { usersApi } from '../../services/api'
import { Rig, TowedType, VehicleType } from '../../types'
import { VEHICLE_LABELS } from './RigPage'

type TowingChoice = 'NONE' | 'VEHICLE' | 'TRAILER'

// Mirrors RigPage's add-form shape exactly so users see the same inputs in
// the same order. Differences vs the add form:
//   1. Pre-populates from an existing Rig fetched on mount
//   2. Saves via usersApi.updateRig instead of createRig
//   3. Routes back to /profile/rig on success
//   4. Shows a "Loading..." state while the rig is being fetched
export default function EditRigPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [rig, setRig] = useState<Rig | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [saving, setSaving] = useState(false)
  const [towingChoice, setTowingChoice] = useState<TowingChoice>('NONE')
  const { register, handleSubmit, reset, watch } = useForm()
  const vehicleType: VehicleType | undefined = watch('vehicleType') as VehicleType | undefined
  const isToyHauler = vehicleType === 'TOY_HAULER'
  const towingApplies = vehicleType === 'RV_CLASS_A' || vehicleType === 'RV_CLASS_B' || vehicleType === 'RV_CLASS_C'

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
        fuelType: found.fuelType,
        mpg: found.mpg,
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
      })
      setTowingChoice(found.isTowing && found.towedType ? found.towedType : 'NONE')
    })
  }, [id, reset])

  async function onSubmit(data: any) {
    if (!rig) return
    setSaving(true)
    try {
      const isTowing = towingApplies && towingChoice !== 'NONE'
      const towedType: TowedType | null = isTowing ? (towingChoice as TowedType) : null
      const towedFields = isTowing
        ? {
            towedType,
            towedYear: towingChoice === 'VEHICLE' ? data.towedYear : null,
            towedMake: towingChoice === 'VEHICLE' ? data.towedMake : null,
            towedModel: towingChoice === 'VEHICLE' ? data.towedModel : null,
            towedLength: data.towedLength ?? null,
            towedLicensePlate: data.towedLicensePlate ?? null,
          }
        : {
            towedType: null,
            towedYear: null,
            towedMake: null,
            towedModel: null,
            towedLength: null,
            towedLicensePlate: null,
          }
      await usersApi.updateRig(rig.id, {
        ...data,
        isToyHauler: data.vehicleType === 'TOY_HAULER',
        isVan: data.vehicleType === 'VAN',
        isCamper: data.vehicleType === 'CAR_CAMPING',
        isTowing,
        ...towedFields,
      })
      navigate('/profile/rig')
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
          <div>
            <label className="label">Vehicle type</label>
            <select className="input" {...register('vehicleType', { required: true })}>
              {Object.entries(VEHICLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Year</label>
              <input type="number" className="input" {...register('year', { valueAsNumber: true })} />
            </div>
            <div>
              <label className="label">Make</label>
              <input className="input" {...register('make')} />
            </div>
            <div>
              <label className="label">Model</label>
              <input className="input" {...register('model')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Length (ft)</label>
              <input type="number" step="0.1" min="0" className="input" {...register('length', { valueAsNumber: true })} />
            </div>
            <div>
              <label className="label">Height (ft)</label>
              <input type="number" step="0.1" min="0" className="input" {...register('height', { valueAsNumber: true })} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Fuel type</label>
              <select className="input" {...register('fuelType')}>
                <option value="">Any</option>
                <option value="Gas">Gas</option>
                <option value="Diesel">Diesel</option>
                <option value="Electric">Electric</option>
              </select>
            </div>
            <div>
              <label className="label">MPG</label>
              <input type="number" step="0.1" min="0" className="input" {...register('mpg', { valueAsNumber: true })} />
            </div>
            <div>
              <label className="label">Tank (gal)</label>
              <input type="number" step="0.1" min="0" className="input" {...register('tankSize', { valueAsNumber: true })} />
            </div>
          </div>
          <div>
            <label className="label">Electrical amps</label>
            <select className="input" {...register('electricalAmps')}>
              <option value="">None</option>
              <option value="30">30 amp</option>
              <option value="50">50 amp</option>
            </select>
          </div>

          {isToyHauler && (
            <div className="border border-amber-100 rounded-xl p-4 bg-amber-50/30 space-y-3">
              <p className="text-sm font-medium text-amber-800">🏍️ Toy Hauler Details</p>
              <div>
                <label className="label">Garage length (ft)</label>
                <input type="number" step="0.1" min="0" className="input" {...register('garageLength', { valueAsNumber: true })} />
              </div>
              <div>
                <label className="label">Toys (check all that apply)</label>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  {['ATV/Quad', 'UTV/Side-by-side', 'Dirt bikes', 'Motorcycles', 'Snowmobiles', 'Watercraft'].map(toy => (
                    <label key={toy} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" value={toy} {...register('toys')} />
                      {toy}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* License plate */}
          <div>
            <label className="label">License plate</label>
            <input
              className="input"
              style={{ textTransform: 'uppercase' }}
              placeholder="ABC-1234"
              {...register('licensePlate')}
            />
            <p className="mt-1 text-xs text-gray-400">Most campgrounds ask for this at check-in.</p>
          </div>

          {/* Towing question — gated to motorhomes only */}
          {towingApplies && (
            <>
              <div>
                <label className="label">Are you towing?</label>
                <div className="grid grid-cols-3 gap-2 mt-1">
                  {([
                    { val: 'NONE', label: 'Not towing' },
                    { val: 'VEHICLE', label: 'Towing a vehicle' },
                    { val: 'TRAILER', label: 'Towing a trailer' },
                  ] as { val: TowingChoice; label: string }[]).map(opt => (
                    <button
                      key={opt.val}
                      type="button"
                      onClick={() => setTowingChoice(opt.val)}
                      className={`px-3 py-2 rounded-xl text-sm border transition-colors ${
                        towingChoice === opt.val
                          ? 'border-[#1F6F8B] bg-[#E0F0F4] text-[#1F6F8B] font-medium'
                          : 'border-gray-200 bg-white text-gray-700 hover:border-[#1F6F8B]/40'
                      }`}
                      style={{ borderWidth: '0.5px' }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {towingChoice !== 'NONE' && (
                <div className="rounded-xl bg-gray-50 p-4 space-y-3">
                  <p className="text-sm font-medium text-gray-700">
                    {towingChoice === 'VEHICLE' ? 'About your toad' : 'About your trailer'}
                  </p>
                  {towingChoice === 'VEHICLE' && (
                    <>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="label">Year</label>
                          <input type="number" className="input" {...register('towedYear', { valueAsNumber: true })} />
                        </div>
                        <div>
                          <label className="label">Make</label>
                          <input className="input" {...register('towedMake')} />
                        </div>
                        <div>
                          <label className="label">Model</label>
                          <input className="input" {...register('towedModel')} />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="label">Length (ft)</label>
                          <input type="number" step="0.1" min="0" className="input" {...register('towedLength', { valueAsNumber: true })} />
                        </div>
                        <div>
                          <label className="label">License plate</label>
                          <input
                            className="input"
                            style={{ textTransform: 'uppercase' }}
                            {...register('towedLicensePlate')}
                          />
                        </div>
                      </div>
                    </>
                  )}
                  {towingChoice === 'TRAILER' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="label">Length (ft)</label>
                        <input type="number" step="0.1" min="0" className="input" {...register('towedLength', { valueAsNumber: true })} />
                      </div>
                      <div>
                        <label className="label">License plate</label>
                        <input
                          className="input"
                          style={{ textTransform: 'uppercase' }}
                          {...register('towedLicensePlate')}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

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
