@echo off
echo.
echo === Killing existing dev servers on ports 3000 and 3001 ===
echo.

REM Kill anything on port 3001 (backend)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
    echo Killing PID %%a on port 3001
    taskkill /F /PID %%a >nul 2>&1
)

REM Kill anything on port 3000 (frontend)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    echo Killing PID %%a on port 3000
    taskkill /F /PID %%a >nul 2>&1
)

timeout /t 2 /nobreak >nul

echo.
echo === Starting backend (port 3001) ===
start "Roamready Backend" powershell -NoExit -Command "cd 'C:\Users\aylie\roamready\server'; npm run dev"

timeout /t 2 /nobreak >nul

echo.
echo === Starting frontend (port 3000) ===
start "Roamready Frontend" powershell -NoExit -Command "cd 'C:\Users\aylie\roamready\client'; npm run dev"

echo.
echo === Both servers launching in separate windows ===
echo You can close this window.
timeout /t 3 /nobreak >nul