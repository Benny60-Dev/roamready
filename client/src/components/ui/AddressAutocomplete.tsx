import { useRef, useState } from 'react'
import { Autocomplete, useJsApiLoader } from '@react-google-maps/api'

/**
 * The 8 structured home-address fields, exactly as the server's updateMe
 * accepts them and as User stores them. A selected Google place is parsed into
 * this shape and handed back to the caller, which decides what to do with it
 * (persist, stash in local state, drop into a form, etc.).
 */
export interface HomeAddress {
  homeLocation: string
  homeAddress: string
  homeStreet: string
  homeCity: string
  homeState: string
  homeZip: string
  homeLat?: number
  homeLng?: number
}

// Must match the libraries array used by every other useJsApiLoader caller
// (ProfilePage, TripMapPage) so the hook's internal singleton dedupes to a
// SINGLE script load instead of warning about conflicting loader options.
const LIBRARIES: Parameters<typeof useJsApiLoader>[0]['libraries'] = ['marker', 'geometry', 'places']

interface Props {
  /** Seed text for the input (e.g. a trip's start city). Uncontrolled — the
   *  component owns the text after mount so free-typing for the Places search
   *  works without the parent re-rendering it. */
  defaultValue?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  /** Fires when the user SELECTS a place from the dropdown, with all 8 fields. */
  onPlace: (address: HomeAddress) => void
  /** Optional: free-text typing changes (before a selection is made). */
  onInputChange?: (text: string) => void
}

/**
 * Shared Google Places address capture. Owns the Maps JS API loader, the
 * <Autocomplete> wrapper, and the address_components → 8-field parse. It makes
 * NO assumptions about react-hook-form: callers receive the parsed object via
 * onPlace and adapt it however they like. (PROF-1 lesson: the inner <input>
 * stays a plain controlled element so Autocomplete keeps the ref it needs —
 * nothing steals it.)
 */
export default function AddressAutocomplete({
  defaultValue = '',
  placeholder = 'Start typing your address…',
  disabled = false,
  className = 'input',
  onPlace,
  onInputChange,
}: Props) {
  const [text, setText] = useState(defaultValue)
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
    libraries: LIBRARIES,
  })

  function onPlaceChanged() {
    const place = autocompleteRef.current?.getPlace()
    if (!place?.address_components) return

    let streetNum = '', route = '', city = '', state = '', zip = ''
    for (const comp of place.address_components) {
      if (comp.types.includes('street_number'))               streetNum = comp.long_name
      if (comp.types.includes('route'))                       route     = comp.long_name
      if (comp.types.includes('locality'))                    city      = comp.long_name
      if (comp.types.includes('administrative_area_level_1')) state     = comp.short_name
      if (comp.types.includes('postal_code'))                 zip       = comp.long_name
    }

    const street = streetNum ? `${streetNum} ${route}`.trim() : route
    const full   = place.formatted_address || ''

    setText(full)
    onPlace({
      homeLocation: full,
      homeAddress:  full,
      homeStreet:   street,
      homeCity:     city,
      homeState:    state,
      homeZip:      zip,
      homeLat:      place.geometry?.location?.lat(),
      homeLng:      place.geometry?.location?.lng(),
    })
  }

  if (!isLoaded) {
    return <input className={className} placeholder="Loading…" disabled />
  }

  return (
    <Autocomplete
      onLoad={ac => { autocompleteRef.current = ac }}
      onPlaceChanged={onPlaceChanged}
      options={{ types: ['address'], componentRestrictions: { country: 'us' } }}
    >
      <input
        className={className}
        placeholder={placeholder}
        disabled={disabled}
        value={text}
        onChange={e => { setText(e.target.value); onInputChange?.(e.target.value) }}
      />
    </Autocomplete>
  )
}
