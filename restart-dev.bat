@echo off
setlocal

echo.
echo === RoamReady - Stop + relaunch dev servers ===
echo.

REM ===========================================================================
REM  WHY THE PREVIOUS VERSION KILLED ITSELF BEFORE RELAUNCHING
REM  On Windows 11 the default terminal is Windows Terminal, and ONE
REM  WindowsTerminal.exe process hosts EVERY window (single-process, multi-
REM  window). That one process hosts both the RoamReady dev window AND the new
REM  window that opens when you double-click THIS script. The old step 2 did
REM  `taskkill /F /T` on the saved WindowsTerminal PID -> it killed that shared
REM  process, which terminated restart-dev.bat itself before it reached the
REM  relaunch line. So the first double-click only stopped + closed; you had to
REM  double-click again (by then the old WT PID was dead, so the kill no-oped
REM  and the relaunch finally ran).
REM
REM  FIX: never kill WindowsTerminal.exe. Stop the servers by port, then close
REM  the OLD dev window by closing only ITS tab processes (the backend/frontend
REM  cmd /k tabs + the shell tab), matched by their launch signatures and
REM  excluding this script's own PID. That closes the dev window while leaving
REM  the WindowsTerminal process (and this script's console) alive, so we reach
REM  the relaunch. The relaunch uses `start ""`, so the new window is detached
REM  and survives after this script exits.
REM
REM  Docker / Postgres / Redis are intentionally NOT touched.
REM  Double-click this from Explorer.
REM ===========================================================================

REM -- 1. Free the ports: kill the whole node tree on 3000/3001. The port-holder
REM    is a leaf under a supervisor (backend = tsx watch, which respawns its
REM    child instantly; frontend = vite under npm), so we climb to the top-most
REM    node.exe ancestor and taskkill /F /T it -> supervisor dies, no respawn.
echo Stopping dev servers on ports 3000 and 3001...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports=3000,3001; foreach($port in $ports){ $h=(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique; foreach($pp in $h){ if(-not $pp){continue}; $cur=$pp; while($true){ $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$cur) -ErrorAction SilentlyContinue; if(-not $proc -or $proc.Name -ne 'node.exe'){break}; $par=Get-CimInstance Win32_Process -Filter ('ProcessId='+$proc.ParentProcessId) -ErrorAction SilentlyContinue; if($par -and $par.Name -eq 'node.exe'){$cur=$par.ProcessId}else{break} }; Write-Host ('  port '+$port+' -> stopping node tree at PID '+$cur); taskkill /F /T /PID $cur | Out-Null } }"

REM -- 2. Close the OLD dev window by closing ONLY its tab processes (NOT the
REM    shared WindowsTerminal.exe). $me excludes this PowerShell so it can't kill
REM    itself; the script's own cmd window has none of these signatures so it
REM    survives. When the dev window's last tab closes, that window closes.
echo Closing the previous dev window...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$me=$PID; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -and ( $_.CommandLine -like '*BACKEND :3001*' -or $_.CommandLine -like '*FRONTEND :3000*' -or ($_.CommandLine -like '*-NoExit*' -and $_.CommandLine -like '*cd C:\Users\aylie\roamready*') ) } | ForEach-Object { Write-Host ('  closing dev tab PID ' + $_.ProcessId + ' (' + $_.Name + ')'); taskkill /F /T /PID $_.ProcessId | Out-Null }"

REM -- 3. Drop the stale PID file and let Windows release the TCP listeners.
if exist "%TEMP%\roamready-wt.pid" del /q "%TEMP%\roamready-wt.pid" >nul 2>&1
timeout /t 2 /nobreak >nul

REM -- 4. Relaunch backend + frontend + shell, DETACHED, exactly as
REM    start-roamready.bat does (same working dirs, npm run dev, titles/colors).
REM    `start ""` makes the new Windows Terminal window independent of this
REM    script, so it keeps running after restart-dev.bat exits.
echo Relaunching dev servers...
start "" wt.exe --window RoamReadyDev --title "BACKEND :3001" --tabColor "#4682B4" cmd /k "title BACKEND :3001 && color 1F && cd /d C:\Users\aylie\roamready\server && npm run dev" ^; new-tab --title "FRONTEND :3000" --tabColor "#3CB371" cmd /k "title FRONTEND :3000 && color 2F && cd /d C:\Users\aylie\roamready\client && npm run dev" ^; new-tab --title "SHELL" --tabColor "#A9A9A9" powershell.exe -NoExit -Command "cd C:\Users\aylie\roamready"

REM -- 5. Capture the new Windows Terminal PID (parity with start-roamready.bat).
echo Capturing Windows Terminal PID...
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "(Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1).Id | Out-File -FilePath \"$env:TEMP\roamready-wt.pid\" -Encoding ASCII -NoNewline"

echo.
echo ============================================
echo  Dev servers relaunched in a fresh window.
echo   Backend  : http://localhost:3001
echo   Frontend : http://localhost:3000
echo   Database : left running (Docker untouched)
echo ============================================

timeout /t 3 /nobreak >nul
exit /b 0
