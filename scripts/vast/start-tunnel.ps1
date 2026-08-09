[CmdletBinding()]
param(
  [string]$RemoteHost = "58.136.107.112",
  [ValidateRange(1, 65535)]
  [int]$SshPort = 32052,
  [ValidateRange(1, 65535)]
  [int]$LocalComfyPort = 18188,
  [ValidateRange(1, 65535)]
  [int]$LocalOllamaPort = 11435
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logRoot = Join-Path $projectRoot "logs"
$pidPath = Join-Path $logRoot "vast-ssh-tunnel.pid"
$stdoutPath = Join-Path $logRoot "vast-ssh-tunnel.stdout.log"
$stderrPath = Join-Path $logRoot "vast-ssh-tunnel.stderr.log"
$comfyHealth = "http://127.0.0.1:$LocalComfyPort/system_stats"
$ollamaHealth = "http://127.0.0.1:$LocalOllamaPort/api/tags"

function Test-HttpEndpoint([string]$Uri) {
  try {
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if ((Test-HttpEndpoint $comfyHealth) -and (Test-HttpEndpoint $ollamaHealth)) {
  Write-Host "Vast SSH tunnel is already healthy."
  exit 0
}

$occupied = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @($LocalComfyPort, $LocalOllamaPort) }
if ($occupied) {
  $details = $occupied | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) PID $($_.OwningProcess)" }
  throw "A required local tunnel port is already occupied but unhealthy: $($details -join '; ')"
}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$sshPath = (Get-Command ssh.exe -CommandType Application).Source
$target = "root@$RemoteHost"
$arguments = @(
  "-N",
  "-T",
  "-o", "BatchMode=yes",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
  "-p", [string]$SshPort,
  "-L", "127.0.0.1:${LocalComfyPort}:127.0.0.1:18188",
  "-L", "127.0.0.1:${LocalOllamaPort}:127.0.0.1:11434",
  $target
)

$process = Start-Process `
  -FilePath $sshPath `
  -ArgumentList $arguments `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -PassThru

Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii

for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  if ($process.HasExited) {
    $detail = if (Test-Path -LiteralPath $stderrPath) { (Get-Content -LiteralPath $stderrPath -Tail 20) -join "`n" } else { "" }
    throw "SSH tunnel exited early with code $($process.ExitCode).`n$detail"
  }
  if ((Test-HttpEndpoint $comfyHealth) -and (Test-HttpEndpoint $ollamaHealth)) {
    Write-Host "Vast SSH tunnel is ready (PID $($process.Id))."
    Write-Host "ComfyUI: http://127.0.0.1:$LocalComfyPort"
    Write-Host "Ollama: http://127.0.0.1:$LocalOllamaPort"
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

if (-not $process.HasExited) {
  Stop-Process -Id $process.Id
}
throw "SSH tunnel started but the remote ComfyUI or Ollama health check did not pass."
