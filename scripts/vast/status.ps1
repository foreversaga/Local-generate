[CmdletBinding()]
param(
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"
$configModule = Join-Path $PSScriptRoot "runtime-config.ps1"
. $configModule

function Test-HttpEndpoint([string]$Uri) {
  try {
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 5
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

$results = [System.Collections.Generic.List[object]]::new()
$configState = $null
try {
  $configState = Get-VastRuntimeConfig $ConfigPath
} catch {
  $results.Add([pscustomobject]@{
      Service = "Vast runtime config"
      Online = $false
      Uri = ""
      Drift = $_.Exception.Message
      ManifestVersion = ""
  })
}

if ($configState) {
  $config = $configState.Data
  $localComfyPort = [int]$config.tunnel.localComfyPort
  $localOllamaPort = [int]$config.tunnel.localOllamaPort
  $results.Add([pscustomobject]@{ Service = "ComfyUI tunnel"; Online = (Test-HttpEndpoint "http://127.0.0.1:$localComfyPort/system_stats"); Uri = "http://127.0.0.1:$localComfyPort"; Drift = ""; ManifestVersion = "" })
  $results.Add([pscustomobject]@{ Service = "Ollama tunnel"; Online = (Test-HttpEndpoint "http://127.0.0.1:$localOllamaPort/api/tags"); Uri = "http://127.0.0.1:$localOllamaPort"; Drift = ""; ManifestVersion = "" })
  $results.Add([pscustomobject]@{ Service = "H3 Studio"; Online = (Test-HttpEndpoint "http://127.0.0.1:8787/app/api/health"); Uri = "http://127.0.0.1:8787/app"; Drift = ""; ManifestVersion = "" })

  $sshPath = (Get-Command ssh.exe -CommandType Application).Source
  $target = "$($config.instance.user)@$($config.instance.host)"
  $sshArguments = @(
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
    "-p", [string]$config.instance.sshPort,
    $target,
    "bash", "/usr/local/bin/h3-runtime-status.sh"
  )
  $remoteRaw = & $sshPath @sshArguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    $results.Add([pscustomobject]@{ Service = "Remote runtime manifest"; Online = $false; Uri = $target; Drift = ($remoteRaw -join " "); ManifestVersion = "" })
  } else {
    try {
      $remote = ($remoteRaw -join "") | ConvertFrom-Json
      $results.Add([pscustomobject]@{
          Service = "Remote runtime manifest"
          Online = [bool]$remote.ok
          Uri = $target
          Drift = if ($remote.drift) { ($remote.drift -join ", ") } else { "" }
          ManifestVersion = [string]$remote.manifestVersion
      })
    } catch {
      $results.Add([pscustomobject]@{ Service = "Remote runtime manifest"; Online = $false; Uri = $target; Drift = "Invalid runtime status response: $($_.Exception.Message)"; ManifestVersion = "" })
    }
  }
}

$results
if ($results | Where-Object { -not $_.Online -or -not [string]::IsNullOrWhiteSpace($_.Drift) }) {
  exit 1
}
