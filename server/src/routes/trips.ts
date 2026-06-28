import { Router } from 'express'
import { requireAuth, requireFeature, AuthRequest } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { validateBody } from '../middleware/validate'
import {
  StopUpdateSchema, TripUpdateSchema, TripShiftDatesSchema, TripPackingListSchema,
  SeedFromTemplateSchema, CopyPackingFromTripSchema,
} from '../schemas'
import {
  getTrips, createTrip, getTrip, updateTrip, shiftTripDates, deleteTrip,
  getStops, createStop, updateStop, deleteStop, longLegPreview, makeOneWay,
  getSharedTrip, exportPdf, generatePackingList, updatePackingList,
  seedPackingListFromTemplate, copyPackingListFromTrip,
  generateItinerary, saveItinerary, generateRoutes, generateActivities,
  generateRouteHighlights, getTripMapImage, getTripWeather, reassignPOIs,
  createShareToken, regenerateShareToken, revokeShareToken,
  getTripFuelEstimate, getTripHazards,
} from '../controllers/trips'

export const tripsRouter = Router()

// Public — intentionally pre-requireAuth so anyone with a valid share token
// can view the itinerary. The Pro gate happens on token *creation* below,
// not on consumption.
tripsRouter.get('/share/:token', getSharedTrip)

tripsRouter.use(requireAuth, requireVerifiedEmail)

tripsRouter.get('/', getTrips as any)
tripsRouter.post('/', createTrip as any)
tripsRouter.get('/:id', getTrip as any)
tripsRouter.put('/:id', validateBody(TripUpdateSchema), updateTrip as any)
tripsRouter.post('/:id/shift-dates', validateBody(TripShiftDatesSchema), shiftTripDates as any)
tripsRouter.delete('/:id', deleteTrip as any)

tripsRouter.get('/:id/stops', getStops as any)
tripsRouter.post('/:id/stops', createStop as any)
tripsRouter.put('/:id/stops/:stopId', validateBody(StopUpdateSchema), updateStop as any)
tripsRouter.delete('/:id/stops/:stopId', deleteStop as any)
// Long-leg delete preview — measures the merged leg before the client finalizes
// deleting an OVERNIGHT_ONLY stop, so the "keep the long drive?" confirm modal can
// show the real hours. Read-only; same ungated posture as the other measure paths.
tripsRouter.post('/:id/stops/:stopId/long-leg-preview', longLegPreview as any)
// Atomic round-trip → one-way conversion: truncate everything after the turnaround
// (return-leg transit overnights + the trailing return-home closer) in one shot.
tripsRouter.post('/:id/make-one-way', makeOneWay as any)

tripsRouter.post('/:id/share', requireFeature('tripSharing'), createShareToken as any)
tripsRouter.post('/:id/share/regenerate', requireFeature('tripSharing'), regenerateShareToken as any)
tripsRouter.delete('/:id/share', requireFeature('tripSharing'), revokeShareToken as any)

tripsRouter.post('/:id/export/pdf', requireFeature('pdfExport'), exportPdf as any)
tripsRouter.get('/:id/map-image', getTripMapImage as any)
tripsRouter.get('/:id/weather', requireFeature('weatherAlerts'), getTripWeather as any)
// Fuel-cost estimate — priced per leg by destination-state via EIA. Ungated
// (the underlying EIA fetch is cheap + cached 7-day) so all trip surfaces
// can show a live regional estimate. See controllers/trips.ts → getTripFuelEstimate.
tripsRouter.get('/:id/fuel-estimate', getTripFuelEstimate as any)
// RV hazard warnings for the built trip — recomputed on demand (not persisted on
// the Stop row). See controllers/trips.ts → getTripHazards.
tripsRouter.get('/:id/hazards', getTripHazards as any)
tripsRouter.post('/:id/packing-list', requireFeature('packingListGenerator'), generatePackingList as any)
// Save the curated list (checked toggles + removals). Deliberately NOT
// Pro-gated: generation is the gated feature; persisting your own checkmarks
// on an existing list shouldn't paywall.
tripsRouter.put('/:id/packing-list', validateBody(TripPackingListSchema), updatePackingList as any)
// FR-SAVED-PACKING — seed this trip's packing list from existing data, MERGED
// (mergePackedState), not overwritten. from-template is Pro (same gate as
// generation); copy-from another owned trip is FREE (no gate — it only reads
// data the user already owns). More-specific paths than /:id/packing-list above,
// so no route collision.
tripsRouter.post('/:id/packing-list/from-template', requireFeature('packingListGenerator'), validateBody(SeedFromTemplateSchema), seedPackingListFromTemplate as any)
tripsRouter.post('/:id/packing-list/copy-from', validateBody(CopyPackingFromTripSchema), copyPackingListFromTrip as any)
tripsRouter.post('/:id/stops/reassign-pois', reassignPOIs as any)
// PLAN-IS-TRUTH (Part 2) — the deterministic per-leg drive-time check no longer
// has its own route. It now runs as the shared internal choke point
// recheckLongLegs(), invoked from the stop-mutation controllers (create/update/
// delete) and from the planning chat splice. The old POST /:id/expand-long-legs
// and POST /:id/reconcile-nights routes were retired with their controllers:
// transit stops are inserted during planning (so the user approves them) and on
// post-build edits, and nights are never reconciled away from explicit per-stop intent.
// Block 9 — three AI-calling endpoints on the trips router get
// requireFeature('aiPlannerUnlimited') so non-Pro users hit a 403 → paywall.
//   /:id/itinerary/generate   → generateTripItineraryAI  (build from chat)
//   /:id/activities/generate  → generateStopActivitiesAI (per-stop suggestions)
//   /:id/stops/:id/highlights → generateRouteHighlightsAI (per-stop narrative)
// The neighbors here that LOOK AI-named but aren't stay ungated:
//   /:id/routes               → fetchAllSegmentRoutes (Google Directions)
//   /:id/stops/reassign-pois  → Google Places
//   PUT /:id/itinerary        → saveItinerary (DB write only, no LLM)
tripsRouter.post('/:id/itinerary/generate', requireFeature('aiPlannerUnlimited'), generateItinerary as any)
tripsRouter.put('/:id/itinerary', saveItinerary as any)
tripsRouter.post('/:id/routes', generateRoutes as any)
tripsRouter.post('/:id/activities/generate', requireFeature('aiPlannerUnlimited'), generateActivities as any)
tripsRouter.post('/:id/stops/:stopId/highlights', requireFeature('aiPlannerUnlimited'), generateRouteHighlights as any)
