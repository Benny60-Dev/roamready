@echo off
title RoamReady - Startup

echo ============================================
echo  RoamReady - Starting all services...
echo ============================================

REM ── 1. Check if Docker Desktop is running ──
echo Checking Docker Desktop...
docker info >nul 2>&1
if errorlevel 1 (
    echo Docker Desktop is not running. Attempting to start it...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo Waiting 20 seconds for Docker Desktop to initialise...
    timeout /t 20 /nobreak >nul
    docker info >nul 2>&1
    if errorlevel 1 (
        echo ERROR: Docker Desktop failed to start. Please start it manually and re-run this script.
        pause
        exit /b 1
    )
)
echo Docker Desktop is running.

REM ── 2. Verify root .env exists (single source of truth for all env vars) ──
if not exist "C:\Users\aylie\roamready\.env" (
    echo ERROR: Root .env file not found at C:\Users\aylie\roamready\.env
    echo This is the master env file — all services read from it.
    pause
    exit /b 1
)
echo Root .env found.

REM ── 3. Start database containers ──
echo Starting database containers...
cd /d "C:\Users\aylie\roamready"
docker-compose up -d
if errorlevel 1 (
    echo ERROR: docker-compose failed to start containers.
    pause
    exit /b 1
)
echo Database containers started.

REM ── 4. Open Backend terminal ──
echo Opening Backend terminal...
start "RoamReady - Backend" cmd /k "title RoamReady — Backend && cd /d C:\Users\aylie\roamready\server && npm run dev"

REM ── 5. Open Frontend terminal ──
echo Opening Frontend terminal...
start "RoamReady - Frontend" cmd /k "title RoamReady — Frontend && cd /d C:\Users\aylie\roamready\client && npm run dev"

REM ── 6. Open Claude Code terminal ──
echo Opening Claude Code terminal...
start "RoamReady - Claude Code" cmd /k "title RoamReady — Claude Code && cd /d C:\Users\aylie\roamready && claude"

REM ── 7. Wait 8 seconds then open browser ──
echo Waiting 8 seconds for services to start...
timeout /t 8 /nobreak >nul
echo Opening http://localhost:3000 in default browser...
start http://localhost:3000

echo ============================================
echo  RoamReady is running!
echo   Backend  : http://localhost:3001  (or check backend terminal)
echo   Frontend : http://localhost:3000
echo   Database : PostgreSQL on port 5432
echo   Cache    : Redis on port 6379
echo ============================================
