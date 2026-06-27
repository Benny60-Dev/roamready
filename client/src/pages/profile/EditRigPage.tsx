import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { usersApi } from '../../services/api'
import { Rig, TowedType, VehicleType } from '../../types'
import { VEHICLE_LABELS } from './RigPage'
import { deriveSecondVehicle } from '../../utils/rigs'
import { useScrollResetOnReady } from '../../hooks/useScrollResetOnReady'
import RangeSelect from '../../components/forms/RangeSelect'
import { YEARS, LENGTHS, HEIGHTS, MPG_OPTIONS, TANK_OPTIONS, GVWR_OPTIONS } from '../../constants/rigOptions'

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
  const { register, handleSubmit, reset, watch, control } = useForm()
  const vehicleType: VehicleType | undefined = watch('vehicleType') as VehicleType | undefined
  const isToyHauler = vehicleType === 'TOY_HAULER'
  // Block 7 — see RigPage.tsx for the full direction-derivation rationale.
  // Mirror the same derivation here so the edit form behaves identically.
  const { direction } = deriveSecondVehicle(vehicleType)
  const showSecondVehicleSection = direction !== 'none'
  const isToadDirection = direction === 'toad'
  const isTowVehicleDirection = direction === 'tow_vehicle'

  // Keep towingChoice in sync with derived direction whenever the user
  // changes vehicleType inside the edit form. Reset behavior matches RigPage.
  useEffect(() => {
    if (isTowVehicleDirection) setTowingChoice('VEHICLE')
    else if (direction === 'none') setTowingChoice('NONE')
  }, [direction, isTowVehicleDirection])

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
      // Mirror RigPage.onSubmit's direction-aware build. See that file for
      // the full rationale; in short: tow_vehicle always saves (required),
      // toad saves only when user picked VEHICLE/TRAILER, 'none' clears all.
      let isTowing = false
      let towedFields: Record<string, unknown> = {
        towedType: null,
        towedYear: null,
        towedMake: null,
        towedModel: null,
        towedLength: null,
        towedLicensePlate: null,
        towedHeight: null,
        towedFuelType: null,
      }
      if (isTowVehicleDirection) {
        isTowing = true
        towedFields = {
          towedType: 'VEHICLE' as TowedType,
          towedYear: data.towedYear ?? null,
          towedMake: data.towedMake ?? null,
          towedModel: data.towedModel ?? null,
          towedLength: data.towedLength ?? null,
          towedLicensePlate: data.towedLicensePlate ?? null,
          towedHeight: data.towedHeight ?? null,
          towedFuelType: data.towedFuelType ?? null,
        }
      } else if (isToadDirection && towingChoice !== 'NONE') {
        isTowing = true
        towedFields = {
          towedType: towingChoice as TowedType,
          towedYear: towingChoice === 'VEHICLE' ? data.towedYear ?? null : null,
          towedMake:  towingChoice === 'VEHICLE' ? data.towedMake  ?? null : null,
          towedModel: towingChoice === 'VEHICLE' ? data.towedModel ?? null : null,
          towedLength: data.towedLength ?? null,
          towedLicensePlate: data.towedLicensePlate ?? null,
          // Toad direction doesn't collect height/fuelType — keep null.
          towedHeight: null,
          towedFuelType: null,
        }
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
              <Controller
                control={control}
                name="year"
                rules={{ required: true }}
                render={({ field }) => (
                  <RangeSelect options={YEARS} integer placeholder="Select year" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                )}
              />
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
              <Controller
                control={control}
                name="length"
                render={({ field }) => (
                  <RangeSelect options={LENGTHS} placeholder="Select length" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                )}
              />
            </div>
            <div>
              <label className="label">Height (ft)</label>
              <Controller
                control={control}
                name="height"
                render={({ field }) => (
                  <RangeSelect options={HEIGHTS} placeholder="Select height" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                )}
              />
            </div>
          </div>
          {/* Weight — GVWR in POUNDS (US units, matching Length/Height in feet).
              Optional. Feeds vehicle[grossWeight] in HERE truck routing for
              weight-restricted bridge/road avoidance. */}
          <div>
            <label className="label">Weight – GVWR (lbs)</label>
            <Controller
              control={control}
              name="gvwr"
              render={({ field }) => (
                <RangeSelect options={GVWR_OPTIONS} integer placeholder="Select GVWR" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
              )}
            />
            <p className="text-xs text-gray-400 mt-1">Optional. Gross Vehicle Weight Rating in pounds — used for weight-restricted routing.</p>
          </div>
          {/* ── Fuel / MPG section — adapts to rig type (Pass 2 of towing-
              aware fuel estimate, May 2026). Mirrors the same conditional
              from RigPage.tsx — see that file for the rationale. TRAILERS:
              single MPG bound to mpgTowing + intro line, no rig fuelType
              (the tow-vehicle's towedFuelType below is what's priced).
              MOTORHOMES / VANS / CAR CAMPING: solo MPG + a second MPG-
              while-towing-a-toad field. */}
          {isTowVehicleDirection ? (
            <>
              <p className="text-xs text-gray-500 italic">
                Your {VEHICLE_LABELS[vehicleType as VehicleType]?.toLowerCase() ?? 'trailer'} is towed,
                so we just need your tow vehicle's mileage with it hitched.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">MPG — towing this trailer</label>
                  <Controller
                    control={control}
                    name="mpgTowing"
                    render={({ field }) => (
                      <RangeSelect options={MPG_OPTIONS} placeholder="Select MPG" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                    )}
                  />
                  <p className="mt-1 text-xs text-gray-400">What your tow vehicle gets pulling this rig.</p>
                </div>
                <div>
                  <label className="label">Tank (gal)</label>
                  <Controller
                    control={control}
                    name="tankSize"
                    render={({ field }) => (
                      <RangeSelect options={TANK_OPTIONS} placeholder="Select tank size" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                    )}
                  />
                </div>
              </div>
            </>
          ) : (
            <>
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
                  <label className="label">MPG — solo</label>
                  <Controller
                    control={control}
                    name="mpg"
                    render={({ field }) => (
                      <RangeSelect options={MPG_OPTIONS} placeholder="Select MPG" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                    )}
                  />
                </div>
                <div>
                  <label className="label">Tank (gal)</label>
                  <Controller
                    control={control}
                    name="tankSize"
                    render={({ field }) => (
                      <RangeSelect options={TANK_OPTIONS} placeholder="Select tank size" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                    )}
                  />
                </div>
              </div>
              <div>
                <label className="label">MPG — towing a toad</label>
                <Controller
                  control={control}
                  name="mpgTowing"
                  render={({ field }) => (
                    <RangeSelect options={MPG_OPTIONS} placeholder="Select MPG" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                  )}
                />
                <p className="mt-1 text-xs text-gray-400">
                  Trips use the towing figure when you're bringing the toad, solo otherwise. Leave blank to always use solo.
                </p>
              </div>
            </>
          )}
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
                <Controller
                  control={control}
                  name="garageLength"
                  render={({ field }) => (
                    <RangeSelect options={LENGTHS} placeholder="Select length" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                  )}
                />
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

          {/* ── Second-vehicle section (Block 7) ─────────────────────────
              Mirrors RigPage's add-form behavior — see that file for the
              direction-derivation rationale. */}
          {showSecondVehicleSection && isToadDirection && (
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
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-700">
                      {towingChoice === 'VEHICLE' ? 'Towed vehicle' : 'About your trailer'}
                    </p>
                    {towingChoice === 'VEHICLE' && <span className="badge-active text-xs">Toad</span>}
                  </div>
                  {towingChoice === 'VEHICLE' && (
                    <>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="label">Year</label>
                          <Controller
                            control={control}
                            name="towedYear"
                            rules={{ required: true }}
                            render={({ field }) => (
                              <RangeSelect options={YEARS} integer placeholder="Select year" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                            )}
                          />
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
                          <Controller
                            control={control}
                            name="towedLength"
                            render={({ field }) => (
                              <RangeSelect options={LENGTHS} placeholder="Select length" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                            )}
                          />
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
                        <Controller
                          control={control}
                          name="towedLength"
                          render={({ field }) => (
                            <RangeSelect options={LENGTHS} placeholder="Select length" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                          )}
                        />
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

          {showSecondVehicleSection && isTowVehicleDirection && (
            <div className="rounded-xl bg-gray-50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-gray-700">Your tow vehicle</p>
                <span className="badge-active text-xs">Required to tow</span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">Year</label>
                  <Controller
                    control={control}
                    name="towedYear"
                    rules={{ required: true }}
                    render={({ field }) => (
                      <RangeSelect options={YEARS} integer placeholder="Select year" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                    )}
                  />
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
                  <Controller
                    control={control}
                    name="towedLength"
                    render={({ field }) => (
                      <RangeSelect options={LENGTHS} placeholder="Select length" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                    )}
                  />
                </div>
                <div>
                  <label className="label">Height (ft)</label>
                  <Controller
                    control={control}
                    name="towedHeight"
                    render={({ field }) => (
                      <RangeSelect options={HEIGHTS} placeholder="Select height" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                    )}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">License plate</label>
                  <input
                    className="input"
                    style={{ textTransform: 'uppercase' }}
                    {...register('towedLicensePlate')}
                  />
                </div>
                <div>
                  <label className="label">Fuel type</label>
                  <select className="input" {...register('towedFuelType')}>
                    <option value="">Any</option>
                    <option value="Gas">Gas</option>
                    <option value="Diesel">Diesel</option>
                    <option value="Electric">Electric</option>
                  </select>
                </div>
              </div>
            </div>
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
