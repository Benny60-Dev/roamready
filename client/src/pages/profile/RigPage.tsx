import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'
import { Plus, Trash2, Star, Pencil, BadgeInfo, Car, Truck, AlertCircle } from 'lucide-react'
import { usersApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { Rig, VehicleType } from '../../types'
import { deriveSecondVehicle, VEHICLE_LABELS, buildTowedFields, buildSecondVehiclePayload, type TowingChoice } from '../../utils/rigs'
import RigFormFields from '../../components/forms/RigFormFields'

// VEHICLE_LABELS now lives in utils/rigs (so utils can reuse it without a
// circular import). Re-exported here so existing `import { VEHICLE_LABELS }
// from './RigPage'` callers (EditRigPage, SessionPage, ConfirmVehiclesModal,
// RigInfoModal) keep resolving unchanged.
export { VEHICLE_LABELS }

function RigCard({ rig, onDelete, onSetDefault }: { rig: Rig; onDelete: (id: string) => void; onSetDefault: (id: string) => void }) {
  // The "towed unit" inline summary line (formatTowedLine) was removed Block 7
  // in favor of a sibling SecondVehicleCard rendered just below this one —
  // see SecondVehicleCard below + the rigs.map render path.
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
            // Icon + text label so the action is readable at a glance instead
            // of relying on the title tooltip. Stays ghost-styled (no fill,
            // gray text) to match the pencil/trash icon-buttons on either
            // side — gold/primary treatment is reserved for top-line CTAs.
            <button
              onClick={() => onSetDefault(rig.id)}
              title="Set as default"
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <Star size={14} />
              Set as default
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

// ── Second-vehicle card ─────────────────────────────────────────────────────
// Renders just below the rig card. Adapts to the rig's direction:
//   - 'toad'        : optional toad behind a motorhome. Blue/info combined-
//                     length strip ("Used for tunnel, pass, and ferry
//                     restrictions while towing").
//   - 'tow_vehicle' : required truck in front of a trailer/5th wheel. Shows
//                     fuel type. Amber/warning combined-length strip
//                     ("Checked against every campground site for fit").
//   - 'none'        : returns null (vans + car camping have no second vehicle).
// Combined-length value is DISPLAY ONLY — no code reads it for any fit /
// restriction check today; campgrounds.ts still uses rig.length alone. The
// strip is a UI promise that's deliberately ahead of the engine.
function SecondVehicleCard({ rig }: { rig: Rig }) {
  const { direction } = deriveSecondVehicle(rig.vehicleType)
  if (direction === 'none') return null

  const hasData =
    rig.isTowing &&
    !!(rig.towedYear || rig.towedMake || rig.towedModel || rig.towedLength || rig.towedLicensePlate)

  // ── Empty state ─────────────────────────────────────────────────────────
  if (!hasData) {
    if (direction === 'tow_vehicle') {
      // Stronger nudge — the trailer literally cannot move without a tow
      // vehicle, so the empty state nags more than the toad's quiet "+ Add".
      return (
        <div
          className="card border-dashed bg-amber-50/40"
          style={{ borderColor: '#FDE68A', borderWidth: '0.5px' }}
        >
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-900">A tow vehicle is recommended</p>
              <p className="text-xs text-amber-800 mt-0.5">
                Your {VEHICLE_LABELS[rig.vehicleType].toLowerCase()} can't move without one.
              </p>
            </div>
            <Link
              to={`/profile/rig/${rig.id}/edit`}
              className="text-xs font-medium text-[#1F6F8B] hover:underline whitespace-nowrap flex-shrink-0"
            >
              + Add tow vehicle
            </Link>
          </div>
        </div>
      )
    }
    // Toad direction — soft prompt, no alarm.
    return (
      <div className="card border-dashed" style={{ borderWidth: '0.5px' }}>
        <Link
          to={`/profile/rig/${rig.id}/edit`}
          className="flex items-center justify-center gap-2 text-sm text-gray-500 hover:text-[#1F6F8B] transition-colors py-1"
        >
          <Plus size={14} /> Add a towed vehicle
        </Link>
      </div>
    )
  }

  // ── Populated state ─────────────────────────────────────────────────────
  const isToad = direction === 'toad'
  const Icon = isToad ? Car : Truck
  const badgeText = isToad ? 'Toad' : 'Required to tow'
  const subLine = isToad
    ? `Towed behind the ${VEHICLE_LABELS[rig.vehicleType]}`
    : `Tows the ${VEHICLE_LABELS[rig.vehicleType]}`
  const towedName =
    [rig.towedYear, rig.towedMake, rig.towedModel].filter(Boolean).join(' ') ||
    (rig.towedType === 'TRAILER' ? 'Trailer' : 'Vehicle')

  // Combined length = rig + towed (hitch gap ignored). Display-only — see
  // comment above the function.
  const combinedLength = (rig.length || 0) + (rig.towedLength || 0)
  const hasCombined = combinedLength > 0

  return (
    <div className="card">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <Icon size={16} className="text-[#1F6F8B] flex-shrink-0" />
            <p className="font-medium text-gray-900">{towedName}</p>
            <span className="badge-active text-xs">{badgeText}</span>
          </div>
          <p className="text-xs text-gray-500">{subLine}</p>
          <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-gray-400">
            {rig.towedLength && <span>{rig.towedLength}ft</span>}
            {!isToad && rig.towedHeight && <span>{rig.towedHeight}ft tall</span>}
            {!isToad && rig.towedFuelType && <span>{rig.towedFuelType}</span>}
            {rig.towedLicensePlate && (
              <span className="inline-flex items-center gap-1">
                <BadgeInfo size={12} className="text-gray-400" />
                {rig.towedLicensePlate}
              </span>
            )}
          </div>
        </div>
        <Link
          to={`/profile/rig/${rig.id}/edit`}
          title="Edit second vehicle"
          className="p-1.5 rounded-lg hover:bg-gray-100 flex-shrink-0"
        >
          <Pencil size={14} className="text-gray-400" />
        </Link>
      </div>

      {/* Combined-length strip — DISPLAY ONLY. No code reads this for any
          fit/restriction check today; campgrounds.ts still uses rig.length
          alone. Direction-specific styling to telegraph the intended use:
            - Toad (blue/info): tunnel/pass/ferry — restrictions that only
              kick in while you're driving with the toad attached.
            - Tow-vehicle (amber/warning): campground-fit — the trailer is
              the rig itself, so combined length is what every site has to
              accommodate. */}
      {hasCombined && (
        <div
          className={`mt-3 px-3 py-2 rounded-md text-xs ${
            isToad
              ? 'bg-[#E0F0F4] text-[#134756]'
              : 'bg-amber-50 text-amber-800'
          }`}
        >
          <div className="font-medium">
            {isToad ? 'Combined driving length' : 'Combined length'}: {combinedLength}ft
          </div>
          <div className="opacity-80 mt-0.5">
            {isToad
              ? 'Used for tunnel, pass, and ferry restrictions while towing.'
              : 'Checked against every campground site for fit (may need pull-through).'}
          </div>
        </div>
      )}
    </div>
  )
}

export default function RigPage() {
  const [rigs, setRigs] = useState<Rig[]>([])
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [towingChoice, setTowingChoice] = useState<TowingChoice>('NONE')
  // Scroll the just-revealed "Add a rig" form into view (FR-RIG-ADD-SCROLL).
  const formRef = useRef<HTMLDivElement>(null)
  const { register, handleSubmit, reset, watch, setFocus, control, setValue } = useForm()
  const vehicleType = watch('vehicleType') as VehicleType | undefined
  // Direction is derived from vehicleType; RigFormFields owns the towingChoice
  // sync effect and second-vehicle UI, so the page only needs `direction` for
  // the save-time payload (buildTowedFields).
  const { direction } = deriveSecondVehicle(vehicleType)

  useEffect(() => {
    usersApi.getRigs().then(res => setRigs(res.data))
  }, [])

  // FR-RIG-ADD-SCROLL: when "Add a rig" reveals the inline form, scroll it into
  // view so the user sees it (on a long page / mobile it otherwise looks like
  // nothing happened) and land the cursor on the first field. Keyed on showForm
  // (not done in the click handler) so the form is mounted before we scroll.
  // rAF ensures layout is committed; focus runs after the smooth scroll settles
  // so element.focus() doesn't fight the animation. Honors reduced-motion.
  useEffect(() => {
    if (!showForm) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const raf = requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    })
    const focusTimer = setTimeout(() => setFocus('vehicleType'), reduce ? 0 : 400)
    return () => { cancelAnimationFrame(raf); clearTimeout(focusTimer) }
  }, [showForm, setFocus])

  async function onSubmit(data: any) {
    setSaving(true)
    try {
      // Direction-aware towed-field payload (shared with EditRigPage +
      // OnboardingPage — see utils/rigs.buildTowedFields).
      const { isTowing, towed } = buildTowedFields(data, direction, towingChoice)
      // RIGINFO-4: optionally save the second vehicle to the reusable library.
      // Fire-and-forget — never block or fail the rig save on the library write.
      const svPayload = buildSecondVehiclePayload(data, isTowing, towed)
      if (svPayload) usersApi.createSecondVehicle(svPayload).catch(() => { /* non-fatal */ })
      const res = await usersApi.createRig({
        ...data,
        isToyHauler: data.vehicleType === 'TOY_HAULER',
        isVan: data.vehicleType === 'VAN',
        isCamper: data.vehicleType === 'CAR_CAMPING',
        isDefault: rigs.length === 0,
        isTowing,
        ...towed,
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
    // Refresh the auth-store user (which holds the rigs the SessionPage
    // chip and other cross-page consumers read) so the chip updates
    // immediately. Without this the rig list updates locally but the
    // home chip stays on the old default until the next /users/me
    // round-trip — usually a page navigation. getState() lets us avoid
    // subscribing to the store from this component just for the
    // post-mutation refresh.
    useAuthStore.getState().rehydrateUser()
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium text-gray-900">My Rigs</h1>
        <button onClick={() => setShowForm(!showForm)} className="btn-primary flex items-center gap-1.5 text-sm">
          <Plus size={15} /> Add rig
        </button>
      </div>

      <div className="space-y-4">
        {rigs.map(rig => (
          <div key={rig.id} className="space-y-2">
            <RigCard rig={rig} onDelete={deleteRig} onSetDefault={setDefault} />
            <SecondVehicleCard rig={rig} />
          </div>
        ))}
        {rigs.length === 0 && !showForm && (
          <div className="card text-center py-10 text-sm text-gray-500">
            No rigs added yet. Add your first rig to enable compatibility filtering.
          </div>
        )}
        {rigs.length > 0 && (
          <p className="text-xs text-gray-400 italic pt-1">
            One rig + one towed/tow vehicle per profile.
          </p>
        )}
      </div>

      {showForm && (
        <div ref={formRef} className="card-lg scroll-mt-20">
          <h3 className="font-medium text-gray-900 mb-4">Add a rig</h3>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <RigFormFields
              variant="full"
              vehicleType={vehicleType}
              control={control}
              register={register}
              setValue={setValue}
              towingChoice={towingChoice}
              setTowingChoice={setTowingChoice}
            />

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
