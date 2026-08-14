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

if ([string]::IsNullOrWhiteSpace($env:MINIMAX_H3_ROOT)) {
  throw "MINIMAX_H3_ROOT is not set. Copy .env.example to .env.local and set the local minimax-h3-local path."
}

if (-not (Test-Path -LiteralPath $env:MINIMAX_H3_ROOT -PathType Container)) {
  throw "MINIMAX_H3_ROOT does not point to an existing directory: $env:MINIMAX_H3_ROOT"
}

$h3Root = (Resolve-Path -LiteralPath $env:MINIMAX_H3_ROOT).Path
$comfyHealth = "http://127.0.0.1:8188/system_stats"
$ollamaHealth = "http://127.0.0.1:11434/api/tags"
$logRoot = Join-Path $projectRoot "logs"

function Test-HttpEndpoint([string]$Uri) {
  try {
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Assert-PortAvailable([int]$Port, [string]$Service) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    throw "$Service port $Port is occupied by PID $($listener.OwningProcess), but its health endpoint is unavailable."
  }
}

if (-not (Test-HttpEndpoint $comfyHealth)) {
  Assert-PortAvailable 8188 "ComfyUI"
  $comfyScript = Join-Path $h3Root "scripts\start-comfyui.ps1"
  if (-not (Test-Path -LiteralPath $comfyScript -PathType Leaf)) {
    throw "Local ComfyUI startup script is missing: $comfyScript"
  }
  & $comfyScript -Profile low-vram -Background
}

if (-not (Test-HttpEndpoint $ollamaHealth)) {
  Assert-PortAvailable 11434 "Ollama"
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  $ollamaPath = (Get-Command ollama.exe -CommandType Application).Source
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdoutPath = Join-Path $logRoot "ollama-local-$stamp.stdout.log"
  $stderrPath = Join-Path $logRoot "ollama-local-$stamp.stderr.log"
  $previousHost = $env:OLLAMA_HOST
  $previousKeepAlive = $env:OLLAMA_KEEP_ALIVE
  try {
    $env:OLLAMA_HOST = "127.0.0.1:11434"
    $env:OLLAMA_KEEP_ALIVE = "0"
    Start-Process `
      -FilePath $ollamaPath `
      -ArgumentList @("serve") `
      -WorkingDirectory $projectRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden | Out-Null
  } finally {
    $env:OLLAMA_HOST = $previousHost
    $env:OLLAMA_KEEP_ALIVE = $previousKeepAlive
  }
}

for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
  if ((Test-HttpEndpoint $comfyHealth) -and (Test-HttpEndpoint $ollamaHealth)) {
    Write-Host "Local ComfyUI and Ollama are ready."
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

throw "Local ComfyUI or Ollama did not become healthy before the timeout."
