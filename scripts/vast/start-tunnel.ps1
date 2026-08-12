[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [string]$RemoteHost = "",
  [int]$SshPort = 0,
  [int]$LocalComfyPort = 0,
  [int]$LocalOllamaPort = 0
)

$ErrorActionPreference = "Stop"
$configModule = Join-Path $PSScriptRoot "runtime-config.ps1"
. $configModule
$configState = Get-VastRuntimeConfig $ConfigPath
$config = $configState.Data

$remoteHostValue = if ([string]::IsNullOrWhiteSpace($RemoteHost)) { [string]$config.instance.host } else { $RemoteHost }
$sshPortValue = if ($SshPort -gt 0) { $SshPort } else { [int]$config.instance.sshPort }
$localComfyPortValue = if ($LocalComfyPort -gt 0) { $LocalComfyPort } else { [int]$config.tunnel.localComfyPort }
$localOllamaPortValue = if ($LocalOllamaPort -gt 0) { $LocalOllamaPort } else { [int]$config.tunnel.localOllamaPort }
$remoteComfyPortValue = [int]$config.tunnel.remoteComfyPort
$remoteOllamaPortValue = [int]$config.tunnel.remoteOllamaPort
$remoteUser = [string]$config.instance.user

foreach ($port in @($sshPortValue, $localComfyPortValue, $localOllamaPortValue, $remoteComfyPortValue, $remoteOllamaPortValue)) {
  if ($port -lt 1 -or $port -gt 65535) {
    throw "Every Vast runtime SSH/tunnel port must be between 1 and 65535."
  }
}

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logRoot = Join-Path $projectRoot "logs"
$pidPath = Join-Path $logRoot "vast-ssh-tunnel.pid"
$stdoutPath = Join-Path $logRoot "vast-ssh-tunnel.stdout.log"
$stderrPath = Join-Path $logRoot "vast-ssh-tunnel.stderr.log"
$comfyHealth = "http://127.0.0.1:$localComfyPortValue/system_stats"
$ollamaHealth = "http://127.0.0.1:$localOllamaPortValue/api/tags"

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
  Where-Object { $_.LocalPort -in @($localComfyPortValue, $localOllamaPortValue) }
if ($occupied) {
  $details = $occupied | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) PID $($_.OwningProcess)" }
  throw "A required local tunnel port is already occupied but unhealthy: $($details -join '; ')"
}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$sshPath = (Get-Command ssh.exe -CommandType Application).Source
$target = "$remoteUser@$remoteHostValue"
$arguments = @(
  "-N",
  "-T",
  "-o", "BatchMode=yes",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
  "-p", [string]$sshPortValue,
  "-L", "127.0.0.1:${localComfyPortValue}:127.0.0.1:${remoteComfyPortValue}",
  "-L", "127.0.0.1:${localOllamaPortValue}:127.0.0.1:${remoteOllamaPortValue}",
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
    Write-Host "ComfyUI: http://127.0.0.1:$localComfyPortValue"
    Write-Host "Ollama: http://127.0.0.1:$localOllamaPortValue"
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

if (-not $process.HasExited) {
  Stop-Process -Id $process.Id
}
throw "SSH tunnel started but the remote ComfyUI or Ollama health check did not pass."
