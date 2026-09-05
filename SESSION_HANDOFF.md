# Session Handoff
<!-- GENERATED FROM launch-status.json — do not hand-edit this section; it is overwritten on every regen -->

**Status as of 2026-09-02** — verified against `main` @ `099c454`.

## Open items
- PR-1 — **Free tier is a dead app post-trial** — Free and Pro cards list identical features; after the 7-day trial nearly every surface is `requireFeature`-gated (chat, campground search, journal writes, packing, resources, weather, share, PDF) (OPEN — **product decision first**)
- PR-3 — **Mileage drift across surfaces** — 470 / 472 / 473 mi for the same trip on itinerary, dashboard, share page; booking page showed 208.3 mi for a 244 mi leg (reads like straight-line) (OPEN)
- PR-4 — **Share page diverges from the app** — $311 fuel-only vs $686 in-app, campgrounds omitted although the share modal says they're included, no map, finish stop's nights dropped (OPEN)
- PR-5 — **Journal Maps "trips" view** — routes render on a blank gray void; toggling "Show routes" makes the base map appear and routes vanish (OPEN)
- PR-6 — **Missing camping cost line** — a 6-night trip priced 5 nights; the Tonalea overnight had no camping line (OPEN)
- PR-7 — **Off-route hazard warning** — Moki Dugway (UT-261) warned on a US-160 → US-191 route (OPEN)
- PR-10 — **PDF export "click gives no feedback"** (OPEN — verify as a gating bug)
- PLANNER-WATCH-1 — **Planner still claims drive-limit compliance / builds a 0-night stop** (post FEAT-PLANNER-FACTS watch list) (OPEN — watch; prompt nudge if it recurs)
- FEAT-PDF-ROUTE-LINE — **PDF cover map traces the measured route** — today it connects stop pins with straight lines (OPEN — backlog (Benny asked 2026-09-02))
- BOOKING-PILLS-INV — **Booking-pill CTA inventory** — wording/affordance refinement of the booking pills/CTAs (OPEN — backlog (scouted, not built))

## Deferred / post-launch
- 12 — **iOS Safari zoom-stuck bug** (PARTIAL — mitigations shipped; original reproduction never confirmed (review could not test mobile; still owed a real-device test))
- 14 — **OHV/off-road destinations: own data source** (DEFERRED — post-launch)
- 15 — **OHV Destinations — code-split the page with `lazy()`** (DEFERRED — low priority (still true at 862ce37))
- 16 — **OHV Destinations — optional client-side result retention** (DEFERRED — nice-to-have)
- KBD-1 — **Mobile chat input pushed off-screen on keyboard open** (OPEN — deferred (launch risk; **must precede any PWA work** — the 2026-09-01 review recommends a PWA, which would ship this bug to the home screen))
- MODIFY-RELIABILITY — **Modify-AI long-conversation reliability** — residual tag-emission reliability beyond item #3's mitigations (DEFERRED)
- REGEN-NONDESTRUCTIVE — **Non-destructive Regenerate** — preserve custom / checked activity states across an itinerary regenerate (DEFERRED — post-launch (review marked things-to-do WORKS; regenerate is still consented data loss, not prevented))
- FINISH-ORIGIN-PARITY — **Finish-origin server state-parity** — server computeTripShape compares city only (DEFERRED — minor backlog (still true at 862ce37))

