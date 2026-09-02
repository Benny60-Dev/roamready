# Replays — exact-case planner tests

A replay is a real customer conversation reduced to the user's turns, re-run
against the dev API so the same input can be tested every time the planner
changes. Capture one from Admin → Session Inspector → **Copy replay**, save it
here, add `expect` checks, run:

```
.\get-token.ps1                                  # once per PowerShell window
npm run replay -- server/replays/del-rio-nights.json
```

Real AI + Directions calls — a run costs a few cents and is never automatic.
See scripts/replay-session.mjs for the file shape and the check vocabulary.
