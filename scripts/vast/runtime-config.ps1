function Get-VastRuntimeConfigPath {
  param([string]$ConfigPath)

  if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
    return $ConfigPath
  }
  if (-not [string]::IsNullOrWhiteSpace($env:VAST_RUNTIME_CONFIG)) {
    return $env:VAST_RUNTIME_CONFIG
  }
  return (Join-Path $PSScriptRoot "vast-runtime.config.json")
}

function Get-VastRuntimeConfig {
  [CmdletBinding()]
  param([string]$ConfigPath)

  $resolvedPath = Get-VastRuntimeConfigPath $ConfigPath
  if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
    throw "Vast runtime config was not found at '$resolvedPath'. Copy scripts/vast/vast-runtime.config.example.json to scripts/vast/vast-runtime.config.json and set the instance host/SSH port."
  }

  try {
    $config = Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
  } catch {
    throw "Unable to parse Vast runtime config '$resolvedPath': $($_.Exception.Message)"
  }

  if ($config.schemaVersion -ne 1) {
    throw "Unsupported Vast runtime config schemaVersion '$($config.schemaVersion)'."
  }
  if ([string]::IsNullOrWhiteSpace([string]$config.instance.host) -or $config.instance.host -eq "replace-with-vast-host") {
    throw "Vast runtime config must set instance.host."
  }
  if ([string]::IsNullOrWhiteSpace([string]$config.instance.user)) {
    throw "Vast runtime config must set instance.user."
  }

  $ports = @(
    [int]$config.instance.sshPort,
    [int]$config.tunnel.localComfyPort,
    [int]$config.tunnel.localOllamaPort,
    [int]$config.tunnel.remoteComfyPort,
    [int]$config.tunnel.remoteOllamaPort
  )
  if ($ports | Where-Object { $_ -lt 1 -or $_ -gt 65535 }) {
    throw "Every Vast runtime SSH/tunnel port must be between 1 and 65535."
  }

  return [pscustomobject]@{
    Path = (Resolve-Path -LiteralPath $resolvedPath).Path
    Data = $config
  }
}
