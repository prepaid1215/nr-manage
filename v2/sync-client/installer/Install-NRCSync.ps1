param()

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:LOCALAPPDATA "NRCSync"

Write-Host "NRC Sync를 설치합니다..." -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Path (Join-Path $scriptDir "NRCSync.exe") -Destination $installDir -Force
Copy-Item -Path (Join-Path $scriptDir "run_hidden.vbs") -Destination $installDir -Force

$exePath = Join-Path $installDir "NRCSync.exe"
$vbsPath = Join-Path $installDir "run_hidden.vbs"

# 기존 실행 중인 NRCSync 종료 후 재시작 (업데이트 설치 시)
Get-Process -Name "NRCSync" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Windows 로그인 시 자동 실행되도록 예약 작업 등록 (창 안 보이게 백그라운드 실행)
$taskName = "NRCSync"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
} catch {}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "NRC Sync 공유 수집 PC 자동 실행" | Out-Null

Write-Host "자동 실행 등록 완료. 지금 바로 시작합니다..." -ForegroundColor Cyan

# 지금 바로 백그라운드로 실행 (재로그인 없이 바로 사용)
Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbsPath`""

Start-Sleep -Seconds 3
Write-Host ""
Write-Host "설치가 완료되었습니다." -ForegroundColor Green
Write-Host "잠시 후 브라우저에서 등록 화면(http://127.0.0.1:5050/setup)이 자동으로 열립니다." -ForegroundColor Green
Write-Host "안 열리면 브라우저 주소창에 직접 입력해 주세요: http://127.0.0.1:5050/setup"
Write-Host ""
Write-Host "이 창은 닫으셔도 됩니다. 앞으로는 컴퓨터를 켤 때마다 자동으로 조용히 실행됩니다."
