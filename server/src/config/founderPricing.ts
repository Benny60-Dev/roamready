// Founder pricing — lifetime-locked discounted rates ($7.99/mo, $69.99/yr)
// for users who sign up before FOUNDER_CUTOFF_DATE. The flag is written
// once at signup (auth.ts register + passport.ts Google OAuth first-login)
// and never flips thereafter; founders keep their rate even if they cancel
// and re-subscribe later.
//
// PLACEHOLDER DATE — update to (launch_date + 30 days) on launch day. The
// cutoff lives in a single constant so it's a one-line edit.
export const FOUNDER_CUTOFF_DATE = new Date('2026-12-31T23:59:59Z')

/** Returns true if a signup happening at `now` qualifies for founder pricing.
 *  Defaults to current time; accept an argument so tests can pin the clock. */
export function isFounderEligible(now: Date = new Date()): boolean {
  return now < FOUNDER_CUTOFF_DATE
}
