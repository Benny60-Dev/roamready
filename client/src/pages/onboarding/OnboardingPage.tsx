import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'
import { useForm, Controller } from 'react-hook-form'
import { usersApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { VehicleType, TowedType } from '../../types'
import RangeSelect from '../../components/forms/RangeSelect'
import { YEARS, LENGTHS, HEIGHTS, MPG_OPTIONS, TANK_OPTIONS } from '../../constants/rigOptions'

// Local UI shape — 'NONE' is the implicit default; serialized into
// isTowing / towedType when the rig payload is built.
type TowingChoice = 'NONE' | 'VEHICLE' | 'TRAILER'

const VEHICLE_OPTIONS: { type: VehicleType; emoji: string; label: string; sub: string }[] = [
  { type: 'RV_CLASS_A', emoji: '🚌', label: 'Class A Motorhome', sub: 'Large motorhome, 30-45ft' },
  { type: 'RV_CLASS_B', emoji: '🚐', label: 'Class B / Camper Van', sub: 'Van-based motorhome' },
  { type: 'RV_CLASS_C', emoji: '🚌', label: 'Class C Motorhome', sub: 'Cab-over motorhome' },
  { type: 'FIFTH_WHEEL', emoji: '🏠', label: 'Fifth Wheel', sub: 'Towed fifth wheel trailer' },
  { type: 'TRAVEL_TRAILER', emoji: '🏕️', label: 'Travel Trailer', sub: 'Bumper-pull trailer' },
  { type: 'TOY_HAULER', emoji: '🏍️', label: 'Toy Hauler', sub: 'Garage for ATVs, bikes, etc.' },
  { type: 'POP_UP', emoji: '⛺', label: 'Pop-Up Camper', sub: 'Folding pop-up trailer' },
  { type: 'VAN', emoji: '🚐', label: 'Converted Van', sub: 'Van life, Sprinter, etc.' },
  { type: 'CAR_CAMPING', emoji: '🚗', label: 'Car Camping', sub: 'Tent, overlanding, or car roof top' },
]

type Step = 'vehicle' | 'rig' | 'style' | 'done'

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>('vehicle')
  const [vehicleType, setVehicleType] = useState<VehicleType | null>(null)
  const [towingChoice, setTowingChoice] = useState<TowingChoice>('NONE')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  useAuthStore()

  const rigForm = useForm()
  const styleForm = useForm({
    defaultValues: {
      adults: 1,
      children: 0,
      hasPets: false,
      hookupPreference: 'BOTH',
      maxDriveHours: 6,
    }
  })

  const steps: Step[] = ['vehicle', 'rig', 'style', 'done']
  const stepIndex = steps.indexOf(step)

  async function handleRigSubmit(data: any) {
    if (!vehicleType) return
    setLoading(true)
    try {
      // Translate the towingChoice radio into the structured backend fields.
      // TRAILER drops year/make/model since the form doesn't collect them; we
      // null them out explicitly so a stale value can never sneak through.
      const isTowing = towingChoice !== 'NONE'
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
      await usersApi.createRig({
        ...data,
        vehicleType,
        isDefault: true,
        isTowing,
        ...towedFields,
      })
      setStep('style')
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  async function handleStyleSubmit(data: any) {
    setLoading(true)
    try {
      await usersApi.updateTravelProfile(data)
      setStep('done')
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  function skipRig() {
    setStep('style')
  }

  return (
    <div className="min-h-screen bg-rr-bg flex items-center justify-center p-4">
      <div className="w-full max-w-xl">
        {/* Progress */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {['Vehicle', 'Rig', 'Style', 'Done'].map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-medium ${
                i < stepIndex ? 'bg-[#1F6F8B] text-white' :
                i === stepIndex ? 'bg-[#1F6F8B] text-white' :
                'bg-gray-200 text-gray-500'
              }`}>
                {i < stepIndex ? <Check size={13} /> : i + 1}
              </div>
              <span className="text-xs text-gray-500 hidden sm:block">{label}</span>
              {i < 3 && <div className="w-8 h-px bg-gray-200" />}
            </div>
          ))}
        </div>

        {/* Step: Vehicle */}
        {step === 'vehicle' && (
          <div>
            <div className="text-center mb-6">
              <h1 className="text-2xl font-medium text-gray-900 mb-1">What do you travel in?</h1>
              <p className="text-sm text-gray-500">This helps us personalize your experience.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {VEHICLE_OPTIONS.map(v => (
                <button
                  key={v.type}
                  onClick={() => {
                    setVehicleType(v.type)
                    setStep('rig')
                  }}
                  className={`flex items-center gap-3 p-3 rounded-xl border text-left hover:border-[#1F6F8B] transition-colors ${
                    vehicleType === v.type ? 'border-[#1F6F8B] bg-[#E0F0F4]' : 'border-gray-200 bg-white'
                  }`}
                  style={{ borderWidth: '0.5px' }}
                >
                  <span className="text-2xl">{v.emoji}</span>
                  <div>
                    <div className="text-sm font-medium text-gray-900">{v.label}</div>
                    <div className="text-xs text-gray-500">{v.sub}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step: Rig */}
        {step === 'rig' && (
          <div className="card-lg">
            <h2 className="text-xl font-medium text-gray-900 mb-1">Tell us about your rig</h2>
            <p className="text-sm text-gray-500 mb-6">Used for campground compatibility filtering.</p>
            <form onSubmit={rigForm.handleSubmit(handleRigSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Year</label>
                  <Controller
                    control={rigForm.control}
                    name="year"
                    render={({ field }) => (
                      <RangeSelect options={YEARS} integer placeholder="Select year" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                    )}
                  />
                </div>
                <div>
                  <label className="label">Make</label>
                  <input className="input" placeholder="Winnebago" {...rigForm.register('make')} />
                </div>
              </div>
              <div>
                <label className="label">Model</label>
                <input className="input" placeholder="Journey 40R" {...rigForm.register('model')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Length (ft)</label>
                  <Controller
                    control={rigForm.control}
                    name="length"
                    render={({ field }) => (
                      <RangeSelect options={LENGTHS} placeholder="Select length" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                    )}
                  />
                </div>
                <div>
                  <label className="label">Height (ft)</label>
                  <Controller
                    control={rigForm.control}
                    name="height"
                    render={({ field }) => (
                      <RangeSelect options={HEIGHTS} placeholder="Select height" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                    )}
                  />
                </div>
              </div>
              {vehicleType !== 'CAR_CAMPING' && vehicleType !== 'VAN' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">MPG</label>
                    <Controller
                      control={rigForm.control}
                      name="mpg"
                      render={({ field }) => (
                        <RangeSelect options={MPG_OPTIONS} placeholder="Select MPG" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                      )}
                    />
                  </div>
                  <div>
                    <label className="label">Tank (gal)</label>
                    <Controller
                      control={rigForm.control}
                      name="tankSize"
                      render={({ field }) => (
                        <RangeSelect options={TANK_OPTIONS} placeholder="Select tank size" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                      )}
                    />
                  </div>
                </div>
              )}

              {/* License plate */}
              <div>
                <label className="label">License plate</label>
                <input
                  className="input uppercase"
                  style={{ textTransform: 'uppercase' }}
                  placeholder="ABC-1234"
                  {...rigForm.register('licensePlate')}
                />
                <p className="mt-1 text-xs text-gray-400">Most campgrounds ask for this at check-in.</p>
              </div>

              {/* Towing question — gated to motorhomes. Travel trailers / fifth
                  wheels ARE the thing being towed; asking is nonsense for them. */}
              {(vehicleType === 'RV_CLASS_A' || vehicleType === 'RV_CLASS_B' || vehicleType === 'RV_CLASS_C') && (
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
                              <Controller
                                control={rigForm.control}
                                name="towedYear"
                                render={({ field }) => (
                                  <RangeSelect options={YEARS} integer placeholder="Select year" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                                )}
                              />
                            </div>
                            <div>
                              <label className="label">Make</label>
                              <input className="input" placeholder="Jeep" {...rigForm.register('towedMake')} />
                            </div>
                            <div>
                              <label className="label">Model</label>
                              <input className="input" placeholder="Wrangler" {...rigForm.register('towedModel')} />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="label">Length (ft)</label>
                              <Controller
                                control={rigForm.control}
                                name="towedLength"
                                render={({ field }) => (
                                  <RangeSelect options={LENGTHS} placeholder="Select length" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                                )}
                              />
                            </div>
                            <div>
                              <label className="label">License plate</label>
                              <input
                                className="input uppercase"
                                style={{ textTransform: 'uppercase' }}
                                placeholder="XYZ-5678"
                                {...rigForm.register('towedLicensePlate')}
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
                              control={rigForm.control}
                              name="towedLength"
                              render={({ field }) => (
                                <RangeSelect options={LENGTHS} placeholder="Select length" value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                              )}
                            />
                          </div>
                          <div>
                            <label className="label">License plate</label>
                            <input
                              className="input uppercase"
                              style={{ textTransform: 'uppercase' }}
                              placeholder="XYZ-5678"
                              {...rigForm.register('towedLicensePlate')}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              <div className="flex gap-2 pt-2">
                <button type="button" onClick={skipRig} className="btn-ghost flex-1">Skip for now</button>
                <button type="submit" disabled={loading} className="btn-primary flex-1">
                  {loading ? 'Saving...' : 'Continue'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Step: Style */}
        {step === 'style' && (
          <div className="card-lg">
            <h2 className="text-xl font-medium text-gray-900 mb-1">How do you travel?</h2>
            <p className="text-sm text-gray-500 mb-6">Helps the AI planner customize your itineraries.</p>
            <form onSubmit={styleForm.handleSubmit(handleStyleSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Adults</label>
                  <input type="number" min="1" className="input" {...styleForm.register('adults', { valueAsNumber: true })} />
                </div>
                <div>
                  <label className="label">Children</label>
                  <input type="number" min="0" className="input" {...styleForm.register('children', { valueAsNumber: true })} />
                </div>
              </div>
              <div>
                <label className="label">Hookup preference</label>
                <select className="input" {...styleForm.register('hookupPreference')}>
                  <option value="FULL_HOOKUP">Full hookup preferred</option>
                  <option value="ELECTRIC">Electric only OK</option>
                  <option value="BOTH">Mix of hookup & dry camping</option>
                  <option value="DRY_CAMPING">Dry camping / boondocking</option>
                </select>
              </div>
              <div>
                <label className="label">Max drive hours per day</label>
                <select className="input" {...styleForm.register('maxDriveHours', { valueAsNumber: true })}>
                  <option value="4">4 hours</option>
                  <option value="5">5 hours</option>
                  <option value="6">6 hours</option>
                  <option value="8">8 hours</option>
                </select>
              </div>
              <div>
                <label className="label">Nightly campsite budget ($)</label>
                <input type="number" className="input" placeholder="50" {...styleForm.register('nightlyBudget' as any, { valueAsNumber: true })} />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="hasPets" {...styleForm.register('hasPets')} className="rounded" />
                <label htmlFor="hasPets" className="text-sm text-gray-700">Traveling with pets</label>
              </div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => setStep('rig')} className="btn-ghost flex-1">Back</button>
                <button type="submit" disabled={loading} className="btn-primary flex-1">
                  {loading ? 'Saving...' : 'Finish setup'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Step: Done */}
        {step === 'done' && (
          <div className="card-lg text-center">
            <div className="text-5xl mb-4">🎉</div>
            <h2 className="text-2xl font-medium text-gray-900 mb-2">You're all set!</h2>
            <p className="text-gray-500 mb-6">
              Your 7-day Pro trial is active. Start planning your first trip with the AI planner.
            </p>
            <div className="flex flex-col gap-2">
              <button onClick={() => navigate('/sessions/new')} className="btn-primary py-3">
                Plan my first trip
              </button>
              <button onClick={() => navigate('/dashboard')} className="btn-ghost">
                Go to dashboard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
