export type SubscriptionTier = 'FREE' | 'PRO'
export type VehicleType = 'RV_CLASS_A' | 'RV_CLASS_B' | 'RV_CLASS_C' | 'FIFTH_WHEEL' | 'TRAVEL_TRAILER' | 'TOY_HAULER' | 'POP_UP' | 'VAN' | 'CAR_CAMPING'
export type TowedType = 'VEHICLE' | 'TRAILER'
export type TripStatus = 'PLANNING' | 'ACTIVE' | 'COMPLETED' | 'DRAFT'
export type StopType = 'DESTINATION' | 'OVERNIGHT_ONLY' | 'HOME'
export type BookingStatus = 'NOT_BOOKED' | 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'WAITLISTED'
export type MaintenanceStatus = 'OK' | 'DUE_SOON' | 'OVERDUE'
export type FeedbackType = 'FEATURE_REQUEST' | 'BUG_REPORT' | 'GENERAL'
export type FeedbackStatus = 'NEW' | 'PLANNED' | 'IN_PROGRESS' | 'SHIPPED' | 'DECLINED'

export interface User {
  id: string
  email: string
  firstName: string
  lastName: string
  phone?: string
  // emergencyContact / emergencyPhone removed (Block 6). The Prisma columns
  // are intentionally left in place (orphaned) to keep the one-time
  // backfillTravelParty script functional if the DB is ever re-seeded;
  // the application layer no longer reads or writes them. Live emergency-
  // contact data is on Person (isEmergencyContact + emergencyPhone) inside
  // the travel-party model.
  homeLocation?: string
  homeAddress?: string
  homeStreet?: string
  homeCity?: string
  homeState?: string
  homeZip?: string
  homeLat?: number
  homeLng?: number
  isFullTimeRVer?: boolean
  dismissedHomePrompt?: boolean
  avatarUrl?: string
  subscriptionTier: SubscriptionTier
  subscriptionId?: string
  customerId?: string
  trialEndsAt?: string
  subscriptionEndsAt?: string
  /** Complimentary (owner-granted) Pro — independent of Stripe. compTier === 'PRO'
   *  with compExpiresAt null = lifetime, or a future date = time-limited. Drives
   *  the Billing page's "Pro (complimentary)" display; entitlement is handled
   *  server-side by hasAccess. */
  compTier?: SubscriptionTier | null
  compExpiresAt?: string | null
  /** Lifetime founder rate eligibility — stamped at signup if joined
   *  before FOUNDER_CUTOFF_DATE. Drives founder-rate pricing/badge on
   *  PricingPage + PaywallModal and the priceId picked at checkout. */
  founderPricing?: boolean
  /** Email verification state. Drives the in-grace banner and
   *  over-grace gate screen (see authStore selectors). Owner accounts
   *  bypass both regardless of this value. */
  emailVerified?: boolean
  isOwner?: boolean
  /** Marketing email opt-in (FR-MARKETING-OPTIN). marketingConsentAt is stamped
   *  on ANY decision (opt-in OR "No thanks"); a null/undefined timestamp means
   *  "not yet asked" and is what gates the onboarding opt-in modal. */
  marketingConsent?: boolean
  marketingConsentAt?: string | null
  createdAt: string
  rigs?: Rig[]
  travelProfile?: TravelProfile
  memberships?: Membership[]
  parties?: TravelParty[]
}

export type PersonRole = 'ADULT' | 'TEEN' | 'CHILD' | 'INFANT'
export type PetType = 'DOG' | 'CAT' | 'OTHER'

export interface Person {
  id: string
  partyId: string
  role: PersonRole
  name?: string | null
  age?: number | null
  isTraveling: boolean
  isEmergencyContact: boolean
  isSelf: boolean
  emergencyPhone?: string | null
  accessibilityNeeds?: any
  dietaryNotes?: string | null
  militaryStatus?: string | null
  firstResponder?: string | null
  createdAt: string
  updatedAt: string
}

export interface Pet {
  id: string
  partyId: string
  type: PetType
  name?: string | null
  breed?: string | null
  weightLbs?: number | null
  leashTrained: boolean
  comfortableInCrowds: boolean
  comfortableAtNight: boolean
  notes?: string | null
  createdAt: string
  updatedAt: string
}

