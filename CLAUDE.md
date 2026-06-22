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