## Done — verified
- 1 — **PDF lazy-loading** — `@react-pdf/renderer` (~1.5MB) code-split out of the main bundle
- 2 — **updateTrip footgun** — `TripUpdateSchema` permits `startDate`/`endDate`/`totalNights` raw write
- 3 — **Modify-AI long-conversation tag-loss** — model stops emitting `<modify>` tags as conversation grows — commits: b3994ff
- 4 — **Weather Tab live forecast** — `forecast_days` param + `.split()` date bug + canonical anchor probe
- 5 — **Weather per-stop live→historical fallback** — late stops in long live trips fall back instead of blanking
- 6 — **aiConversation silent 400** — dead client write + downstream surprise-trip exclusion query that depended on the same dead column
- 11 — **UTC-midnight arrival timezone artifact** in server-side weather path
- PR-2 — **Billing status contradicts invoice history** — "Free plan · no active subscription" rendered above three paid $7.99 invoices
- PR-8 — **Booking-form data validation** — "site" accepted as a site number (renders as "site #site"), "kbyyy" accepted as a licence plate
- PR-9 — **Display chips styled as controls** — "2 adults" / "both" party chips look tappable but are display-only
- PR-11 — **Public roadmap shows test entries** — "what is this test", "Testing Feedback Gmail Functionality" visible to every user
- PR-12 — **Journal photos: built end to end, blocked on storage**
- PR-13 — **Stale "Apply" card after reload** — a failed proposal card (e.g. duplicate-stop error) re-renders as applicable after the panel is reopened
- PR-14 — **Booking alternates' distance is relative to the primary, not the stop** — "54 mi from NavajoLand" when the primary is itself 25 mi from Tonalea
- PR-15 — **Drive-limit chip "×" hit target is ~15×17 px**
- CRON-1 — **Scheduler for `/internal/cron/*` in production** — trial-ending reminder AND the OHV link-checker were never being called
- FEAT-NAV-HANDOFF — **Navigation handoff — measured route into Google Maps / Apple Maps**
- TOOL-REPLAY — **Replay tool — a customer conversation becomes an exact-case planner test**
- FEAT-REPLAY-CASES — **Replay cases — saved from the Session Inspector, run by name, results written back**
- GRACE-DAY-COUNT — **Drive-day count uses cap + grace** — the daily limit is a guideline with a give-or-take, not a wall
- FEAT-PLANNER-FACTS — **Planner facts — the app measures, the AI talks** (feedback "Trip days total exceeded")
- BUG-ORIGIN-ASK-MARKDOWN — **"I couldn't find that location" after answering a nights question with a number**
- BUG-THIS-FRIDAY — **"this Friday" resolves to the wrong date** — replays on Wed 2026-09-02 mostly produced "Friday, September 6th, 2026" (a Sunday); once the correct Sept 4
- LVR-PROD — **"RV-safe routing absent" (review gap table)** — it is LIVE
- FIX-WEATHER-HINT — **Live forecast looked missing** — historical-averages card never said why
- FIX-CAMPGROUND-PROXIMITY — **Review #1 critical** — Tonalea, AZ recommended Coon Bluff Rec Area, 200 mi south in Mesa
- FIX-MODIFY-SWAP-RECHECK — **Review #2 critical** — "Applied ✓" for a change that did not take (swap X for Y left X on the trip)
- FEAT-TRIP-DRIVE-CAP — **Review: stated preferences silently overridden** — "under 4 hours" answered with "your 6-hour limit"
- BUG-1 — **Mobile placeholder truncation** — chat input placeholder text is cut off at mobile widths — commits: 1f36e00, 6461acc
- BUG-2 — **Trip-summary pill CTA** — the preview/booking pill call-to-action wording/affordance
- BUG-3 — **Stop count accuracy** — displayed stop count does not match the actual stops — commits: 9691bf1, 0718899
- BUG-4 — **Round-trip vs one-way prompt** — AI prompt mishandles round-trip vs one-way intent — commits: 1424435, 064b999, 26448ee, 611b958
- 7 — **Regenerate ConfirmModal gates** — destructive regenerate flows require confirmation
- 8 — **Share Trip** — end to end
- 9 — **Reservation Honesty Pass** — Book buttons open real `reservationUrl`, record confirmation #
- 10 — **Travel Party v1** — unified People + Pets at `/profile/party`
- 11b — **fmtDate cousin bug** — AI modify-mode prompt's `Dates:` line shifted UTC-midnight stop dates back a day in negative-offset deploy zones (documented cousin of #11)
- MESA-6b — **Modify-mode prompt example-city sweep** — swept hardcoded example cities from the modify-mode prompt — commits: e52c7f7
- MODIFY-UX-1 — **Three-state modify outcome** — distinguish clarify vs proposal vs failure — commits: c96f339
- GEO-1 — **Add-stop geographic bracketing** — an added stop must fall geographically between its bracketing stops (no overshoot) — commits: 6715744
- ANCHOR-1 — **Modify stop refs resolved by NAME** — not stop number; killed off-by-one inserts — commits: b023efe
- CAP-1 / 1b — **Honest context-aware hard-cap messages** — planning vs modify; removed false carryover promise — commits: 308ad81, b6eb8ac
- MIC-SEND-1 — **Send/Enter while mic listening** — mic stops cleanly on submit — commits: 6d70718
- RESET-1 — **Reopening "Modify with AI" starts a fresh session** — fixed permanent hard-cap lockout — commits: d135be4
- CAP-2 — **Conversation caps raised to SOFT 600 / HARD 1000** — commits: 31edef4
- RR38-1 — **Feedback pipeline** — user feedback capture + analysis
- RR38-2 — **FROM_EMAIL display name** — transactional sender shows a friendly name
- RR38-3 — **PDF export gate** — packing/trip PDF export is Pro-gated
- SCOPE-GUARD-2 — **Terse-opener scope-guard** — a first message that names a place but lacks 'plan a trip' wording was refused as off-topic — commits: 66b3718, dd511c8
- MODIFY-TRIPTYPE-1 — **Modify-mode keeps Trip.tripType accurate** — add/remove of a return-home leg updates the stored shape — commits: 53b3fa6, 611b958
- DOUBLE-FINISH — **Double closing FINISH row** — modify-added round trips rendered two 'FINISH {city}' rows in the itinerary — commits: de64dc0, 920feeb, d42b848
- HOME-ADDR-RUNG1 — **Home address geocode-on-save + auto-heal** — free-typed/autofilled address (no city/coords) wrongly read as 'no home' — commits: 088083f, a9c96c3
- HOME-ADDR-RUNG2 — **Home address pin-drop fallback** — when geocode-on-save fails, let the user place their home on a map — commits: 8c068fe, bb82b06
- HOME-ADDR-RUNG3 — **Pin-drop report link prefills feedback type** — 'Report this to us' opens the feedback modal as a bug report — commits: d6c004e, 5052b81
- HOME-ADDR-CHANGE-FLOW — **Change-my-address flow** — deletion didn't stick + stale coords saved next to new text — commits: fa5ad85, d09c2cf
- FINISH-ORIGIN-1 — **Origin-based finish/badge** — closing finish + map S/F pin matched the profile home instead of the trip's own origin — commits: 5f0e37c, 1c8ea84
- STOPS-PLURALIZATION — **Count pluralization** — '1 stops' (and '1 nights' / '1 days') read ungrammatically — commits: a2cc439, fe6817f
- IMP-MAPPIN-1 — **Overlapping Start/Finish pins + '1 stops'** — origin-loop trips stacked two pins at the origin and showed '1 stops' — commits: 1c8ea84, fe6817f
- 10b — **Travel Party Phase B / C**
- 13 — **Map click-to-popup centering** — pan camera so clicked stop's popup is fully visible
- 17 — **OHV link-checker — activation**
- INFRA-2 — Render cold-start mitigation — RESOLVED 2026-06-14

