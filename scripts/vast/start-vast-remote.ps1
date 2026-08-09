$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

& (Join-Path $PSScriptRoot "start-tunnel.ps1")

$env:COMFY_REMOTE = "1"
$env:LOCAL_COMFY_URL = "http://127.0.0.1:8188"
$env:LOCAL_OLLAMA_URL = "http://127.0.0.1:11434"
$env:REMOTE_COMFY_URL = "http://127.0.0.1:18188"
$env:REMOTE_OLLAMA_URL = "http://127.0.0.1:11435"
$env:COMFY_URL = "http://127.0.0.1:18188"
$env:OLLAMA_URL = "http://127.0.0.1:11435"
$env:MINIMAX_H3_PYTHON = "C:\Users\forev\ComfyUI\venv\Scripts\python.exe"

& (Join-Path $projectRoot "scripts\restart-web.ps1")
