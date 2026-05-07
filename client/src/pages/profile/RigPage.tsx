import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'
import { Plus, Trash2, Star, Pencil, BadgeInfo } from 'lucide-react'
import { usersApi } from '../../services/api'
import { Rig, VehicleType, TowedType } from '../../types'

export const VEHICLE_LABELS: Record<VehicleType, string> = {
  RV_CLASS_A: 'Class A Motorhome',
  RV_CLASS_B: 'Class B / Camper Van',
  RV_CLASS_C: 'Class C Motorhome',
  FIFTH_WHEEL: 'Fifth Wheel',
  TRAVEL_TRAILER: 'Travel Trailer',
  TOY_HAULER: 'Toy Hauler',
  POP_UP: 'Pop-Up Camper',
  VAN: 'Converted Van',
  CAR_CAMPING: 'Car Camping',
}

// Compact one-line summary of the towed unit. Used in the rig card; the modal
// on the booking page renders the same data with more chrome. Returns null when
// there's nothing to show so callers can short-circuit cleanly.
function formatTowedLine(rig: Rig): { icon: string; text: string } | null {
  if (!rig.isTowing || !rig.towedType) return null
  const parts: string[] = []
  if (rig.towedType === 'VEHICLE') {
    const name = [rig.towedYear, rig.towedMake, rig.towedModel].filter(Boolean).join(' ')
    if (name) parts.push(name)
    if (rig.towedLength) parts.push(`${rig.towedLength}ft`)
    if (rig.towedLicensePlate) parts.push(rig.towedLicensePlate)
    return parts.length ? { icon: '🚗', text: `Towing ${parts.join(' · ')}` } : null
  } else {
    if (rig.towedLength) parts.push(`${rig.towedLength}ft trailer`)
    else parts.push('trailer')
    if (rig.towedLicensePlate) parts.push(rig.towedLicensePlate)
    return { icon: '🚚', text: `Towing ${parts.join(' · ')}` }
  }
}

