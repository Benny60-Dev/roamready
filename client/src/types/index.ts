export type SubscriptionTier = 'FREE' | 'PRO' | 'PRO_PLUS'
export type VehicleType = 'RV_CLASS_A' | 'RV_CLASS_B' | 'RV_CLASS_C' | 'FIFTH_WHEEL' | 'TRAVEL_TRAILER' | 'TOY_HAULER' | 'POP_UP' | 'VAN' | 'CAR_CAMPING'
export type TripStatus = 'PLANNING' | 'ACTIVE' | 'COMPLETED' | 'DRAFT'
export type StopType = 'DESTINATION' | 'OVERNIGHT_ONLY' | 'HOME'
export type BookingStatus = 'NOT_BOOKED' | 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'WAITLISTED'
export type MaintenanceStatus = 'OK' | 'DUE_SOON' | 'OVERDUE'
export type FeedbackType = 'FEATURE_REQUEST' | 'BUG_REPORT' | 'GENERAL' | 'CAMPGROUND_REVIEW'
export type FeedbackStatus = 'NEW' | 'PLANNED' | 'IN_PROGRESS' | 'SHIPPED' | 'DECLINED'

export interface User {
  id: string
  email: string
  firstName: string
  lastName: string
  phone?: string
  emergencyContact?: string
  emergencyPhone?: string
  homeLocation?: string
  avatarUrl?: string
  subscriptionTier: SubscriptionTier
  subscriptionId?: string
  customerId?: string
  trialEndsAt?: string
  subscriptionEndsAt?: string
  isOwner?: boolean
  createdAt: string
  rigs?: Rig[]
  travelProfile?: TravelProfile
  memberships?: Membership[]
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
  alternates?: any[]
  weatherForecast?: WeatherDay[]
  journalEntry?: JournalEntry
}

export interface JournalEntry {
  id: string
  stopId: string
  title?: string
  body?: string
  rating?: number
  photos?: string[]
  actualCost?: number
  createdAt: string
  updatedAt: string
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
  createdAt: string
  user?: { email: string; firstName: string; lastName: string }
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
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
  pointsOfInterest?: string[] | null
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
}

export interface Campground {
  id: string
  name: string
  latitude?: number
  longitude?: number
  description?: string
  reservationUrl?: string
  website?: string
  address?: string
  phone?: string
  maxRigLength?: number
  maxRigHeight?: number
  rvProhibited?: boolean
  isPetFriendly?: boolean
  isMilitaryOnly?: boolean
  hookupTypes?: string[]
  source?: string
  isCompatible?: boolean
  incompatibilityReasons?: string[]
  rating?: number
  siteRate?: number
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
