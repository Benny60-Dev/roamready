import { useMemo } from 'react'

export interface RangeSelectProps {
  /** Numeric option list (ascending or descending; e.g. YEARS is descending). */
  options: number[]
  /** Current value. number when set, undefined/null when empty. */
  value: number | null | undefined
  /** Emits a real number on select, or undefined when "Select…" is chosen.
   *  NEVER emits 0, NaN, or a string — so empty saves as null, not 0. */
  onChange: (value: number | undefined) => void
  onBlur?: () => void
  name?: string
  id?: string
  placeholder?: string
  /** true for whole-number fields (year, towedYear → Int?): emission is rounded. */
  integer?: boolean
  disabled?: boolean
  /** Defaults to the shared "input" utility so it matches the existing selects. */
  className?: string
}

/** Controlled numeric <select> for rig fields. Designed to be driven by
 *  react-hook-form's <Controller> (field.value / field.onChange) so it emits
 *  real numbers rather than strings.
 *
 *  Out-of-range safety (edit path): if the saved value isn't one of the
 *  configured options (a between-steps 37.3, or a year outside 1990..now), it's
 *  injected as a selectable option and pre-selected — so opening and saving an
 *  existing rig never blanks or silently coerces stored data. */
export default function RangeSelect({
  options,
  value,
  onChange,
  onBlur,
  name,
  id,
  placeholder = 'Select…',
  integer = false,
  disabled,
  className = 'input',
}: RangeSelectProps) {
  const hasValue = value != null && !Number.isNaN(value)

  const displayOptions = useMemo(() => {
    if (!hasValue || options.includes(value as number)) return options
    // Keep the list's existing direction when splicing the stray value in.
    const ascending = options.length < 2 || options[0] <= options[options.length - 1]
    const merged = [...options, value as number]
    merged.sort((a, b) => (ascending ? a - b : b - a))
    return merged
  }, [options, value, hasValue])

  return (
    <select
      id={id}
      name={name}
      className={className}
      disabled={disabled}
      value={hasValue ? String(value) : ''}
      onBlur={onBlur}
      onChange={e => {
        const raw = e.target.value
        if (raw === '') {
          onChange(undefined)
          return
        }
        const num = Number(raw)
        onChange(integer ? Math.round(num) : num)
      }}
    >
      <option value="">{placeholder}</option>
      {displayOptions.map(v => (
        <option key={v} value={v}>{v}</option>
      ))}
    </select>
  )
}
