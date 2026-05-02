# Roamready test login - grabs an accessToken and stores it in $env:TOKEN
# Usage: .\get-token.ps1
# After running, every curl in this PowerShell window can use Authorization: Bearer $env:TOKEN

$loginUrl = "http://localhost:3000/api/v1/auth/login"

$email = Read-Host "Email"
$password = Read-Host "Password" -AsSecureString
$plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
)

$body = @{
    email = $email
    password = $plainPassword
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri $loginUrl -Method Post -Body $body -ContentType "application/json"
    $env:TOKEN = $response.accessToken
    Write-Host ""
    Write-Host "Logged in as $($response.user.firstName) $($response.user.lastName)" -ForegroundColor Green
    Write-Host "Token stored in `$env:TOKEN for this PowerShell session" -ForegroundColor Green
    Write-Host ""
    Write-Host "Use in curl like: curl -H `"Authorization: Bearer `$env:TOKEN`" http://localhost:3001/api/v1/sessions" -ForegroundColor Cyan
}
catch {
    Write-Host "Login failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        $statusCode = $_.Exception.Response.StatusCode.value__
        Write-Host "Status: $statusCode" -ForegroundColor Red
    }
}