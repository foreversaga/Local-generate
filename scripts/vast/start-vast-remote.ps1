param(
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
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
$env:MINIMAX_H3_PYTHON = "C:\Users\forev\ComfyUI\venv\Scripts\python.exe"

& (Join-Path $projectRoot "scripts\restart-web.ps1")
