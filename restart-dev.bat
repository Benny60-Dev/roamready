@echo off
setlocal EnableDelayedExpansion

echo.
echo === RoamReady Restart ===
echo.

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

REM -- 4. Wait for the OS to fully release the killed window before relaunching --
timeout /t 3 /nobreak >nul

REM -- 5. Re-launch start-roamready.bat in this same cmd session --
echo Launching start-roamready.bat...
call "C:\Users\aylie\roamready\start-roamready.bat"

REM -- Auto-close this restart window once start-roamready returns --
timeout /t 2 /nobreak >nul
exit /b 0
