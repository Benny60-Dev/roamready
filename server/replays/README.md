# Replays — exact-case planner tests

A replay is a real customer conversation reduced to the user's turns, re-run
against the dev API so the same input can be tested every time the planner
changes.

**Saved cases (the normal path).** Admin → Session Inspector → **Save as replay
case** (asks "What went wrong?"). The case lives in the `ReplayCase` table and
shows on Admin → Replay Cases, where **▶ Run** replays it on the server with live
progress and a saved transcript. The same run from the repo, by name:

```
npm run replay -- --list                          # what exists (Open / Passing / Fixed)
npm run replay -- --case del-rio-nights           # run a saved case on dev
npm run replay -- --case del-rio-nights --base https://roamready.ai   # on prod
```

Status: OPEN (bug reproduced) → PASSING (auto, when every check passes) →
FIXED (Benny). To add `expect` checks to a saved case today: Copy JSON on the
page → save the file here → run the file path.

**Files (hand-written cases).** Save a JSON here, add `expect` checks, run:

```
.\get-token.ps1                                  # once per PowerShell window (or .replay.env)
npm run replay -- server/replays/del-rio-nights.json
```

Real AI + Directions calls — a run costs a few cents and is never automatic.
See scripts/replay-session.mjs for the file shape and the check vocabulary.
