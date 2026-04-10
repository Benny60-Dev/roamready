@echo off
title RoamReady - Shutdown

echo ============================================
echo  RoamReady - Shutting down all services...
echo ============================================

REM ── 1. Close named terminal windows ──
echo Closing terminal windows...
taskkill /fi "WindowTitle eq RoamReady — Backend*" /f >nul 2>&1
taskkill /fi "WindowTitle eq RoamReady — Frontend*" /f >nul 2>&1
taskkill /fi "WindowTitle eq RoamReady — Claude Code*" /f >nul 2>&1
echo Terminal windows closed.

REM ── 2. Stop Docker containers ──
echo Stopping Docker containers...
cd /d "C:\Users\aylie\roamready"
docker-compose down
if errorlevel 1 (
    echo WARNING: docker-compose down encountered an error. Containers may still be running.
) else (
    echo Docker containers stopped.
)

echo ============================================
echo  RoamReady has been shut down.
echo ============================================
echo.
echo ============================================
echo  REMINDER: Before closing, save your work!
echo ============================================
echo  git add .
echo  git commit -m "your message here"
echo  git push
echo.
echo  This saves your work to both your
echo  computer and GitHub.
echo ============================================
echo.
timeout /t 5 /nobreak >nul