<!-- END GENERATED -->

<!-- SESSION NARRATIVE — fill this in at wrap time; the generator never touches below this line -->

## Working rules
- Beginner-level git/CLI: over-explain every command, name the exact directory, one thing at a time. Recommendation-first, no menus.
- All file work on a feature branch; merge --no-ff to local main; NEVER push (Benny pushes via save-progress.bat). Never kill processes — Benny restarts the backend himself.
- Phase 0 scout before building anything non-trivial; STOP and report before code.
- PowerShell runs .bat with .\name.bat, not bare name.
- **Docs:** edit `launch-status.json`, never `LAUNCH_STATUS.md` or the generated half of this file — `save-progress.bat` regenerates both on every push.

## What shipped this session (RR64, 2026-09-02)
- CRON-1 closed: `.github/workflows/cron.yml` (7d7e5f2) is the scheduler for `/internal/cron/*` — hourly trial-ending reminders, monthly OHV link check, manual `workflow_dispatch`. `CRON_SECRET` repo secret added by Benny; smoke run #1 green. Until today these endpoints had never been called in prod.
- launch-status.json port: the 2026-09-01 re-audit (PR-1..15, CRON-1, Fixed + Shipped sections) was being erased by the regen on every push. gen-status.mjs is now data-driven (`meta.intro`, `sections[]` with column specs); the re-audit lives in the JSON and survives pushes. Flipped to DONE: PR-2, PR-8, PR-9, PR-13, PR-14, PR-15, CRON-1, 10b (Phase B), 17.

## First actions next session
- Confirm prod clean: from C:\Users\aylie\roamready run `git log origin/main..main` (should be empty).
- Remaining order: PR-11 un-Public the two roadmap test rows (Benny, admin panel) → PR-12 S3 bucket for journal photos → FEAT-NAV-HANDOFF → remaining review bugs (PR-3..7, PR-10) → PR-1 Free-tier decision.
