@echo off
title RoamReady - SHUTDOWN
color 4F

echo.
echo  ============================================
echo    === RoamReady SHUTDOWN ===
echo  ============================================
echo    Status : Shutting down all services...
echo  ============================================
echo.

REM -- 1. Close named terminal windows --
echo [1/3] Closing terminal windows...
taskkill /fi "WindowTitle eq RoamReady - BACKEND*" /f >nul 2>&1
taskkill /fi "WindowTitle eq RoamReady - FRONTEND*" /f >nul 2>&1
taskkill /fi "WindowTitle eq RoamReady - CLAUDE CODE*" /f >nul 2>&1
echo       Done - terminal windows closed.

REM -- 1b. Kill any remaining Node processes (releases Prisma engine DLL) --
echo [1b/3] Killing any remaining Node processes...
taskkill /F /IM node.exe >nul 2>&1
echo       Done - leftover Node processes terminated.

REM -- 2. Stop Docker containers --
echo [2/3] Stopping Docker containers...
cd /d "C:\Users\aylie\roamready"
docker-compose down
if errorlevel 1 (
    echo       WARNING: docker-compose down encountered an error. Containers may still be running.
) else (
    echo       Done - Docker containers stopped.
)

echo [3/3] Cleanup complete.
echo.
echo  ============================================
echo    RoamReady has been shut down.
echo  ============================================
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
