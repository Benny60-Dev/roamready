import { Controller, useWatch, type Control, type UseFormRegister, type UseFormSetValue } from 'react-hook-form'
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { VehicleType, SecondVehicle } from '../../types'
import { deriveSecondVehicle, VEHICLE_LABELS, type TowingChoice } from '../../utils/rigs'
import { usersApi } from '../../services/api'
import RangeSelect from './RangeSelect'
import { YEARS, LENGTHS, HEIGHTS, MPG_OPTIONS, TANK_OPTIONS, GVWR_OPTIONS } from '../../constants/rigOptions'

// App teal — used for the "Where do I find this?" GVWR helper summary + link,
// and the "Reuse a saved vehicle" picker accent.
const TEAL = '#1F6F8B'

/** Display label for a saved second vehicle — "[year] [make] [model]", falling
 *  back to the towedType word when none are set. */
function savedVehicleLabel(v: SecondVehicle): string {
  const ymm = [v.year, v.make, v.model].filter(Boolean).join(' ').trim()
  if (ymm) return ymm
  return v.towedType === 'TRAILER' ? 'Trailer' : 'Vehicle'
}

interface RigFormFieldsProps {
  /** 'full' = Add/Edit rig page (every field). 'onboarding' = signup step
   *  (drops the vehicle-type select, electrical amps, toy-hauler block, the
   *  MPG-towing-a-toad field, and the tow-vehicle height/fuel inputs). */
  variant: 'full' | 'onboarding'
  vehicleType: VehicleType | undefined
  control: Control<any>
  register: UseFormRegister<any>
  setValue: UseFormSetValue<any>
  towingChoice: TowingChoice
  setTowingChoice: (c: TowingChoice) => void
}

/**
 * The shared rig-form field body — the canonical set previously hand-maintained
 * (and drifted) across RigPage, EditRigPage and OnboardingPage. Renders ONLY the
 * inputs; each page keeps its own useForm/useState, submit handler, and chrome.
 *
 * Second-vehicle direction is derived internally from vehicleType via
 * deriveSecondVehicle(): 'toad' shows the optional radio + sub-form, 'tow_vehicle'
 * shows an always-on tow-vehicle sub-form, 'none' hides the section.
 */