export interface TravelParty {
  id: string
  userId?: string | null
  tripId?: string | null
  isDefault: boolean
  notes?: string | null
  people: Person[]
  pets: Pet[]
  createdAt: string
  updatedAt: string
}

export interface Rig {
  id: string
  userId: string
  vehicleType: VehicleType
  year?: number
  make?: string
  model?: string
  length?: number
  height?: number
  fuelType?: string
  mpg?: number
  // Towing-adjusted MPG (towing-aware fuel estimate, Pass 1). For TRAILER
  // rigs this is the tow vehicle's mpg with the trailer hitched — the only
  // mileage that matters since the rig has no engine. For MOTORHOMES it's
  // the rig's mpg while flat-towing a toad (used when Trip.bringingTowed).
  // Falls back to solo `mpg` when null. See server/src/services/fuelPrice.ts.
  mpgTowing?: number
  tankSize?: number
  slideouts?: string
  electricalAmps?: string
  towingSetup?: string
  isToyHauler: boolean
  garageLength?: number
  gvwr?: number
  towVehicle?: string
  toys?: string[]
  terrainTypes?: string[]
  isVan: boolean
  vanLength?: string
  powerSetup?: any
  waterCapacity?: number
  hasStarlink: boolean
  isRemoteWorker: boolean
  isCamper: boolean
  sleepSetup?: string
  isOffRoad: boolean
  isDefault: boolean
  currentMiles?: number
  // Plate + structured towing — see prisma/schema.prisma for semantics. The
  // legacy free-form towVehicle / towingSetup fields above are deprecated and
  // no longer written by the client; new code should use the structured fields.
  licensePlate?: string
  isTowing?: boolean
  towedType?: TowedType
  towedYear?: number
  towedMake?: string
  towedModel?: string
  towedLength?: number
  towedLicensePlate?: string
  // Block 7 (May 2026) additions — second-vehicle height + fuel. Both only set
  // in the TOW VEHICLE direction (truck pulling a trailer/5th wheel) — the
  // toad sub-form omits them since a flat-towed Jeep's height/fuel never
  // matters for the rig's planning. See client/src/utils/rigs.ts
  // deriveSecondVehicle for the direction derivation from vehicleType.
  towedHeight?: number
  towedFuelType?: string
  createdAt: string
}

export interface TravelProfile {
  id: string
  userId: string
  travelStyle?: string
  maxDriveHours?: number
  maxMilesPerDay?: number
  nightlyBudget?: number
  hookupPreference?: string
  campgroundTypes?: string[]
  interests?: string[]
  adults: number
  children: number
  hasPets: boolean
  petDetails?: any
  accessibilityNeeds?: any
  militaryStatus?: string
  firstResponder?: string
}

export interface Membership {
  id: string
  userId: string
  type: string
  memberNumber?: string
  planTier?: string
  expiresAt?: string
  autoApply: boolean
  isActive: boolean
}

export interface Trip {
  id: string
  userId: string
  rigId?: string
  name: string
  status: TripStatus
  startLocation: string
  endLocation: string
  startDate?: string
  endDate?: string
  totalMiles?: number
  totalNights?: number
  estimatedFuel?: number
  estimatedCamp?: number
  actualFuel?: number
  actualCamp?: number
  fuelPrice?: number
  sharedToken?: string
  packingList?: PackingCategory[]
  aiConversation?: ChatMessage[]
  itinerary?: ItineraryDay[]
  stops?: Stop[]
  // Block 8 — per-trip vehicle decisions captured by ConfirmVehiclesModal at
  // promote time. See prisma/schema.prisma Trip model for the full rationale.
  // bringingTowed: null = not asked / not applicable; UI treats null|true as
  //   "yes, bringing the toad" (modal default). Only meaningful when the
  //   rig's deriveSecondVehicle direction is 'toad'.
  // adHocVehicle: optional one-off vehicle for this trip only — NOT saved to
  //   the user's profile/rigs.
  bringingTowed?: boolean | null
  adHocVehicle?: { year?: number; make?: string; model?: string; length?: number } | null
  // RV-SAFETY-ACK — build-time acknowledgment that destinations/routes are NOT
  // verified RV-safe. { acknowledgedAt: ISO } once acknowledged; null/absent =
  // not acknowledged (re-prompts on next build). Reset to null server-side by
  // syncTripEndpoints whenever a modify changes the route.
  acknowledgedRvSafety?: { acknowledgedAt: string } | null
  createdAt: string
  updatedAt: string
}

