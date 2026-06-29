import type { FieldError as RHFFieldError } from 'react-hook-form'

/**
 * Standard inline validation message for a required/invalid form field.
 *
 * Renders nothing when there's no error, so it's safe to drop directly under any
 * field: <FieldError error={errors.fieldName} />. Shows the error's `message`
 * string when present (e.g. rules={{ required: 'Year is required' }}), otherwise
 * a generic fallback. Style matches the hand-rolled auth-page messages
 * (text-xs text-red-500 mt-1) so feedback is consistent site-wide.
 */
export default function FieldError({ error }: { error?: RHFFieldError }) {
  if (!error) return null
  return (
    <p className="text-xs text-red-500 mt-1">
      {typeof error.message === 'string' && error.message ? error.message : 'This field is required.'}
    </p>
  )
}
