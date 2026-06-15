# Session Handoff
<!-- GENERATED FROM launch-status.json — do not hand-edit this section; it is overwritten on every regen -->

**Status as of 2026-06-05** — verified against `main` @ `7d5578d`.

## Open items
- BUG-1 — **Mobile placeholder truncation** — chat input placeholder text is cut off at mobile widths (**OPEN — P1**)
- BUG-2 — **Trip-summary pill CTA** — the booking pill call-to-action wording/affordance needs work (**OPEN — P2**)
- BUG-3 — **Stop count accuracy** — displayed stop count does not match the actual stops (**OPEN — P1**)
- BUG-4 — **Round-trip vs one-way prompt** — AI prompt mishandles round-trip vs one-way intent (**OPEN — P2**)

## Deferred / post-launch
- 10b — **Travel Party Phase B / C** (DEFERRED)
- 12 — **iOS Safari zoom-stuck bug** (PARTIAL — multiple mitigations shipped; specific bug-reproduction not in evidence)
- 14 — **OHV/off-road destinations: own data source** (DEFERRED — post-launch)
- 15 — **OHV Destinations — code-split the page with `lazy()`** (DEFERRED — low priority)
- 16 — **OHV Destinations — optional client-side result retention** (DEFERRED — nice-to-have)
- 17 — **OHV link-checker — activation** (DEFERRED — post-launch)

## Done — verified
- 1 — **PDF lazy-loading** — `@react-pdf/renderer` (~1.5MB) code-split out of the main bundle
- 2 — **updateTrip footgun** — `TripUpdateSchema` permits `startDate`/`endDate`/`totalNights` raw write
- 3 — **Modify-AI long-conversation tag-loss** — model stops emitting `<modify>` tags as conversation grows — commits: b3994ff
- 4 — **Weather Tab live forecast** — `forecast_days` param + `.split()` date bug + canonical anchor probe
- 5 — **Weather per-stop live→historical fallback** — late stops in long live trips fall back instead of blanking
- 6 — **aiConversation silent 400** — dead client write + downstream surprise-trip exclusion query that depended on the same dead column
- 11 — **UTC-midnight arrival timezone artifact** in server-side weather path
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
- 13 — **Map click-to-popup centering** — pan camera so clicked stop's popup is fully visible

<!-- END GENERATED -->

<!-- SESSION NARRATIVE — fill this in at wrap time; the generator never touches below this line -->

## Working rules
<!-- hint: standing rules for how to work this session — env safety, git flow, what not to touch -->

## What shipped this session (prose)
<!-- hint: narrative of what changed this session and why, in your own words -->

## Watch / lessons logged
<!-- hint: gotchas, near-misses, and lessons to carry into next session -->

## First actions next session
<!-- hint: the first concrete steps to take when you resume -->