export interface Stop {
  id: string
  tripId: string
  order: number
  type: StopType
  locationName: string
  locationState?: string
  // AI-itinerary-only, HOME stop only: the user's verbatim full starting
  // address (street/zip) when they typed one in chat. locationName/locationState
  // stay city/state for planning; this is read solely to pre-fill the
  // SaveHomeAddressModal with the full address (SessionPage buildItinerary).
  // Never persisted — the createStop controller whitelists fields and drops it.
  startAddress?: string
  latitude?: number
  longitude?: number
  arrivalDate?: string
  departureDate?: string
  nights: number
  campgroundName?: string
  campgroundId?: string
  bookingStatus: BookingStatus
  confirmationNum?: string
  siteRate?: number
  // Block 13 — actual cost capture. siteRate remains the pre-booking
  // estimate; actualRate/actualFees hold the real numbers the user
  // recorded at booking time. Optional + nullable so partial saves work.
  actualRate?: number | null
  actualFees?: number | null
  // Per-leg actual fuel for the drive that arrived at this stop. Optional
  // + nullable; null on the first/HOME stop (no leg arrives at it) and
  // on un-recorded legs. Replaces Trip.actualFuel for totals math.
  actualFuel?: number | null
  estimatedFuel?: number
  hookupType?: string
  checkInTime?: string
  checkOutTime?: string
  siteNumber?: string
  notes?: string
  isPetFriendly?: boolean
  isMilitaryOnly: boolean
  isCompatible: boolean
  incompatibilityReasons?: string[]
  // RIG-CHANGE Phase 1 — accountability stamp written server-side when this
  // stop transitions into a booked state (CONFIRMED/PENDING/WAITLISTED). Records
  // the rig the site was booked against so a later (larger) rig swap can flag it
  // for re-verification without ever altering the reservation. All optional —
  // null on unbooked stops and on bookings made before the stamp shipped.
  bookedForRigName?: string | null
  bookedForRigType?: VehicleType | null
  bookedForRigLength?: number | null
  bookedForRigTowedLength?: number | null
  bookedForRigHeight?: number | null
  bookedForRigWeight?: number | null
  bookedForRigAt?: string | null
  // ADDSTOP-RESLOT Phase A/B — the arrivalDate captured when this stop was booked.
  // When a later modify-insert shifts the itinerary, arrivalDate moves but this
  // stays, so a booked stop with arrivalDate !== originalBookedDate is showing a
  // shifted date (reservation unchanged) — surfaced as a per-stop note.
  originalBookedDate?: string | null
  alternates?: any[]
  weatherForecast?: WeatherDay[]
  highwayRoute?: string | null
  driveDuration?: string | null
  driveDistanceMiles?: number | null
  routeHighlights?: string | null
  pointsOfInterest?: POI[]
  campgroundCandidates?: string[]
  // Block 15 — one shared "things to do during your stay" list per stop,
  // replacing the prior N per-day duplicate lists rendered from Trip.itinerary.
  // Optional + nullable: null on existing trips that haven't been backfilled
  // (Step 4) or on stops where no AI activities were ever generated. The
  // renderer in TripSummaryPage falls back to the per-day shape in
  // Trip.itinerary whenever this is null, so old trips keep working unchanged.
  // Value can be an ItineraryActivity[] (post-edit) or string[] (initial AI
  // write); normalizeActivities() in TripSummaryPage handles both shapes.
  stayActivities?: ItineraryActivity[] | string[] | null
  journalEntry?: JournalEntry
}

// ─── Fuel-cost estimate (GET /api/v1/trips/:id/fuel-estimate) ─────────────────
// Returned by the server's computeFuelEstimate via the per-leg EIA pricing
// service. perLeg breaks the trip into consecutive stop-pair segments, each
// priced by the destination state's regional retail rate. `source` is the
// worst-case data tier across legs ('fallback' if any used the hardcoded
// table). `noEstimate` is set when computation couldn't proceed (no rig MPG,
// fewer than 2 stops); the client surfaces a hint in that case.

