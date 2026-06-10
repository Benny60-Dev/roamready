// Founder pricing — discounted rates ($7.99/mo, $69.99/yr) for users who
// sign up before FOUNDER_CUTOFF_DATE. The flag is written once at signup
// (auth.ts register + passport.ts Google OAuth first-login) and never flips
// thereafter — but the flag is ELIGIBILITY, not the rate itself. Per the
// ToS (Founding Member Pricing), the discounted RATE is forfeited on
// cancel-and-rejoin: the new subscription bills at the then-current
// standard rate even though founderPricing stays true on the User row.
// NOTE: that forfeiture is a ToS term, not yet enforced in code — checkout
// still selects founder price IDs off this flag alone.
//
// PLACEHOLDER DATE — update to (launch_date + 30 days) on launch day. The
// cutoff lives in a single constant so it's a one-line edit.
export const FOUNDER_CUTOFF_DATE = new Date('2026-12-31T23:59:59Z')

/** Returns true if a signup happening at `now` qualifies for founder pricing.
 *  Defaults to current time; accept an argument so tests can pin the clock. */
export function isFounderEligible(now: Date = new Date()): boolean {
  return now < FOUNDER_CUTOFF_DATE
}
