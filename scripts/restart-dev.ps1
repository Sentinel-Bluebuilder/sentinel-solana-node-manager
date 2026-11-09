# Restart the dev app (electron-vite + Electron) for THIS project only.
# Kills the exact electron-vite parent PID of this repo — never every node.exe
# (Claude Code itself runs on Node). Relaunch with the CLI server auto-started.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$parents = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match [regex]::Escape($repo) -and $_.CommandLine -match 'electron-vite' }
foreach ($p in $parents) {
  Write-Output "stopping electron-vite PID $($p.ProcessId)"
  taskkill /PID $p.ProcessId /T /F | Out-Null
}
$env:SNM_AUTO_START_CLI = '1'
$env:SNM_AUTO_START_CLI_TOKEN = 'i-understand-this-opens-a-local-control-channel'
Set-Location $repo
# Truncate the old log so the readiness check below cannot match a stale line.
for ($i = 0; $i -lt 20; $i++) {
  try {
    [System.IO.File]::WriteAllText((Join-Path $repo 'dev.log'), '', (New-Object System.Text.UTF8Encoding($false)))
    break
  } catch {
    Write-Output "dev.log still locked by the stopped process, retrying ($($_.Exception.Message))"
    Start-Sleep -Milliseconds 500
  }
}
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npx electron-vite dev > dev.log 2>&1' -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if ((Test-Path dev.log) -and (Select-String -Path dev.log -Pattern 'cli server listening' -Quiet)) {
    Write-Output 'app up, CLI server listening'
    exit 0
  }
}
Write-Output 'app did not report the CLI server within 120 s; see dev.log'
exit 1