export default function RigFormFields({
  variant,
  vehicleType,
  control,
  register,
  setValue,
  towingChoice,
  setTowingChoice,
}: RigFormFieldsProps) {
  const isFull = variant === 'full'
  const isToyHauler = vehicleType === 'TOY_HAULER'
  const { direction } = deriveSecondVehicle(vehicleType)
  const showSecondVehicleSection = direction !== 'none'
  const isToadDirection = direction === 'toad'
  const isTowVehicleDirection = direction === 'tow_vehicle'

  // Saved second-vehicle library (RIGINFO-4). Fetched once the rig has a
  // second-vehicle concept; used only to offer a "reuse" picker — selecting one
  // COPIES its values into the rig's own towed* form fields.
  const [savedVehicles, setSavedVehicles] = useState<SecondVehicle[]>([])
  useEffect(() => {
    if (direction === 'none') return
    let cancelled = false
    usersApi
      .getSecondVehicles()
      .then(res => { if (!cancelled) setSavedVehicles(res.data) })
      .catch(() => { /* non-fatal — the picker just won't appear */ })
    return () => { cancelled = true }
  }, [direction])

  // Copy a saved vehicle's values into the towed* form fields. In toad
  // direction, also flip the radio to VEHICLE so the (just-filled) sub-form is
  // the one shown.
  function applySavedVehicle(v: SecondVehicle) {
    setValue('towedYear', v.year ?? null)
    setValue('towedMake', v.make ?? null)
    setValue('towedModel', v.model ?? null)
    setValue('towedLength', v.length ?? null)
    setValue('towedHeight', v.height ?? null)
    setValue('towedLicensePlate', v.licensePlate ?? null)
    setValue('towedFuelType', v.fuelType ?? null)
    if (isToadDirection) setTowingChoice('VEHICLE')
  }

  // Delete a saved vehicle from the library. Confirm first, fire the DELETE
  // (fire-and-forget), and drop it from local state optimistically so the chip
  // disappears immediately.
  function removeSavedVehicle(v: SecondVehicle) {
    if (!window.confirm('Remove this saved vehicle?')) return
    usersApi.deleteSecondVehicle(v.id).catch(() => { /* non-fatal */ })
    setSavedVehicles(prev => prev.filter(x => x.id !== v.id))
  }

  // Blank rows (no year/make/model) never render — an unlabeled chip is
  // indistinguishable and useless. Filter once so the heading gate and the chip
  // map share the same clean list.
  const pickableVehicles = savedVehicles.filter(v => v.year || v.make || v.model)

  // Rendered at the TOP of each second-vehicle sub-form, but only when the user
  // has >= 1 saved vehicle with identifying data. A chip list (not a <select>)
  // so each row can carry its own delete button.
  const savedVehiclePicker = pickableVehicles.length > 0 && (
    <div>
      <label className="label" style={{ color: TEAL }}>Reuse a saved vehicle</label>
      <div className="flex flex-wrap gap-2">
        {pickableVehicles.map(v => {
          const label = savedVehicleLabel(v)
          return (
            <div
              key={v.id}
              className="inline-flex items-center rounded-full text-xs"
              style={{ border: `0.5px solid ${TEAL}`, color: TEAL, backgroundColor: '#E0F0F4' }}
            >
              <button
                type="button"
                onClick={() => applySavedVehicle(v)}
                className="pl-3 pr-1.5 py-1 hover:underline"
              >
                {label}
              </button>
              <button
                type="button"
                aria-label={`Remove ${label} from saved`}
                onClick={e => { e.stopPropagation(); removeSavedVehicle(v) }}
                className="pr-2 pl-0.5 py-1 rounded-full hover:opacity-60"
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <p className="mt-1 text-xs text-gray-400">Tap to fill the fields below.</p>
    </div>
  )

  // Rendered near the BOTTOM of each second-vehicle sub-form. On submit, each
  // page reads data.saveSecondVehicle and fires-and-forgets a createSecondVehicle.
  const saveVehicleToggle = (
    <div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" {...register('saveSecondVehicle')} />
        Save this vehicle to reuse
      </label>
      <p className="mt-1 text-xs text-gray-400">Keeps it in your list so the next rig can pick it.</p>
    </div>
  )

  // Keep towingChoice in sync with the derived direction (moved here so all
  // three host pages share one implementation). tow_vehicle has no radio — the
  // second vehicle is always the truck; 'none' forces NONE so a prior toad
  // choice can't leak through when vehicleType changes. 'toad' leaves the
  // user's (or hydrated) radio choice intact.
  useEffect(() => {
    if (isTowVehicleDirection) setTowingChoice('VEHICLE')
    else if (direction === 'none') setTowingChoice('NONE')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction, isTowVehicleDirection])

  // Live year/make/model for the GVWR "look it up online" fallback link.
  const [ymYear, ymMake, ymModel] = useWatch({ control, name: ['year', 'make', 'model'] }) as [
    unknown,
    unknown,
    unknown,
  ]
  const gvwrSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(
    `${ymYear ?? ''} ${ymMake ?? ''} ${ymModel ?? ''} GVWR RV`.trim(),
  )}`

  return (
    <>
      {isFull && (
        <div>
          <label className="label">Vehicle type</label>
          <select className="input" {...register('vehicleType', { required: true })}>
            {Object.entries(VEHICLE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label">Year</label>
          <Controller
            control={control}
            name="year"
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
          <p className="mt-1 text-xs text-gray-400">Checked against every campsite for fit.</p>
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
          <p className="mt-1 text-xs text-gray-400">Warns you off low bridges and tunnels.</p>
        </div>
      </div>

      {/* Weight — GVWR in POUNDS (US units, matching Length/Height in feet).
          Feeds vehicle[grossWeight] in HERE truck routing for weight-restricted
          bridge/road avoidance — the one field our safety alerts can't work
          without, hence the reason line + "where do I find this?" helper. */}
      <div>
        <label className="label">Weight – GVWR (lbs)</label>
        <Controller
          control={control}
          name="gvwr"
          render={({ field }) => (
            <RangeSelect options={GVWR_OPTIONS} integer placeholder="Select GVWR" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
          )}
        />
        <p className="mt-1 text-xs text-gray-400">
          Lets us warn you about weight-limited roads and bridges — the one field our safety alerts can't work without.
        </p>
        <details className="mt-1">
          <summary className="text-xs cursor-pointer" style={{ color: TEAL }}>
            Where do I find this?
          </summary>
          <div className="mt-1 space-y-1 text-xs text-gray-500">
            <p>
              Your weight sticker — a label inside a cabinet door, the entry door frame, or on the driver's side. Look for "GVWR."
            </p>
            <p>Your owner's manual — listed in the specs. Both are exact for your rig.</p>
            <p>
              <a
                href={gvwrSearchUrl}
                target="_blank"
                rel="noopener"
                className="hover:underline"
                style={{ color: TEAL }}
              >
                Can't find it? Look up your model online
              </a>
            </p>
            <p>
              Weight varies by year and floorplan, so treat an online number as a starting point and confirm against your sticker when you can.
            </p>
          </div>
        </details>
      </div>

      {/* ── Fuel / MPG section — direction-aware (Pass 2 of towing-aware fuel
          estimate). TRAILERS get ONE MPG bound to mpgTowing (the rig has no
          engine; the tow vehicle's mileage is what matters) + tank; the rig's
          own fuelType is omitted because pricing uses towedFuelType from the
          tow-vehicle section below. MOTORHOMES / VANS / CAR CAMPING get fuel
          type + solo MPG + tank; the second "towing a toad" MPG is full-only. */}
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
              <p className="mt-1 text-xs text-gray-400">Powers your trip fuel-cost estimate.</p>
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
              <p className="mt-1 text-xs text-gray-400">Estimates how far you can go between fill-ups.</p>
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
              <p className="mt-1 text-xs text-gray-400">Powers your trip fuel-cost estimate.</p>
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
              <p className="mt-1 text-xs text-gray-400">Estimates how far you can go between fill-ups.</p>
            </div>
          </div>
          {isFull && (
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
          )}
        </>
      )}

      {isFull && (
        <div>
          <label className="label">Electrical amps</label>
          <select className="input" {...register('electricalAmps')}>
            <option value="">None</option>
            <option value="30">30 amp</option>
            <option value="50">50 amp</option>
          </select>
        </div>
      )}

      {isFull && isToyHauler && (
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

      {/* ── Second-vehicle section ───────────────────────────────────────────
          toad        : optional radio (None/Vehicle/Trailer) + conditional
                        sub-form. No fuel type / height (toad's unhooked at camp).
          tow_vehicle : required. Always-on sub-form with truck details; height +
                        fuel type are full-only. No radio (always a vehicle).
          none        : hidden entirely (vans, car camping). */}
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
              {savedVehiclePicker}
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
                        render={({ field }) => (
                          <RangeSelect options={YEARS} integer placeholder="Select year" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                        )}
                      />
                    </div>
                    <div>
                      <label className="label">Make</label>
                      <input className="input" placeholder="Jeep" {...register('towedMake')} />
                    </div>
                    <div>
                      <label className="label">Model</label>
                      <input className="input" placeholder="Wrangler" {...register('towedModel')} />
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
                        placeholder="XYZ-5678"
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
                      placeholder="XYZ-5678"
                      {...register('towedLicensePlate')}
                    />
                  </div>
                </div>
              )}
              {saveVehicleToggle}
            </div>
          )}
        </>
      )}

      {showSecondVehicleSection && isTowVehicleDirection && (
        <div className="rounded-xl bg-gray-50 p-4 space-y-3">
          {savedVehiclePicker}
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-gray-700">
              Vehicle that tows your {VEHICLE_LABELS[vehicleType as VehicleType]}
            </p>
            <span className="badge-active text-xs">Required to tow</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Year</label>
              <Controller
                control={control}
                name="towedYear"
                render={({ field }) => (
                  <RangeSelect options={YEARS} integer placeholder="Select year" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                )}
              />
            </div>
            <div>
              <label className="label">Make</label>
              <input className="input" placeholder="Ford" {...register('towedMake')} />
            </div>
            <div>
              <label className="label">Model</label>
              <input className="input" placeholder="F-250" {...register('towedModel')} />
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
            {isFull ? (
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
            ) : (
              <div>
                <label className="label">License plate</label>
                <input
                  className="input"
                  style={{ textTransform: 'uppercase' }}
                  placeholder="ABC-1234"
                  {...register('towedLicensePlate')}
                />
              </div>
            )}
          </div>
          {isFull && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">License plate</label>
                <input
                  className="input"
                  style={{ textTransform: 'uppercase' }}
                  placeholder="ABC-1234"
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
          )}
          {saveVehicleToggle}
        </div>
      )}
    </>
  )
}
