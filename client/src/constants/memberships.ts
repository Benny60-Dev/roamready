// Canonical list of the 8 supported membership types — id strings match what
// gets stored in Membership.type on the server (Prisma model uses a plain
// String column, not an enum, so this client list is the source of truth for
// valid ids and their human labels). Imported by:
//   - pages/profile/MembershipsPage.tsx  (catalogue + add/edit UI)
//   - pages/trips/TripBookingPage.tsx    (booking-card "have your card ready" nudge)
// If you add a type here, the server will accept it without any code change.

export const MEMBERSHIP_TYPES = [
  { id: 'ATB', label: 'America the Beautiful Pass', sub: 'Federal recreation lands' },
  { id: 'GOOD_SAM', label: 'Good Sam Club', sub: '10% off campgrounds' },
  { id: 'THOUSAND_TRAILS', label: 'Thousand Trails', sub: 'Preserve network' },
  { id: 'COAST_TO_COAST', label: 'Coast to Coast', sub: 'Private campground network' },
  { id: 'ESCAPEES', label: 'Escapees RV Club', sub: 'RVers support network' },
  { id: 'FMCA', label: 'FMCA', sub: 'Family Motor Coach Association' },
  { id: 'HARVEST_HOSTS', label: 'Harvest Hosts', sub: 'Farm, winery & museum stays' },
  { id: 'BOONDOCKERS_WELCOME', label: 'Boondockers Welcome', sub: 'Driveway camping network' },
]
