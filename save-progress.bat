@echo off
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

echo Staging all changes...
git add -A

echo.
set /p msg="Commit message (or press Enter for timestamp): "

if "%msg%"=="" (
    for /f "tokens=1-4 delims=/ " %%a in ('date /t') do set today=%%a-%%b-%%c-%%d
    for /f "tokens=1-2 delims=: " %%a in ('time /t') do set now=%%a%%b
    set msg=Progress save - %today% %now%
)

echo Committing with message: %msg%
git commit -m "%msg%"

echo.
echo Pushing to GitHub...
git push

echo.
echo ============================================
echo  All saved! Your work is safe on your
echo  computer and GitHub!
echo ============================================
pause