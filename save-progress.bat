@echo off
title RoamReady - Save Progress

echo ============================================
echo  Saving your RoamReady progress...
echo ============================================
echo.

REM ── Stage all changes ──
echo Staging all changes...
cd /d "C:\Users\aylie\roamready"
git add .
if errorlevel 1 (
    echo ERROR: git add failed.
    pause
    exit /b 1
)

REM ── Build timestamp for commit message ──
REM  Uses PowerShell to format: "Progress save - April 9 2026 3:45pm"
for /f "delims=" %%T in ('powershell -NoProfile -Command "Get-Date -Format \"MMMM d yyyy h:mmtt\" | ForEach-Object { $_.ToLower() -replace 'am$','am' -replace 'pm$','pm' }"') do set TIMESTAMP=%%T

REM ── Commit ──
echo Committing with message: Progress save - %TIMESTAMP%
git commit -m "Progress save - %TIMESTAMP%"
if errorlevel 1 (
    echo.
    echo Nothing new to save - your work was already up to date!
    echo.
    pause
    exit /b 0
)

REM ── Push to GitHub ──
echo Pushing to GitHub...
git push
if errorlevel 1 (
    echo.
    echo WARNING: Push to GitHub failed.
    echo Your work IS saved on this computer, but not yet on GitHub.
    echo Check your internet connection and try again.
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  All saved! Your work is safe on your
echo  computer and GitHub!
echo ============================================
echo.
pause
