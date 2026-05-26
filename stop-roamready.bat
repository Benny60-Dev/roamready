@echo off
setlocal
title RoamReady - Stop
color 07
echo ============================================
echo  RoamReady - Stopping all services...
echo ============================================

REM -- 1. Kill anything on port 3001 (backend) --
REM    This kills only the node process. The cmd /k window hosting it stays
REM    alive at a prompt in C:\Users\aylie\roamready\server so you can press
REM    UP-ARROW then ENTER to re-run `npm run dev` whenever you're ready.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
    echo Killing PID %%a on port 3001
    taskkill /F /PID %%a >nul 2>&1
)

REM -- 2. Kill anything on port 3000 (frontend) -- same window-survives behavior
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    echo Killing PID %%a on port 3000
    taskkill /F /PID %%a >nul 2>&1
)

timeout /t 2 /nobreak >nul

REM -- 3. Stop the database containers (pairs with `docker-compose up -d` in start-roamready.bat) --
echo Stopping database containers...
cd /d "C:\Users\aylie\roamready"
docker-compose stop

echo ============================================
echo  RoamReady stopped.
echo   Backend  : down  (window still open, press UP then ENTER to re-run)
echo   Frontend : down  (window still open, press UP then ENTER to re-run)
echo   Database : PostgreSQL stopped
echo   Cache    : Redis stopped
echo ============================================
