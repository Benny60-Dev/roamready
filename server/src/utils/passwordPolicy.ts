// Server-side password policy. Pure / synchronous / no I/O — safe to
// call from request handlers without await ceremony. Mirror the
// length-and-empty checks on the client for UX, but the breach-list
// check is server-only (the 10K+ blocklist would bloat the bundle and
// also tip off attackers about what we're filtering on).
//
// Policy (locked):
//   - Min 10 chars
//   - No character-class requirements (no forced upper/lower/digit/special)
//   - Reject if in the common-passwords blocklist (case-insensitive)
//   - No max length (bcrypt has an internal 72-byte cap; arbitrary
//     caps frustrate passphrase users)
//   - Reject empty / whitespace-only explicitly
import { COMMON_PASSWORDS } from './commonPasswords'

const MIN_LENGTH = 10

export interface PasswordValidationResult {
  valid: boolean
  error?: string
}

/** Validate a candidate password against the locked RoamReady policy.
 *  Returns { valid: true } on success, or { valid: false, error: msg }
 *  with a SPECIFIC human-readable error per rejection case. Callers
 *  surface `error` directly to the user. */
export function validatePassword(password: string): PasswordValidationResult {
  // Empty / whitespace-only. Spec wants this rejection as its own
  // category — a generic "too short" would be confusing for the case
  // where the user submitted spaces (technically chars, but useless).
  if (!password || password.trim().length === 0) {
    return { valid: false, error: 'Password is required.' }
  }

  // Length. The check is on the raw string, not trimmed — a 10-char
  // password with leading/trailing spaces is fine (some password
  // managers intentionally use padded strings).
  if (password.length < MIN_LENGTH) {
    return {
      valid: false,
      error: `Password must be at least ${MIN_LENGTH} characters.`,
    }
  }

  // Breach-list check. Case-insensitive — most blocklist sources are
  // already lowercased, and "Password123" should fail the same way
  // "password123" does.
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return {
      valid: false,
      error: 'This password appears in known data breaches. Please choose something less common.',
    }
  }

  return { valid: true }
}
