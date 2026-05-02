# Roamready Phase 1 - PlanningSession backend verification
# Prereqs: $env:TOKEN must be set (run .\get-token.ps1 first)
# Usage: .\test-sessions.ps1

if (-not $env:TOKEN) {
    Write-Host "ERROR: `$env:TOKEN not set. Run .\get-token.ps1 first." -ForegroundColor Red
    exit 1
}

$base = "http://localhost:3001/api/v1"
$headers = @{ Authorization = "Bearer $env:TOKEN" }
$pass = 0
$fail = 0

function Test-Result {
    param($name, $condition, $detail = "")
    if ($condition) {
        Write-Host "  PASS  " -ForegroundColor Green -NoNewline
        Write-Host $name
        $script:pass++
    } else {
        Write-Host "  FAIL  " -ForegroundColor Red -NoNewline
        Write-Host "$name $detail"
        $script:fail++
    }
}

Write-Host ""
Write-Host "=== Roamready Phase 1: PlanningSession verification ===" -ForegroundColor Cyan
Write-Host ""

# Test 1: Create a session
Write-Host "[1] POST /sessions creates session"
try {
    $body = @{ title = "Test session 1" } | ConvertTo-Json
    $session = Invoke-RestMethod -Uri "$base/sessions" -Method Post -Headers $headers -Body $body -ContentType "application/json"
    Test-Result "Returns session with id" ($null -ne $session.id)
    Test-Result "Title set correctly" ($session.title -eq "Test session 1")
    Test-Result "Status defaults to PLANNING" ($session.status -eq "PLANNING")
    Test-Result "tripId is null on create" ($null -eq $session.tripId)
    $sessionId = $session.id
} catch {
    Test-Result "POST /sessions" $false "Error: $($_.Exception.Message)"
    Write-Host "Cannot continue without a session id. Aborting." -ForegroundColor Red
    exit 1
}

# Test 2: Strict validation rejects unknown field on CREATE
Write-Host ""
Write-Host "[2] POST /sessions with userId rejected (strict validation)"
try {
    $body = @{ title = "Hacker session"; userId = "evil-user-id" } | ConvertTo-Json
    $resp = Invoke-RestMethod -Uri "$base/sessions" -Method Post -Headers $headers -Body $body -ContentType "application/json"
    Test-Result "Unknown field rejected with 400" $false "Expected 400, got 200"
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    Test-Result "Unknown field rejected with 400" ($status -eq 400) "Got status $status"
}

# Test 3: GET /sessions lists user's sessions
Write-Host ""
Write-Host "[3] GET /sessions lists current user's sessions"
try {
    $list = Invoke-RestMethod -Uri "$base/sessions" -Headers $headers
    Test-Result "Returns array" ($list -is [array] -or $list.Count -ge 1)
    Test-Result "Contains the session we just created" ($list | Where-Object { $_.id -eq $sessionId })
} catch {
    Test-Result "GET /sessions" $false "Error: $($_.Exception.Message)"
}

# Test 4: GET /sessions/latest-active
Write-Host ""
Write-Host "[4] GET /sessions/latest-active returns most recent in-progress"
try {
    $latest = Invoke-RestMethod -Uri "$base/sessions/latest-active" -Headers $headers
    Test-Result "Returns the session we created" ($latest.id -eq $sessionId)
    Test-Result "Status is PLANNING" ($latest.status -eq "PLANNING")
    Test-Result "tripId is null" ($null -eq $latest.tripId)
} catch {
    Test-Result "GET /sessions/latest-active" $false "Error: $($_.Exception.Message)"
}

# Test 5: GET /sessions/:id (own session)
Write-Host ""
Write-Host "[5] GET /sessions/:id returns own session"
try {
    $fetched = Invoke-RestMethod -Uri "$base/sessions/$sessionId" -Headers $headers
    Test-Result "Returns matching session" ($fetched.id -eq $sessionId)
} catch {
    Test-Result "GET /sessions/:id" $false "Error: $($_.Exception.Message)"
}

# Test 6: GET /sessions/:id (foreign id) returns 404
Write-Host ""
Write-Host "[6] GET /sessions/:id with bogus id returns 404"
try {
    $resp = Invoke-RestMethod -Uri "$base/sessions/clx000000000000000000000" -Headers $headers
    Test-Result "Bogus id returns 404" $false "Expected 404, got 200"
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    Test-Result "Bogus id returns 404" ($status -eq 404) "Got status $status"
}

# Test 7: PUT /sessions/:id updates allowed fields
Write-Host ""
Write-Host "[7] PUT /sessions/:id updates messages and title"
try {
    $msgs = @(
        @{ role = "user"; content = "Plan me a trip to Yellowstone" }
        @{ role = "assistant"; content = "Sounds great! When are you thinking?" }
    )
    $body = @{ title = "Yellowstone in July"; messages = $msgs } | ConvertTo-Json -Depth 4
    $updated = Invoke-RestMethod -Uri "$base/sessions/$sessionId" -Method Put -Headers $headers -Body $body -ContentType "application/json"
    Test-Result "Title updated" ($updated.title -eq "Yellowstone in July")
    Test-Result "Messages array has 2 items" ($updated.messages.Count -eq 2)
} catch {
    Test-Result "PUT /sessions/:id" $false "Error: $($_.Exception.Message)"
}

