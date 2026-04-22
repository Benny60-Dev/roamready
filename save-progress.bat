@echo off
echo.
echo ============================================
echo  Saving your RoamReady progress...
echo ============================================
echo.
cd /d C:\Users\aylie\roamready

echo Staging all changes...
git add -A

echo.
set /p msg="Commit message (or press Enter for timestamp): "

if "%msg%"=="" (
    for /f "tokens=1-4 delims=/ " %%a in ('date /t') do set today=%%a-%%b-%%c-%%d
    for /f "tokens=1-2 delims=: " %%a in ('time /t') do set now=%%a%%b
    set msg=Progress save - %today% %now%
)

echo Committing with message: %msg%
git commit -m "%msg%"

echo.
echo Pushing to GitHub...
git push

echo.
echo ============================================
echo  All saved! Your work is safe on your
echo  computer and GitHub!
echo ============================================
pause