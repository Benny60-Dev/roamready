// Centralized pricing constants. Imported by both PricingPage and
// PaywallModal so the Pro feature list has a single source of truth —
// previously these two surfaces carried independent copies that drifted
// (PaywallModal had its own PRO_FEATURES with different wording and
// ordering). One feature add/remove/reword now lands here.
//
// If you change a string in PRO_FEATURES, audit the existing
// FEATURE_GATES / requireFeature usages in server/src/middleware/auth.ts —
// the gates and the marketing copy aren't 1:1 (some gates exist without
// corresponding bullets, some bullets exist without gates) but the
// wording fixes here should match what feature gates actually enforce.

// Wording notes:
//  - "Save campground booking info" — honest about what the feature does
//    today (stores reservation details for your trip; full booking
//    integration is on backlog).
//  - "Weather forecasts along route" — no push notifications exist yet;
//    the feature renders forecast data inline on the trip itinerary.
//  - "Trip journal" — photo attachments are temporarily disabled (bug,
//    on backlog). The bullet stays in the marketing list because the
//    text/rating journal is fully functional.
//  - "Find resources along route" — active voice; reads better than
//    the prior passive phrasing.
//  - Military-only campground access was previously listed but removed
//    from the marketing card — the feature stays in-app for users it
//    serves; broad pricing-card placement was misleading for the
//    general civilian RV audience.
export const PRO_FEATURES: readonly string[] = [
  'AI trip planner (unlimited)',
  'Rig compatibility filtering',
  'Save campground booking info',
  'OHV & van destinations',
  'Weather forecasts along route',
  'Trip journal',
  'Maintenance tracker',
  'PDF export & sharing',
  'Find resources along route',
  'Packing list generator',
] as const
