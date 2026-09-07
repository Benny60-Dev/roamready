# RoamReady — Project Guidance for Claude

## node_modules / worktree safety (CRITICAL)

These rules exist because junctioning the shared `node_modules` into a git
worktree and then recursively deleting that worktree has repeatedly wiped the
real `node_modules/.bin` in the main checkout, breaking `vite` / `tsx` with
"not recognized" errors. Follow them without exception:

- **(a) Never junction or symlink `client/node_modules` or `server/node_modules`
  into a git worktree.** No `New-Item -ItemType Junction`, no `mklink`, no
  symlink of the shared `node_modules` into any second working tree.
- **(b) Never recursively delete a tree that contains a `node_modules` junction.**
  On Windows, `Remove-Item -Recurse` and `git worktree remove --force` follow the
  junction/reparse point and delete the contents of the REAL
  `node_modules/.bin`, which is what breaks `vite`/`tsx`. The packages survive but
  the `.bin` shims are gone.
- **(c) Prefer editing source in the main checkout on a short-lived branch.**
  Only use a git worktree if that worktree has its OWN freshly-installed
  `node_modules` (`npm install` inside it) — never a junction back to the main
  checkout's `node_modules`.
- **(d) If `vite` or `tsx` is ever "not recognized," the fix is `npm install` in
  the affected folder** (`client/` and/or `server/`). It is a tooling / `.bin`
  issue, NEVER a database problem. Do not investigate Postgres, migrations, or
  the Prisma client for a "command not recognized" error.

## Standard workflow for source-only edits

Work directly in the main checkout (`C:\Users\aylie\roamready`) — do NOT spin up
a worktree with a `node_modules` junction. Per change:

1. Create a short-lived branch off `main` in the main checkout.
2. Edit the source files.
3. Typecheck against the real, already-installed `node_modules`
   (e.g. `cd client && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`,
   or the server equivalent).
4. Commit on the branch.
5. Merge into local `main` with `--no-ff`.
6. Delete the branch.

Never push — the user tests and pushes manually.

## Related operational notes

- The server reads the **root** `.env`, not `server/.env`. Never clear or modify
  existing `.env` values; only add new variables.
- The user manages all dev-server starts/restarts personally. Do not kill,
  taskkill, PID-target, or port-scan processes.
- PostgreSQL runs as the Docker `postgres:15` container (`docker-compose.yml`,
  mapped `5432:5432`). If the DB is unreachable (`Can't reach database server at
  localhost:5432`), the fix is starting that container (`npm run docker:up`), not
  a code change.

## Collaboration SOP (how Claude works with Benny — enforce EVERY session)

This is the standing procedure. Follow it for every change — do NOT improvise
generic instructions.

0. **Session start: check open replay cases.** Run `npm run replay -- --list`
   (needs `.replay.env` + a running dev backend; or read Admin → Replay Cases
   on prod). OPEN cases are reproduced planner bugs waiting on a fix — surface
   them in the opening recap. `npm run replay -- --case <name>` re-runs one
   (real AI calls, cents per run — never in a loop).

1. **Scout read-only first.** Diagnose against the actual code (and, for customer
   bugs, against PRODUCTION via the read-only Diagnostics queries) before proposing
   anything. No writes while scouting.
2. **One named recommendation.** Present a single recommended action. Show mockups
   / side-by-side comparisons before ANY UI change — design decisions come back to
   Benny.
3. **Explicit approval.** Wait for Benny's go-ahead before building.
4. **Build on a short-lived branch** off `main` (see "Standard workflow for
   source-only edits" above): branch → edit → typecheck against the real
   `node_modules` → merge `--no-ff` into local `main` → delete branch.
5. **Claude never pushes, never runs prod migrations, never kills processes.**
   Benny is the only hands on prod.
6. **Hand over a commit message with every push pointer.** Any time Claude points
   Benny to a push, it includes the commit message in the same breath.
7. **Benny pushes via `save-progress.bat`** — that IS the prod deploy for both
   Render services (`roamready-api` server + `roamready-client` client).
8. **Pre-test gate.** Backend changes: Benny restarts the backend himself and
   confirms before it counts as done. AI changes: tested in a fresh planning
   session.

## Migrations (CRITICAL)

- **NEVER run `npm run db:migrate`** — it is wired to `prisma migrate dev`, the
  BANNED reset path.
- Apply a written migration with:
  `npx dotenv-cli -e .env -- npm run db:migrate:deploy --prefix server`, then
  `npm run db:generate --prefix server` (backend stopped first), then restart.
- Prod migrations for new tables are applied on the Render API deploy (Render
  migrate deploy or the Render Shell) — new code 500s until the table exists in
  prod. Claude never runs prod migrations; Benny does.

## Bug tracker

- Claude owns the `.xlsx` tracker exclusively. It lives in the repo folder but is
  gitignored (`/RoamReady_Bug_Tracker_*.xlsx`) so `save-progress` never commits it.
- Three core tabs: Bug Tracker, Features & Roadmap, Launch Status. Stoplight fills
  on Status only; Arial, RV-Blue titles, white-on-blue header, frozen top row,
  gridlines off.

## Running the TS assertion tests from Cowork

`npx tsx` cannot run from the Cowork Linux VM (Windows esbuild binary). Use the
repo loader instead — it transpiles with the project's own TypeScript and stubs
utils/prisma + utils/redis:

    cd client && node --import ../scripts/ts-test-register.mjs src/utils/__tests__/rr69.test.ts
    cd server && RESEND_API_KEY=x STRIPE_SECRET_KEY=x JWT_SECRET=x TS_PATH=$PWD/node_modules/typescript \
      node --import ../scripts/ts-test-register.mjs src/services/__tests__/rr69.test.ts

Run them before every merge that touches the tested logic (tripTotals, rigs,
calendar block, replay lifecycle, hazard corridor). Benny on Windows keeps
using `npx tsx`.

## Editing files through the Cowork mount

When an edit makes a file SHORTER, the mount can leave trailing NUL padding after
the real content — this breaks `tsc` with TS1127 "Invalid character" at EOF. After
any shrinking edit, strip trailing NULs and re-typecheck before committing.
