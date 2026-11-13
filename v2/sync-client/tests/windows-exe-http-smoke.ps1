# Smoke-test the exact published Windows EXE, not Python source code.
# Run only on an isolated Windows test machine. No PC registration or credentials are required.
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$ManifestPath
)
$ErrorActionPreference = "Stop"

$exe = (Resolve-Path $ExePath).Path
$manifest = Get-Content -Raw -Path $ManifestPath | ConvertFrom-Json
$actualSha = (Get-FileHash -Path $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedSha = [string]$manifest.sha256
if ($actualSha -ne $expectedSha.ToLowerInvariant()) {
    throw "EXE hash mismatch. Expected: $expectedSha, got: $actualSha"
}
if ((Get-Item $exe).Length -ne [long]$manifest.bytes) {
    throw "EXE size mismatch"
}
$existing = Get-NetTCPConnection -LocalPort 5050 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    throw "Port 5050 is already in use. Refusing to test against another process."
}

$proc = $null
try {
    Write-Host "Starting verified published EXE: $exe"
    Write-Host "Manifest release: $($manifest.release); collectorVersion: $($manifest.collectorVersion)"
    $proc = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru
    $ready = $false
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Seconds 2
        $listener = Get-NetTCPConnection -LocalPort 5050 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) {
            $ready = $true
            Write-Host "Port 5050 listener process: $($listener.OwningProcess)"
            break
        }
        if ($proc.HasExited) { throw "EXE exited before starting HTTP server (exit code $($proc.ExitCode))." }
    }
    if (-not $ready) { throw "EXE failed to open port 5050 after 180 seconds." }

    # Verify real HTTP responses from the compiled EXE, not Flask's in-process test client.
    $cases = @(
        @{ Path = "/health"; Expected = 200 },
        @{ Path = "/update-status"; Expected = 200 },
        @{ Path = "/setup"; Expected = 200 },
        @{ Path = "/notes"; Expected = 200 },
        @{ Path = "/api/status"; Expected = 401 }
    )
    foreach ($test in $cases) {
        $url = "http://127.0.0.1:5050$($test.Path)"
        $response = Invoke-WebRequest -Uri $url -SkipHttpErrorCheck -TimeoutSec 10 -NoProxy
        Write-Host "$($test.Path): HTTP $([int]$response.StatusCode); Server=$($response.Headers.Server)"
        if ([int]$response.StatusCode -ne $test.Expected) {
            throw "Unexpected HTTP status for $($test.Path). Wanted $($test.Expected), got $([int]$response.StatusCode)."
        }
        if ($test.Path -eq "/health") {
            $health = $response.Content | ConvertFrom-Json
            if (-not $health.ok) { throw "Health response did not report ok=true." }
            if ([long]$health.release -ne [long]$manifest.release) {
                throw "Running release differs from published manifest."
            }
            if ([string]$health.collectorVersion -ne [string]$manifest.collectorVersion) {
                throw "Collector version differs from published manifest."
            }
        }
    }
    Write-Host "PASS: published Windows EXE routes and version matched the manifest."
} finally {
    $log = Join-Path $env:LOCALAPPDATA "NRCSync\nrcsync.log"
    if (Test-Path $log) {
        Write-Host "==== NRC Sync log (last 50 lines) ===="
        Get-Content $log -Tail 50 | ForEach-Object { Write-Host $_ }
    }
    if ($proc) {
        & taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null
    }
}
