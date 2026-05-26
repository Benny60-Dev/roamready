@echo off
setlocal

echo.
echo === RoamReady Restart ===
echo.

REM -- 1. Schedule the relaunch in a DETACHED cmd BEFORE we call stop.
REM    stop-roamready.bat force-kills the saved WindowsTerminal.exe PID, which
REM    on Win11 can take down every WT-hosted window. We run from a desktop
REM    shortcut (own cmd window, outside the WT), but the detached spawn here
REM    is belt-and-suspenders: it survives the WT teardown no matter what.
REM    The 6s wait gives stop time to: kill ports 3000/3001, close the WT
REM    window, and run `docker-compose stop` before start-roamready.bat tries
REM    to bring everything back up.
echo Scheduling relaunch of start-roamready.bat in ~6s...
start "RoamReady Relaunch" cmd /c "timeout /t 6 /nobreak >nul && call C:\Users\aylie\roamready\start-roamready.bat"

REM -- 2. Brief pause so the detached relauncher is fully spawned before stop --
timeout /t 1 /nobreak >nul

REM -- 3. Tear everything down (kills :3000/:3001, closes WT, docker-compose stop) --
echo Calling stop-roamready.bat...
call "C:\Users\aylie\roamready\stop-roamready.bat"

exit /b 0
