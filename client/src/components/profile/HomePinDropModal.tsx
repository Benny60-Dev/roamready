import { useEffect, useRef, useState } from 'react'
import { GoogleMap, MarkerF, useJsApiLoader } from '@react-google-maps/api'
import { MapPin, X } from 'lucide-react'
import { usersApi } from '../../services/api'
import { useUIStore } from '../../store/uiStore'

/**
 * HOME-ADDRESS rung 2 — pin-drop fallback. Shown ONLY when rung-1's
 * geocode-on-save failed to resolve a typed address (the saved user came back
 * with address text but homeLat null). The user clicks/drags a marker to their
 * location; we reverse-geocode the coords to a display city and save
 * homeLat/homeLng/homeCity/homeState/homeLocation. Because homeLat is present,
 * rung-1's geocode-on-save short-circuits (no redundant geocode).
 *
 * Dismissing without placing a pin is intentional and safe: the user simply
 * stays in the no-home state, which the AI planner already handles (it asks for
 * the trip's starting location). This modal never hard-blocks.
 */

// Same libraries + key as ProfilePage / AddressAutocomplete so useJsApiLoader's
// singleton dedupes to ONE script load (mismatched options warn + double-load).
const LIBRARIES: Parameters<typeof useJsApiLoader>[0]['libraries'] = ['marker', 'geometry', 'places']

// Geographic center of the contiguous US — the default view when we have no
// hint for where the user is.
const US_CENTER = { lat: 39.5, lng: -98.35 }
const US_ZOOM = 4

const MAP_CONTAINER_STYLE = { width: '100%', height: '320px' }

interface Props {
  open: boolean
  onClose: () => void
  /** The address text the user typed, used for best-effort initial centering. */
  addressText?: string | null
  /** Called with the updated user object after a successful save. */
  onSaved: (updatedUser: any) => void
}

export default function HomePinDropModal({ open, onClose, addressText, onSaved }: Props) {
  const openFeedbackModal = useUIStore(s => s.openFeedbackModal)
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
    libraries: LIBRARIES,
  })

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [resolved, setResolved] = useState<{ city: string | null; state: string | null } | null>(null)
  const [center, setCenter] = useState(US_CENTER)
  const [zoom, setZoom] = useState(US_ZOOM)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)

  // Reset transient state each time the modal opens.
  useEffect(() => {
    if (!open) return
    setCoords(null)
    setResolved(null)
    setSaveError(null)
    setCenter(US_CENTER)
    setZoom(US_ZOOM)
  }, [open])

  // Best-effort initial centering: forward-geocode whatever text the user typed.
  // Failure (the very reason we're here) just leaves the US-wide default.
  useEffect(() => {
    if (!open || !isLoaded || !addressText?.trim()) return
    if (!window.google?.maps?.Geocoder) return
    try {
      const geocoder = new window.google.maps.Geocoder()
      geocoder.geocode({ address: addressText }, (results, status) => {
        if (status !== 'OK' || !results?.[0]) return
        const loc = results[0].geometry?.location
        if (!loc) return
        setCenter({ lat: loc.lat(), lng: loc.lng() })
        setZoom(8)
      })
    } catch { /* keep default center */ }
  }, [open, isLoaded, addressText])

  // Escape closes (unless mid-save). Mirrors ConfirmModal's keydown handling.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, saving, onClose])

  function placePin(lat: number, lng: number) {
    setCoords({ lat, lng })
    setResolved(null)
    // Reverse-geocode coords → city/state (best-effort). On failure we still let
    // the user save the raw coordinates (see handleSave).
    if (!window.google?.maps?.Geocoder) return
    try {
      const geocoder = new window.google.maps.Geocoder()
      geocoder.geocode({ location: { lat, lng } }, (results, status) => {
        try {
          if (status !== 'OK' || !results?.length) { setResolved({ city: null, state: null }); return }
          let city: string | null = null
          let state: string | null = null
          for (const r of results) {
            const comps = r.address_components ?? []
            const find = (t: string, short = false) =>
              comps.find(c => c.types.includes(t))?.[short ? 'short_name' : 'long_name'] ?? null
            city = city || find('locality') || find('postal_town') || find('administrative_area_level_3')
            state = state || find('administrative_area_level_1', true)
            if (city && state) break
          }
          setResolved({ city, state })
        } catch { setResolved({ city: null, state: null }) }
      })
    } catch { setResolved({ city: null, state: null }) }
  }

  async function handleSave() {
    if (!coords) return
    setSaving(true)
    setSaveError(null)
    const city = resolved?.city ?? null
    const state = resolved?.state ?? null
    // homeLocation must be non-empty so hasHomeOnFile (homeCity || homeLocation)
    // passes even when reverse-geocode found no city.
    const homeLocation = city ? (state ? `${city}, ${state}` : city) : 'Custom location'
    try {
      const res = await usersApi.updateMe({
        homeLat: coords.lat,
        homeLng: coords.lng,
        homeCity: city,
        homeState: state,
        homeLocation,
      })
      onSaved(res.data)
      onClose()
    } catch {
      setSaveError("Couldn't save your location. Please try again.")
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const resolvedLabel = resolved
    ? (resolved.city ? `${resolved.city}${resolved.state ? `, ${resolved.state}` : ''}` : 'Location set (no city name found)')
    : null

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={() => { if (!saving) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-lg border border-gray-200 w-full max-w-[520px] p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="font-semibold text-lg text-gray-900">Pin your home location</h2>
          <button onClick={() => { if (!saving) onClose() }} aria-label="Close" className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-gray-600 mb-4 leading-relaxed">
          We couldn't look up that address automatically. Click the map to drop a pin on your
          home location (drag to fine-tune), then save.
        </p>

        <div className="rounded-lg overflow-hidden border border-gray-200">
          {isLoaded ? (
            <GoogleMap
              mapContainerStyle={MAP_CONTAINER_STYLE}
              center={center}
              zoom={zoom}
              onLoad={m => { mapRef.current = m }}
              onClick={e => { if (e.latLng) placePin(e.latLng.lat(), e.latLng.lng()) }}
              options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false }}
            >
              {coords && (
                <MarkerF
                  position={coords}
                  draggable
                  onDragEnd={e => { if (e.latLng) placePin(e.latLng.lat(), e.latLng.lng()) }}
                />
              )}
            </GoogleMap>
          ) : (
            <div style={MAP_CONTAINER_STYLE} className="flex items-center justify-center bg-gray-50 text-sm text-gray-400">
              Loading map…
            </div>
          )}
        </div>

        {resolvedLabel && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-[#1F6F8B]">
            <MapPin size={13} /> {resolvedLabel}
          </p>
        )}
        {saveError && <p className="mt-2 text-sm text-red-600">{saveError}</p>}

        <div className="flex items-center justify-between gap-2 mt-5">
          <button
            type="button"
            onClick={() => openFeedbackModal()}
            className="text-xs text-[#1F6F8B] hover:text-[#134756] underline underline-offset-2"
          >
            Couldn't find your address? Report this to us
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => { if (!saving) onClose() }}
              disabled={saving}
              className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!coords || saving}
              className="bg-[#3E5540] text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-[#2F4030] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Save home location'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
