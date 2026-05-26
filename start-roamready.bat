@echo off
title RoamReady - Startup
color 07

echo ============================================
echo  RoamReady - Starting all services...
echo ============================================

REM -- 1. Check if Docker Desktop is running --
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

REM -- 2. Verify root .env exists (single source of truth for all env vars) --
if not exist "C:\Users\aylie\roamready\.env" (
    echo ERROR: Root .env file not found at C:\Users\aylie\roamready\.env
    echo This is the master env file - all services read from it.
    pause
    exit /b 1
)
echo Root .env found.

REM -- 3. Start database containers --
echo Starting database containers...
cd /d "C:\Users\aylie\roamready"
docker-compose up -d
if errorlevel 1 (
    echo ERROR: docker-compose failed to start containers.
    pause
    exit /b 1
)
echo Database containers started.

REM -- 4. Open Backend + Frontend + Shell as three tabs in one Windows Terminal --
echo Opening Windows Terminal with Backend, Frontend, and Shell tabs...
start "" wt.exe --window RoamReadyDev --title "BACKEND :3001" --tabColor "#4682B4" cmd /k "title BACKEND :3001 && color 1F && cd /d C:\Users\aylie\roamready\server && npm run dev" ^; new-tab --title "FRONTEND :3000" --tabColor "#3CB371" cmd /k "title FRONTEND :3000 && color 2F && cd /d C:\Users\aylie\roamready\client && npm run dev" ^; new-tab --title "SHELL" --tabColor "#A9A9A9" powershell.exe -NoExit -Command "cd C:\Users\aylie\roamready"

REM -- 4b. Capture the new Windows Terminal host PID for restart-dev.bat to find later --
echo Capturing Windows Terminal PID...
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "(Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1).Id | Out-File -FilePath \"$env:TEMP\roamready-wt.pid\" -Encoding ASCII -NoNewline"

REM -- 5. Wait 8 seconds then open browser --
echo Waiting 8 seconds for services to start...
timeout /t 8 /nobreak >nul
echo Opening http://localhost:3000 in default browser...
start http://localhost:3000

echo ============================================
echo  RoamReady is running!
echo   Backend  : http://localhost:3001
echo   Frontend : http://localhost:3000
echo   Database : PostgreSQL on port 5432
echo   Cache    : Redis on port 6379
echo ============================================
echo.
echo  Windows Terminal tabs:
echo    Tab 1 = Backend  (port 3001)
echo    Tab 2 = Frontend (port 3000)
echo    Tab 3 = Shell    (project root PowerShell)
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
