# Scout: Trip-tagged feedback → admin session-inspector deep-link

**Status:** Read-only scout complete. Nothing built yet — awaiting go-ahead + one decision.
**Goal:** Make feedback/bug reports carry the trip ID (and trip name) so an admin can
jump straight into the session inspector for the exact trip the user was on.

---

## A. "Report an issue" trigger placement (the three pages)

| Page | File | Trip id in scope | Placement (existing button row) | Button style to match |
|---|---|---|---|---|
| **Map** | `client/src/pages/trips/TripMapPage.tsx` | ✅ `id` from `useParams` (line 513) | Action bar at **1821–1861** (Journal / Packing / Share / PDF) | `btn-outline text-sm flex items-center gap-1.5` |
| **Itinerary** | `client/src/pages/trips/TripSummaryPage.tsx` | ✅ `id` from `useParams` (line 517) | Header action row at **1373–1407** (Modify / Journal / Share / PDF) | `btn-outline text-sm flex items-center gap-1.5` |
| **Planning** | `client/src/pages/SessionPage.tsx` | ⚠️ **no tripId** — only `sessionId`; `itinerary` is unpromoted | Sticky header button group at **1304–1340** (New trip / Cancel) | `px-3 py-1.5 text-xs border border-gray-200 rounded-md hover:bg-gray-50 flex items-center gap-1` |

### ⚠️ The snag: SessionPage has no trip of its own
A planning session only becomes a `Trip` after the user clicks **Build** — the tripId first
exists at `promoted.data.trip.id` (SessionPage ~line 1033). So a "Report an issue" button on
the planning page can't attach *its own* tripId. It can only attach the **remembered last trip**
(the fallback below), which may be empty on a brand-new session the user navigated to directly.

The two real trip pages (map, itinerary) carry their own `id` reliably — unambiguous.

---

## B. Remember-last-trip stash + email feasibility

- **Stash = `client/src/store/uiStore.ts`** (Zustand). Current shape:
  `feedbackModalOpen / feedbackPrefillType / paywallModal` + setters. Add `lastTripId` /
  `lastTripName` + a `rememberTrip(id, name)` setter.
- **Where to set it (on trip load):**
  - `TripMapPage.tsx:774-793` — `tripsApi.get(id).then(res => { setTrip(data) … })`, fields `data.id` / `data.name`.
  - `TripSummaryPage.tsx:633-636` — `reloadTrip()` → `setTrip(t)`, fields `t.id` / `t.name`.
- **Capture wiring (verified):** the modal reads `feedbackPrefillType` from the store and submits
  via `feedbackApi.submit({...})` (`FeedbackModal.tsx:108`). tripId/tripName flow the SAME way
  `prefillType` already does — store → modal → submit payload. No prop drilling.
- **Email = feasible.** `submitFeedback` sends two fire-and-forget emails via
  `server/src/services/feedbackNotification.ts` (HTML + plain text, Resend). Base-URL precedent
  already exists there: `const clientOrigin = process.env.CLIENT_URL || 'http://localhost:3000'`
  (line 215). Plan: add an admin deep-link row to the **support-notification** email (team-facing,
  ~line 78 table), gated on `feedback.tripId`. Do NOT add it to the submitter acknowledgment
  (user-facing — an admin link there would be wrong).

---

## C. Migration shape (confirmed)

Two new **nullable** columns on `Feedback` (`prisma/schema.prisma`), **no `sessionId`**:

```prisma
tripId    String?
tripName  String?
```

Plain scalars (not a relation/FK) so feedback survives if the trip is later deleted.
`tripName` is the human sanity-check against a stale/wrong guess. Nothing existing is
duplicated (`tripContext` / `rigType` are free-text and currently unpopulated).

---

## Proposed build plan — "Trip-tagged feedback via the UI store"

Capture → Store → Persist → Display. 9 files + migration + 1 test:

