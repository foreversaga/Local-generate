param(
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile = Join-Path $projectRoot ".env.local"

function Import-LocalEnvFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  $lineNumber = 0
  foreach ($line in Get-Content -LiteralPath $Path) {
    $lineNumber += 1
    $trimmed = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
      continue
    }
    if ($trimmed -notmatch '^(?<name>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$') {
      throw "Invalid environment entry at line $lineNumber in '$Path'. Use NAME=value format."
    }

    $name = $Matches.name
    $value = $Matches.value.Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if ($null -eq [Environment]::GetEnvironmentVariable($name, "Process")) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

Import-LocalEnvFile $envFile

if ([string]::IsNullOrWhiteSpace($env:MINIMAX_H3_PYTHON)) {
  throw "MINIMAX_H3_PYTHON is not set. Copy .env.example to .env.local and set the ComfyUI Python executable path."
}

$pythonSetting = $env:MINIMAX_H3_PYTHON
if (Test-Path -LiteralPath $pythonSetting -PathType Leaf) {
  $env:MINIMAX_H3_PYTHON = (Resolve-Path -LiteralPath $pythonSetting).Path
} elseif (-not (Get-Command $pythonSetting -CommandType Application -ErrorAction SilentlyContinue)) {
  throw "MINIMAX_H3_PYTHON is not an executable path or command: $pythonSetting"
}

$configModule = Join-Path $PSScriptRoot "runtime-config.ps1"
. $configModule
$configState = Get-VastRuntimeConfig $ConfigPath
$config = $configState.Data
$localComfyPort = [int]$config.tunnel.localComfyPort
$localOllamaPort = [int]$config.tunnel.localOllamaPort

& (Join-Path $PSScriptRoot "start-tunnel.ps1") -ConfigPath $configState.Path

$env:COMFY_REMOTE = "1"
$env:LOCAL_COMFY_URL = "http://127.0.0.1:8188"
$env:LOCAL_OLLAMA_URL = "http://127.0.0.1:11434"
$env:REMOTE_COMFY_URL = "http://127.0.0.1:$localComfyPort"
$env:REMOTE_OLLAMA_URL = "http://127.0.0.1:$localOllamaPort"
$env:COMFY_URL = "http://127.0.0.1:$localComfyPort"
$env:OLLAMA_URL = "http://127.0.0.1:$localOllamaPort"

& (Join-Path $projectRoot "scripts\restart-web.ps1")
