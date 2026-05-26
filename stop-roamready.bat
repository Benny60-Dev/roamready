@echo off
setlocal EnableDelayedExpansion
title RoamReady - Stop
color 07
echo ============================================
echo  RoamReady - Stopping all services...
echo ============================================

REM -- 1. Kill anything on port 3001 (backend) --
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
    echo Killing PID %%a on port 3001
    taskkill /F /PID %%a >nul 2>&1
)

REM -- 2. Kill anything on port 3000 (frontend) --
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    echo Killing PID %%a on port 3000
    taskkill /F /PID %%a >nul 2>&1
)

timeout /t 2 /nobreak >nul

REM -- 3. Close the existing RoamReadyDev Windows Terminal window via saved PID --
if exist "%TEMP%\roamready-wt.pid" (
    set /p WT_PID=<"%TEMP%\roamready-wt.pid"
    if defined WT_PID (
        echo Stopping Windows Terminal PID !WT_PID!
        taskkill /F /PID !WT_PID! >nul 2>&1
        del "%TEMP%\roamready-wt.pid" >nul 2>&1
    )
)

REM -- 4. Stop the database containers (pairs with `docker-compose up -d` in start-roamready.bat) --
echo Stopping database containers...
cd /d "C:\Users\aylie\roamready"
docker-compose stop

echo ============================================
echo  RoamReady stopped.
echo   Backend  : down
echo   Frontend : down
echo   Database : PostgreSQL stopped
echo   Cache    : Redis stopped
echo ============================================