export interface FuelLegEstimate {
  fromOrder: number
  toOrder: number
  toState: string | null
  miles: number
  pricePerGallon: number
  region: string
  paddCode: string
  source: 'eia' | 'cache' | 'fallback'
  cost: number
}

export interface TripFuelEstimate {
  total: number
  fuelType: 'gas' | 'diesel'
  perLeg: FuelLegEstimate[]
  source: 'eia' | 'cache' | 'fallback'
  asOf: string | null
  noEstimate?: boolean
  noEstimateReason?: string
  // ── Towing-aware fuel estimate, Pass 1 of 3 ────────────────────────────────
  // Server now returns the effective MPG figure it ACTUALLY used in the
  // (miles / mpgUsed) × $/gal formula, plus a basis tag explaining why it
  // picked solo vs towing mpg. Pass 3 will render these in the Fuel-group
  // disclosure line ("Estimated at 12 MPG, towing — terrain and load
  // affect real mileage"). Null in the noEstimate path (no MPG, <2 stops).
  // fuelTypeUsed is the grade priced — for trailers this can differ from
  // the rig's own fuelType (the trailer's stove/propane is irrelevant;
  // the tow vehicle's diesel/gas is what's actually burned).
  mpgUsed: number | null
  mpgBasis: 'solo' | 'towing' | null
  fuelTypeUsed: 'gas' | 'diesel'
}

export interface JournalEntry {
  id: string
  userId: string
  // Optional links — a freeform/standalone entry has neither; an in-trip
  // entry has tripId; a per-stop entry has both stopId and tripId.
  tripId?: string | null
  stopId?: string | null
  // Route-POI link (JOURNAL-ROUTESTOP): set when the entry belongs to an
  // itinerary "stop along the way" POI (keyed by the POI's stable id) rather
  // than a Stop row. stopId stays null for these.
  routePoiId?: string | null
  title?: string | null
  body?: string | null
  rating?: number | null
  tags: string[]
  entryDate: string
  state?: string | null
  lat?: number | null
  lng?: number | null
  placeName?: string | null
  // Photos + actualCost are written by the legacy per-stop path; kept here so
  // the existing TripJournalPage editor type-checks against the same model.
  photos?: string[]
  actualCost?: number | null
  createdAt: string
  updatedAt?: string
}

export interface MaintenanceItem {
  id: string
  rigId: string
  name: string
  intervalMiles?: number
  intervalMonths?: number
  lastServiceMiles?: number
  lastServiceDate?: string
  currentMiles?: number
  status: MaintenanceStatus
  notes?: string
  logs?: MaintenanceLog[]
}

export interface MaintenanceLog {
  id: string
  itemId: string
  serviceDate: string
  mileage?: number
  notes?: string
  cost?: number
}