1. `prisma/schema.prisma` — add `tripId String?`, `tripName String?` to `Feedback`; new migration.
2. `server/src/schemas/feedback.ts` — add `tripId` / `tripName` (optional, max-length) to the
   `.strict()` `FeedbackSubmitSchema` (else it 400s on the new keys).
3. `server/src/controllers/feedback.ts` — write `tripId` / `tripName` into `prisma.feedback.create`;
   pass them into the notification call.
4. `server/src/services/feedbackNotification.ts` — add `Admin: /admin/session-inspector?tripId=…`
   line to the support email (HTML + text), gated on `feedback.tripId`, using the existing
   `CLIENT_URL` pattern.
5. `client/src/store/uiStore.ts` — add `lastTripId` / `lastTripName` + `rememberTrip()`; extend
   `openFeedbackModal(prefillType?, trip?)` to stash `feedbackTripId` / `feedbackTripName`
   (explicit `trip` else fall back to `lastTrip*`); clear on close.
6. `client/src/components/feedback/FeedbackModal.tsx` — read `feedbackTripId` / `feedbackTripName`
   from store, include them in the submit payload.
7. `client/src/services/api.ts` — add `tripId?` / `tripName?` to the `feedbackApi.submit` type.
8. `client/src/pages/trips/TripMapPage.tsx` + `TripSummaryPage.tsx` — call `rememberTrip(id, name)`
   on trip load; add the "Report an issue" button passing `{ tripId: id, tripName: trip.name }`.
9. `client/src/pages/SessionPage.tsx` — add the "Report an issue" button (behavior = the open
   decision below).

**Display (admin):** in the session inspector feedback/session rows, render a one-click link to
`/admin/session-inspector?tripId=<id>` when a row has a tripId. (`inspectSession` already accepts
tripId as its primary lookup key, so this is just a rendered link.)

**Test (added on approval):** a server integration test — POST `/api/v1/feedback` with
`tripId` / `tripName`, assert the created `Feedback` row persists `tripId`. Mirrors the existing
feedback controller/route test setup (auth + verified email).

**Run steps after build (no kill commands; don't assume tsx watch reloaded):**
1. Apply the migration (`npx prisma migrate dev` in the correct tree — exact command provided).
2. **Manually restart the backend** (new Prisma client / new column).
3. Run the test suite (exact command provided).

---

## OPEN QUESTIONS FOR DISCUSSION

### Q1 — SessionPage "Report an issue" behavior (blocking; changes the build)
The planning page has no trip of its own pre-Build. What should its button attach?

- **Option A — Remembered last trip (best-guess):** Button always shows; attaches
  `lastTripId`/`lastTripName` from the store (may be empty on a brand-new session). Consistent
  with the Help fallback; `tripName` lets the admin sanity-check the guess.
- **Option B — Only show post-Build:** Hide the button during pure planning; once a trip exists,
  attach the real promoted tripId. Most accurate, but no report affordance while planning.
- **Option C — Always show, attach nothing if unknown:** Attaches the remembered trip if present,
  otherwise plain feedback with no tripId. Never attaches a possibly-wrong guess.

*(My lean: A or C — keep the affordance everywhere; `tripName` makes a wrong guess obvious to the
admin. B is safest against false attribution but drops the button exactly where bug reports during
planning are likely.)*

### Q2 — Should the remembered trip ever override an explicit page trip?
On map/itinerary the page passes its own real tripId. Proposal: explicit page tripId always wins;
`lastTrip*` is only the fallback when the opener passes nothing (Help menu, SessionPage). Confirm
that precedence is what you want.

### Q3 — Deep-link target: inspector vs. the trip itself
Plan deep-links to `/admin/session-inspector?tripId=<id>` (admin context). Alternative/in addition:
link straight to `/trips/<id>/map`. Confirm inspector-only is right (it is, for the stated admin
workflow).

### Q4 — Email deep-link scope
Add the admin deep-link to the **support/team** email only (not the user acknowledgment). Confirm.
