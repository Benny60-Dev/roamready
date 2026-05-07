@echo off
title RoamReady - SHUTDOWN
color 4F
setlocal EnableDelayedExpansion

echo.
echo  ============================================
echo    === RoamReady SHUTDOWN ===
echo  ============================================
echo    Status : Shutting down all services...
echo  ============================================
echo.

REM -- 1. Close the RoamReadyDev Windows Terminal window via saved PID --
echo [1/4] Closing RoamReady Windows Terminal window...
if exist "%TEMP%\roamready-wt.pid" (
    set /p WT_PID=<"%TEMP%\roamready-wt.pid"
    if defined WT_PID (
        echo       Stopping Windows Terminal PID !WT_PID!
        taskkill /F /PID !WT_PID! >nul 2>&1
        del "%TEMP%\roamready-wt.pid" >nul 2>&1
    )
    echo       Done - terminal window closed.
) else (
    echo       No saved Windows Terminal PID found - skipping.
)

REM -- 2. Kill anything still listening on dev ports (3000, 3001) --
echo [2/4] Killing leftover processes on ports 3000 and 3001...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
    echo       Killing PID %%a on port 3001
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    echo       Killing PID %%a on port 3000
    taskkill /F /PID %%a >nul 2>&1
)
echo       Done - dev ports cleared.

REM -- 3. Kill any remaining Node processes (releases Prisma engine DLL) --
echo [3/4] Killing any remaining Node processes...
taskkill /F /IM node.exe >nul 2>&1
echo       Done - leftover Node processes terminated.

REM -- 4. Stop Docker containers --
echo [4/4] Stopping Docker containers...
cd /d "C:\Users\aylie\roamready"
docker-compose down
if errorlevel 1 (
    echo       WARNING: docker-compose down encountered an error. Containers may still be running.
) else (
    echo       Done - Docker containers stopped.
)

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

REM -- Auto-close this shutdown window --
timeout /t 4 /nobreak >nul
exit /b 0