export interface Feedback {
  id: string
  userId?: string
  type: FeedbackType
  title?: string
  body: string
  screen?: string
  rating?: number
  importance?: string
  isPublic: boolean
  status: FeedbackStatus
  votes: number
  rigType?: string
  tripContext?: string
  /** Admin archive timestamp — null/absent = active. Admin-only concern;
   *  never affects public roadmap visibility. */
  archivedAt?: string | null
  /** When the submitter was emailed that this item shipped (null = never).
   *  Server-stamped after a successful send only. */
  shippedNotifiedAt?: string | null
  createdAt: string
  user?: { email: string; firstName: string; lastName: string }
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export type PlanningSessionStatus = 'PLANNING' | 'COMPLETED' | 'ARCHIVED'

export interface PlanningSession {
  id: string
  userId: string
  title: string | null
  messages: ChatMessage[]
  partialTripData: any | null
  tripId: string | null
  status: PlanningSessionStatus
  createdAt: string
  updatedAt: string
}

export interface WeatherDay {
  date: string
  temp: { min: number; max: number; feels: number }
  conditions: string
  icon: string
  wind: number
  humidity: number
  precipitation: number
  alerts: string[]
}

export interface WeatherAlert {
  type: 'wind' | 'rain' | 'freeze' | 'snow'
  level: 'amber' | 'blue' | 'red'
  message: string
}

export interface ForecastDay {
  date: string
  icon: string
  conditions: string
  high: number
  low: number
  precipProbability: number
  precipSum: number
  snowfall: number
  windSpeed: number
  alerts: WeatherAlert[]
}

export interface HistoricalWeather {
  mode: 'historical'
  month: string
  avgHigh: number
  avgLow: number
  avgRainfall: number
  avgSnowfall: number
  conditions: string
  icon: string
  bestCase: string
  worstCase: string
}

export interface LiveForecast {
  mode: 'live'
  days: ForecastDay[]
}

export type StopWeather = HistoricalWeather | LiveForecast

export interface POI {
  // Stable client-generated id (crypto.randomUUID), assigned at add time so a
  // route POI can carry a journal entry keyed by routePoiId (JOURNAL-ROUTESTOP).
  // Optional: POIs added before this shipped have none and are simply not
  // journalable (degrade gracefully) until re-added — never assume it exists.
  id?: string
  name: string
  durationMinutes: number
  // Block 16 — optional short description carried over when a POI was added
  // from an AI route suggestion. Manual-add POIs leave this undefined. The
  // server-side Trip.itinerary JSON column accepts the field unchanged
  // (saveItinerary persists whatever shape the client sends) and the Zod
  // schema on the Stop table's parallel pointsOfInterest column already
  // accepts arbitrary objects (z.array(z.any())), so no server change is
  // required to round-trip the description.
  description?: string
}

export interface ItineraryActivity {
  name: string
  checked: boolean
  isCustom?: boolean
}

export interface ItineraryDay {
  dayNum: number
  type: 'DRIVE' | 'STAY' | 'ACTIVITY' | 'OVERNIGHT'
  stopOrder: number
  routeDescription?: string | null
  terrainSummary?: string | null
  pointsOfInterest?: POI[] | null
  activities?: ItineraryActivity[] | string[] | null
  transitNote?: string | null
  departureTime?: string | null
  checkInTime?: string | null
  checkOutTime?: string | null
  highwayRoute?: string | null
}

export interface PackingCategory {
  category: string
  items: PackingItem[]
}

export interface PackingItem {
  name: string
  required: boolean
  checked: boolean
  /** True only for items the user added by hand. AI-generated and legacy items
   *  leave this unset (falsy). Custom items survive a Regenerate (they won't
   *  appear in the freshly generated list) — see server/src/utils/packingMerge.ts. */
  custom?: boolean
}

/** Counts a packing list was generated for / currently resolves to. */
export interface PackingCounts {
  adults: number
  children: number
  pets: number
  petTypes: PetType[]
  nights: number
}

/** Snapshot stored at generation time (Trip.packingListMeta). */
export interface PackingListMeta extends PackingCounts {
  generatedAt: string
}

/** Returned by GET /trips/:id (as `packingContext`) when a packing list exists.
 *  `packingListMeta` is null for legacy lists generated before snapshots; in
 *  that case `stale` is always false. */
export interface PackingContext {
  packingListMeta: PackingListMeta | null
  current: PackingCounts
  stale: boolean
  /** Which dimensions drifted: any of 'people' | 'pets' | 'nights'. */
  changed: string[]
}

export interface Campground {
  id: string
  name: string
  latitude?: number | null
  longitude?: number | null
  description?: string
  reservationUrl?: string | null
  website?: string | null
  address?: string | null
  phone?: string | null
  maxRigLength?: number | null
  maxRigHeight?: number | null
  rvProhibited?: boolean
  isPetFriendly?: boolean
  isMilitaryOnly?: boolean
  hookupTypes?: string[]
  source?: 'recreation.gov' | 'google_places' | 'ai_only' | string
  isCompatible?: boolean
  incompatibilityReasons?: string[]
  rating?: number | null
  userRatingCount?: number | null
  siteRate?: number
  isPrimary?: boolean
}

export interface Notification {
  id: string
  userId: string
  title: string
  body: string
  type: string
  isRead: boolean
  data?: any
  createdAt: string
}
