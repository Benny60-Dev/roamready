@echo off
setlocal

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

REM -- 3. Brief pause to let the OS fully release the ports --
timeout /t 2 /nobreak >nul

REM -- 4. Relaunch the stack. No detached cmd needed: we no longer kill the
REM    Windows Terminal host, so this script's own window survives and a plain
REM    `call` works.
echo Launching start-roamready.bat...
call "C:\Users\aylie\roamready\start-roamready.bat"

exit /b 0