function RigCard({ rig, onDelete, onSetDefault }: { rig: Rig; onDelete: (id: string) => void; onSetDefault: (id: string) => void }) {
  const towedLine = formatTowedLine(rig)
  return (
    <div className={`card ${rig.isDefault ? 'border-[#1F6F8B]/40 bg-[#E0F0F4]/30' : ''}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <p className="font-medium text-gray-900">
              {rig.year} {rig.make} {rig.model}
            </p>
            {rig.isDefault && <span className="badge-green text-xs">Default</span>}
          </div>
          <p className="text-xs text-gray-500">{VEHICLE_LABELS[rig.vehicleType]}</p>
          <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-gray-400">
            {rig.length && <span>{rig.length}ft</span>}
            {rig.height && <span>{rig.height}ft tall</span>}
            {rig.mpg && <span>{rig.mpg} mpg</span>}
            {rig.tankSize && <span>{rig.tankSize}gal tank</span>}
            {rig.electricalAmps && <span>{rig.electricalAmps}A</span>}
            {rig.fuelType && <span>{rig.fuelType}</span>}
            {rig.licensePlate && (
              <span className="inline-flex items-center gap-1">
                <BadgeInfo size={12} className="text-gray-400" />
                {rig.licensePlate}
              </span>
            )}
          </div>
          {rig.isToyHauler && rig.toys && (
            <div className="mt-1 text-xs text-[#1F6F8B]">🏍️ {(rig.toys as string[]).join(', ')}</div>
          )}
          {towedLine && (
            <div className="mt-1 text-xs text-[#1F6F8B]">{towedLine.icon} {towedLine.text}</div>
          )}
        </div>
        <div className="flex items-center gap-1 ml-2">
          <Link
            to={`/profile/rig/${rig.id}/edit`}
            title="Edit rig"
            className="p-1.5 rounded-lg hover:bg-gray-100"
          >
            <Pencil size={14} className="text-gray-400" />
          </Link>
          {!rig.isDefault && (
            <button onClick={() => onSetDefault(rig.id)} title="Set as default" className="p-1.5 rounded-lg hover:bg-gray-100">
              <Star size={14} className="text-gray-400" />
            </button>
          )}
          <button onClick={() => onDelete(rig.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

type TowingChoice = 'NONE' | 'VEHICLE' | 'TRAILER'

export default function RigPage() {
  const [rigs, setRigs] = useState<Rig[]>([])
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [towingChoice, setTowingChoice] = useState<TowingChoice>('NONE')
  const { register, handleSubmit, reset, watch } = useForm()
  const vehicleType = watch('vehicleType')
  const isToyHauler = vehicleType === 'TOY_HAULER'
  // Towing question only applies to motorhomes — travel trailers / fifth wheels
  // ARE the thing being towed, so the question is nonsense for them.
  const towingApplies = vehicleType === 'RV_CLASS_A' || vehicleType === 'RV_CLASS_B' || vehicleType === 'RV_CLASS_C'

  useEffect(() => {
    usersApi.getRigs().then(res => setRigs(res.data))
  }, [])

  async function onSubmit(data: any) {
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
      const res = await usersApi.createRig({
        ...data,
        isToyHauler: data.vehicleType === 'TOY_HAULER',
        isVan: data.vehicleType === 'VAN',
        isCamper: data.vehicleType === 'CAR_CAMPING',
        isDefault: rigs.length === 0,
        isTowing,
        ...towedFields,
      })
      setRigs([...rigs, res.data])
      setShowForm(false)
      setTowingChoice('NONE')
      reset()
    } finally {
      setSaving(false)
    }
  }

  async function deleteRig(id: string) {
    if (!confirm('Delete this rig?')) return
    await usersApi.deleteRig(id)
    setRigs(rigs.filter(r => r.id !== id))
  }

  async function setDefault(id: string) {
    await usersApi.updateRig(id, { isDefault: true })
    const res = await usersApi.getRigs()
    setRigs(res.data)
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium text-gray-900">My Rigs</h1>
        <button onClick={() => setShowForm(!showForm)} className="btn-primary flex items-center gap-1.5 text-sm">
          <Plus size={15} /> Add rig
        </button>
      </div>

      <div className="space-y-2">
        {rigs.map(rig => (
          <RigCard key={rig.id} rig={rig} onDelete={deleteRig} onSetDefault={setDefault} />
        ))}
        {rigs.length === 0 && !showForm && (
          <div className="card text-center py-10 text-sm text-gray-500">
            No rigs added yet. Add your first rig to enable compatibility filtering.
          </div>
        )}
      </div>

      {showForm && (
        <div className="card-lg">
          <h3 className="font-medium text-gray-900 mb-4">Add a rig</h3>
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
                <input type="number" step="0.5" className="input" {...register('length', { valueAsNumber: true })} />
              </div>
              <div>
                <label className="label">Height (ft)</label>
                <input type="number" step="0.5" className="input" {...register('height', { valueAsNumber: true })} />
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
                <input type="number" step="0.5" className="input" {...register('mpg', { valueAsNumber: true })} />
              </div>
              <div>
                <label className="label">Tank (gal)</label>
                <input type="number" className="input" {...register('tankSize', { valueAsNumber: true })} />
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
                  <input type="number" step="0.5" className="input" {...register('garageLength', { valueAsNumber: true })} />
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
                            <input type="number" className="input" placeholder="2019" {...register('towedYear', { valueAsNumber: true })} />
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
                            <input type="number" step="0.5" className="input" placeholder="14" {...register('towedLength', { valueAsNumber: true })} />
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
                          <input type="number" step="0.5" className="input" placeholder="14" {...register('towedLength', { valueAsNumber: true })} />
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
                  </div>
                )}
              </>
            )}

            <div className="flex gap-2">
              <button type="button" onClick={() => { setShowForm(false); reset(); setTowingChoice('NONE') }} className="btn-ghost flex-1">Cancel</button>
              <button type="submit" disabled={saving} className="btn-primary flex-1">
                {saving ? 'Adding...' : 'Add rig'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
