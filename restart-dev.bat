@echo off
setlocal

echo.
echo === RoamReady - Quick dev-server restart ===
echo.

REM -- Kill the backend node process (port 3001). The cmd /k window hosting it
REM    stays alive at a prompt — see start-roamready.bat. Docker stays running.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
    echo Killing PID %%a on port 3001 (backend)
    taskkill /F /PID %%a >nul 2>&1
)

REM -- Kill the frontend node process (port 3000). Same window-survives behavior.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    echo Killing PID %%a on port 3000 (frontend)
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo ============================================
echo  Dev servers stopped. Database still running.
echo.
echo  To restart:
echo   1. Switch to the BACKEND tab in Windows Terminal
echo   2. Press UP-ARROW then ENTER (re-runs npm run dev)
echo   3. Switch to the FRONTEND tab
echo   4. Press UP-ARROW then ENTER
echo ============================================

timeout /t 3 /nobreak >nul
exit /b 0