# Test 8: PUT rejects userId in body
Write-Host ""
Write-Host "[8] PUT /sessions/:id with userId rejected"
try {
    $body = @{ title = "Hacked"; userId = "evil-user" } | ConvertTo-Json
    $resp = Invoke-RestMethod -Uri "$base/sessions/$sessionId" -Method Put -Headers $headers -Body $body -ContentType "application/json"
    Test-Result "userId mass-assignment rejected" $false "Expected 400, got 200"
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    Test-Result "userId mass-assignment rejected" ($status -eq 400) "Got status $status"
}

# Test 9: PUT rejects tripId in body (server-managed)
Write-Host ""
Write-Host "[9] PUT /sessions/:id with tripId rejected"
try {
    $body = @{ tripId = "evil-trip-id" } | ConvertTo-Json
    $resp = Invoke-RestMethod -Uri "$base/sessions/$sessionId" -Method Put -Headers $headers -Body $body -ContentType "application/json"
    Test-Result "tripId mass-assignment rejected" $false "Expected 400, got 200"
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    Test-Result "tripId mass-assignment rejected" ($status -eq 400) "Got status $status"
}

# Test 10: POST /sessions/:id/promote creates trip
Write-Host ""
Write-Host "[10] POST /sessions/:id/promote creates Trip and links session"
try {
    $body = @{
        name = "Yellowstone test trip"
        startLocation = "Mesa"
        endLocation = "Mesa"
    } | ConvertTo-Json
    $promoted = Invoke-RestMethod -Uri "$base/sessions/$sessionId/promote" -Method Post -Headers $headers -Body $body -ContentType "application/json"
    Test-Result "Returns session and trip" (($null -ne $promoted.session) -and ($null -ne $promoted.trip))
    Test-Result "Session status is COMPLETED" ($promoted.session.status -eq "COMPLETED")
    Test-Result "Session tripId is set" ($null -ne $promoted.session.tripId)
    Test-Result "Trip name matches" ($promoted.trip.name -eq "Yellowstone test trip")
    $promotedTripId = $promoted.trip.id
} catch {
    Test-Result "POST /sessions/:id/promote" $false "Error: $($_.Exception.Message)"
}

# Test 11: Re-promote rejected
Write-Host ""
Write-Host "[11] POST /sessions/:id/promote on already-promoted rejected"
try {
    $body = @{
        name = "Should fail"
        startLocation = "Mesa"
        endLocation = "Mesa"
    } | ConvertTo-Json
    $resp = Invoke-RestMethod -Uri "$base/sessions/$sessionId/promote" -Method Post -Headers $headers -Body $body -ContentType "application/json"
    Test-Result "Already-promoted rejected with 400" $false "Expected 400, got 200"
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    Test-Result "Already-promoted rejected with 400" ($status -eq 400) "Got status $status"
}

# Test 12: DELETE soft-deletes (sets status=ARCHIVED)
Write-Host ""
Write-Host "[12] DELETE /sessions/:id soft-deletes (sets ARCHIVED)"
try {
    $body = @{ title = "Throwaway" } | ConvertTo-Json
    $throwaway = Invoke-RestMethod -Uri "$base/sessions" -Method Post -Headers $headers -Body $body -ContentType "application/json"
    $throwawayId = $throwaway.id

    Invoke-RestMethod -Uri "$base/sessions/$throwawayId" -Method Delete -Headers $headers | Out-Null

    $deleted = Invoke-RestMethod -Uri "$base/sessions/$throwawayId" -Headers $headers
    Test-Result "Row still exists" ($deleted.id -eq $throwawayId)
    Test-Result "Status is ARCHIVED" ($deleted.status -eq "ARCHIVED")
} catch {
    Test-Result "DELETE /sessions/:id soft-delete" $false "Error: $($_.Exception.Message)"
}

# Test 13: ARCHIVED sessions excluded from default list
Write-Host ""
Write-Host "[13] GET /sessions excludes ARCHIVED by default"
try {
    $list = Invoke-RestMethod -Uri "$base/sessions" -Headers $headers
    $hasArchived = $list | Where-Object { $_.status -eq "ARCHIVED" }
    Test-Result "No ARCHIVED in default list" ($null -eq $hasArchived)
} catch {
    Test-Result "Default list excludes ARCHIVED" $false "Error: $($_.Exception.Message)"
}

# Cleanup: delete the trip created by promotion
if ($promotedTripId) {
    try {
        Invoke-RestMethod -Uri "$base/trips/$promotedTripId" -Method Delete -Headers $headers | Out-Null
    } catch {
        # Best-effort cleanup
    }
}

Write-Host ""
Write-Host "=== Results ===" -ForegroundColor Cyan
Write-Host "  Passed: $pass" -ForegroundColor Green
if ($fail -eq 0) {
    Write-Host "  Failed: $fail" -ForegroundColor Green
} else {
    Write-Host "  Failed: $fail" -ForegroundColor Red
}
Write-Host ""

if ($fail -eq 0) {
    Write-Host "All checks green. Phase 1 is solid." -ForegroundColor Green
} else {
    Write-Host "Some tests failed - paste the output back and we will dig in." -ForegroundColor Yellow
}