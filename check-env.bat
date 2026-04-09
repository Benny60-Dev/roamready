@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  RoamReady — Environment Variable Checker
REM  Reads roamready\.env and verifies all required keys
REM  are present and non-empty.
REM
REM  Run from the roamready root folder:
REM    check-env.bat
REM ============================================================

set ENV_FILE=%~dp0.env
set PASS=0
set FAIL=0

if not exist "%ENV_FILE%" (
    echo [ERROR] .env file not found at: %ENV_FILE%
    exit /b 1
)

echo.
echo ============================================================
echo  RoamReady Environment Check
echo  Reading: %ENV_FILE%
echo ============================================================
echo.

REM --- Required keys (server will not function without these) ---
echo [REQUIRED]
call :CHECK_KEY "ANTHROPIC_API_KEY"     "AI trip planner / itinerary"
call :CHECK_KEY "DATABASE_URL"          "PostgreSQL connection"
call :CHECK_KEY "JWT_SECRET"            "Authentication tokens"
call :CHECK_KEY "JWT_REFRESH_SECRET"    "Token refresh"

echo.
echo [IMPORTANT - features broken if missing]
call :CHECK_KEY "GOOGLE_CLIENT_ID"      "Google OAuth login"
call :CHECK_KEY "GOOGLE_CLIENT_SECRET"  "Google OAuth login"
call :CHECK_KEY "STRIPE_SECRET_KEY"     "Payments / subscriptions"
call :CHECK_KEY "GOOGLE_MAPS_API_KEY"   "Maps and routing"
call :CHECK_KEY "RESEND_API_KEY"        "Password reset emails"

echo.
echo [OPTIONAL - features degraded if missing]
call :CHECK_KEY "STRIPE_WEBHOOK_SECRET"         "Stripe webhook events"
call :CHECK_KEY "RECGOV_API_KEY"                "Live campground search (uses mock data)"
call :CHECK_KEY "OPENWEATHER_API_KEY"           "Legacy weather (replaced by Open-Meteo)"
call :CHECK_KEY "AWS_ACCESS_KEY_ID"             "Photo uploads to S3"
call :CHECK_KEY "AWS_SECRET_ACCESS_KEY"         "Photo uploads to S3"

echo.
echo ============================================================
echo  Results: %PASS% present   %FAIL% missing/empty
echo ============================================================
echo.

if %FAIL% GTR 0 (
    echo  [!] Fix missing values in roamready\.env then restart the server.
    echo.
    exit /b 1
) else (
    echo  [OK] All checked environment variables are present.
    echo.
    exit /b 0
)

REM ── Subroutine ──────────────────────────────────────────────
:CHECK_KEY
set KEY=%~1
set DESC=%~2
set FOUND=0
set VALUE=

for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    set LINE=%%A
    REM Strip leading spaces
    set LINE=!LINE: =!
    if "!LINE!"=="%KEY%" (
        set VALUE=%%B
        set FOUND=1
    )
)

REM Strip quotes and whitespace from value
set VALUE=%VALUE:"=%
set VALUE=%VALUE: =%

if %FOUND%==0 (
    echo   [MISSING ]  %KEY%  (%DESC%)
    set /a FAIL+=1
) else if "!VALUE!"=="" (
    echo   [EMPTY   ]  %KEY%  (%DESC%)
    set /a FAIL+=1
) else (
    REM Show length of value rather than the value itself
    set LEN=0
    set STR=!VALUE!
    :LENLOOP
    if not "!STR!"=="" (
        set STR=!STR:~1!
        set /a LEN+=1
        goto LENLOOP
    )
    echo   [OK  %LEN% chars]  %KEY%
    set /a PASS+=1
)
goto :EOF
