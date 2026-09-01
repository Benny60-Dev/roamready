@echo off
REM  Delayed expansion so commit messages containing > or < can't act as
REM  shell redirects (an unquoted `echo %msg%` once dumped the message into
REM  stray files named after the redirect targets, e.g. a file "Google"
REM  from "LVR->HERE->Google", which then got committed by `git add -A`).
REM  Trade-off: a literal ! in a typed message will be swallowed.
setlocal EnableDelayedExpansion
REM  IMPORTANT: this repo must NEVER run with core.autocrlf=true. Prisma
REM  migration checksums are byte hashes; CRLF rewrites break them and
REM  `migrate dev` then offers a destructive DB reset. The repo-local git
REM  config pins core.autocrlf=false and .gitattributes pins
REM  prisma/migrations/**/*.sql to eol=lf — do not override either.
echo.
echo ============================================
echo  Saving your RoamReady progress...
echo ============================================
echo.
cd /d C:\Users\aylie\roamready

REM -- EOL preflight: hard-fail before committing if any migration SQL has
REM    CRLF endings (see scripts/check-migration-eol.js for the full story).
node scripts\check-migration-eol.js
if errorlevel 1 (
    echo.
    echo  COMMIT ABORTED — fix the CRLF migration files listed above first.
    echo  Run:  npm run preflight   after fixing to confirm.
    echo.
    pause
    exit /b 1
)

REM -- Regenerate the launch docs (LAUNCH_STATUS.md + SESSION_HANDOFF.md) from
REM    launch-status.json BEFORE `git add -A`, so any refreshed output is staged
REM    naturally by the add below — no separate re-stage needed.
REM    FAIL-SAFE: unlike the EOL preflight above (which MUST hard-abort), a doc
REM    regen failure is not worth blocking a code save. If status:gen exits
REM    non-zero, warn and commit anyway. `call` is required so the .bat resumes
REM    after npm returns instead of terminating.
echo Regenerating launch docs (status:gen)...
call npm run status:gen
if errorlevel 1 (
    echo WARNING: status:gen failed — committing without regenerating docs
)

echo Staging all changes...
git add -A

echo.
set /p msg="Commit message (or press Enter for timestamp): "

if "%msg%"=="" (
    for /f "tokens=1-4 delims=/ " %%a in ('date /t') do set today=%%a-%%b-%%c-%%d
    for /f "tokens=1-2 delims=: " %%a in ('time /t') do set now=%%a%%b
    REM !vars! not %vars%: today/now are set inside this same block, so
    REM percent-expansion would read them BEFORE they exist (parse time).
    set msg=Progress save - !today! !now!
)

echo Committing with message: !msg!
git commit -m "!msg!"

echo.
echo Pushing to GitHub...
git push

echo.
echo ============================================
echo  All saved! Your work is safe on your
echo  computer and GitHub!
echo ============================================
pause