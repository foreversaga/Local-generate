param(
  [ValidateSet("production", "development")]
  [string]$Mode = "production"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$healthUrl = "http://127.0.0.1:8787/app/api/health"
$webPort = 8787

function Get-WebListenerPid {
  $line = netstat -ano -p tcp | ForEach-Object { $_.ToString() } | Where-Object {
    $_ -match (":" + $webPort + "\s") -and $_ -match "LISTENING"
  } | Select-Object -First 1

  if ($line -and $line -match "LISTENING\s+(\d+)\s*$") {
    return [int]$Matches[1]
  }

  return $null
}

function Test-WebHealth {
  try {
    $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

$listenerPid = Get-WebListenerPid
if ($listenerPid) {
  $listenerProcess = Get-Process -Id $listenerPid -ErrorAction Stop
  if ($listenerProcess.ProcessName -notin @("node", "npm", "cmd")) {
    throw "Port $webPort is owned by unexpected process $($listenerProcess.ProcessName) (PID $listenerPid); refusing to stop it."
  }

  Write-Host "Stopping H3 Studio Web/API PID $listenerPid..."
  Stop-Process -Id $listenerPid
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    if (-not (Get-Process -Id $listenerPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process -Id $listenerPid -ErrorAction SilentlyContinue) {
    throw "H3 Studio Web/API PID $listenerPid did not stop cleanly."
  }
}

if (Test-WebHealth) {
  throw "The health endpoint still responds after stopping the listener; refusing to start a second Web/API instance."
}

$logRoot = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$runStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runScript = if ($Mode -eq "production") { "start" } else { "dev" }
if ($Mode -eq "production" -and -not (Test-Path (Join-Path $projectRoot "dist\server\index.js"))) {
  throw "Production build is missing. Run npm.cmd run build before restarting the production Web/API service."
}
$stdoutPath = Join-Path $logRoot ("web-" + $Mode + "-" + $runStamp + ".stdout.log")
$stderrPath = Join-Path $logRoot ("web-" + $Mode + "-" + $runStamp + ".stderr.log")
$npmPath = (Get-Command npm.cmd -CommandType Application).Source

# The managed shell can expose both Path and PATH. Normalize that process-local
# duplicate before Start-Process builds the child environment.
$pathValue = $env:Path
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
$env:Path = $pathValue

$child = Start-Process `
  -FilePath $npmPath `
  -ArgumentList @("run", $runScript) `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -PassThru

Write-Host "Started H3 Studio Web/API in $Mode mode; launcher PID $($child.Id)."
Write-Host "Waiting for $healthUrl ..."
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  if (Test-WebHealth) {
    Write-Host "H3 Studio Web/API is ready: http://127.0.0.1:8787/app"
    Write-Host "stdout: $stdoutPath"
    Write-Host "stderr: $stderrPath"
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

Write-Host "Web/API did not become healthy. Recent stderr:"
if (Test-Path $stderrPath) {
  Get-Content -Path $stderrPath -Tail 30
}
throw "H3 Studio Web/API failed to start."
