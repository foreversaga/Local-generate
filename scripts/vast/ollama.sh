#!/usr/bin/env bash
set -euo pipefail

export HOME=/root
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_MODELS=/workspace/ollama-models
export OLLAMA_KEEP_ALIVE=0
export OLLAMA_NO_CLOUD=true
export OLLAMA_MAX_LOADED_MODELS=1

mkdir -p "$OLLAMA_MODELS"
exec /usr/local/bin/ollama serve
