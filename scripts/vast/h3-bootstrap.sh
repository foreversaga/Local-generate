#!/usr/bin/env bash
set -euo pipefail

readonly COMFY_ROOT=/workspace/ComfyUI
readonly MODEL_ROOT="$COMFY_ROOT/models"
readonly STAGING_ROOT=/workspace/.h3-model-staging
readonly OLLAMA_MODEL_QWEN='huihui_ai/qwen3-vl-abliterated:32b-instruct-q4_K_M'
readonly OLLAMA_MODEL_GEMMA4='hf.co/HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP:Q4_K_M'

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

download_model() {
  local label="$1"
  local repo="$2"
  local revision="$3"
  local remote_path="$4"
  local target_path="$5"
  local expected_size="$6"
  local expected_sha="$7"
  local staging_dir="$STAGING_ROOT/$label"
  local source_path="$staging_dir/$remote_path"

  if [[ -f "$target_path" ]]; then
    local current_size
    current_size="$(stat -c '%s' "$target_path")"
    if [[ "$current_size" != "$expected_size" ]]; then
      log "ERROR existing $label has unexpected size: $current_size"
      return 1
    fi
    echo "$expected_sha  $target_path" | sha256sum --check --status
    log "verified existing $label"
    return 0
  fi

  log "downloading $label"
  mkdir -p "$staging_dir" "$(dirname "$target_path")"
  /venv/main/bin/hf download "$repo" "$remote_path" \
    --revision "$revision" \
    --local-dir "$staging_dir"

  local downloaded_size
  downloaded_size="$(stat -c '%s' "$source_path")"
  if [[ "$downloaded_size" != "$expected_size" ]]; then
    local prefix_sha
    local trailing_text
    prefix_sha="$(head -c "$expected_size" "$source_path" | sha256sum | awk '{print $1}')"
    trailing_text="$(tail -c "+$((expected_size + 1))" "$source_path" | tr -d '\r\n')"
    if [[ "$prefix_sha" == "$expected_sha" && "$trailing_text" =~ ^L2P_bypass_[A-Za-z0-9._-]+_[0-9]+$ ]]; then
      log "removing verified L2P bypass trailer from $label ($((downloaded_size - expected_size)) bytes)"
      truncate -s "$expected_size" "$source_path"
      downloaded_size="$expected_size"
    else
      log "ERROR downloaded $label has unexpected size: $downloaded_size"
      return 1
    fi
  fi
  echo "$expected_sha  $source_path" | sha256sum --check --status
  mv "$source_path" "$target_path"
  chmod 0644 "$target_path"
  log "installed and verified $label"
}

log 'starting Vast 5090 H3 bootstrap'

if [[ ! -x /usr/local/bin/ollama ]]; then
  log 'installing Ollama from the official installer'
  curl -fsSL https://ollama.com/install.sh | sh
else
  log "using existing Ollama: $(/usr/local/bin/ollama --version 2>/dev/null || true)"
fi

install -m 0755 /workspace/ollama.sh /opt/supervisor-scripts/ollama.sh
install -m 0644 /workspace/ollama.conf /etc/supervisor/conf.d/ollama.conf
supervisorctl reread
supervisorctl update

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null

for ollama_model in "$OLLAMA_MODEL_QWEN" "$OLLAMA_MODEL_GEMMA4"; do
  log "pulling Ollama model $ollama_model"
  OLLAMA_HOST=http://127.0.0.1:11434 /usr/local/bin/ollama pull "$ollama_model"
done

download_model \
  fl2va_nvfp4 \
  Abiray/Minimax-H3-nvfp4-INT4-INT8-Convrot \
  6e632a197e7e1fe99f2c9f4b635c39db801b2210 \
  MiniMax_H3_FL2VA_pruned_nvfp4.safetensors \
  "$MODEL_ROOT/diffusion_models/minimax_h3_fl2va_pruned_nvfp4.safetensors" \
  12528636800 \
  9d49beb65ddc373a0df523b8ce715b61b73f88127bf3c8d3ffda76c5dda02bd4

download_model \
  ref2va_nvfp4 \
  lilcheaty/MiniMax-H3-NVFP4 \
  8c5abfed61e1b6a170240792b65253fba1a65b7b \
  minimax_h3_ref2va_pruned_nvfp4.safetensors \
  "$MODEL_ROOT/diffusion_models/minimax_h3_ref2va_pruned_nvfp4.safetensors" \
  12528636800 \
  c813c5eabd85e275daccbf45e6f8ac4d9d14a1827d425e5be5070c92c60b78ac

download_model \
  qwen3vl_h3_nvfp4_awq \
  Comfy-Org/MiniMax-H3 \
  eb8a16107c595128b3a578f82d2ce2f75920c355 \
  text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors \
  "$MODEL_ROOT/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" \
  15687142551 \
  35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6

download_model \
  h3_video_vae \
  Comfy-Org/MiniMax-H3 \
  eb8a16107c595128b3a578f82d2ce2f75920c355 \
  vae/minimax_h3_video_vae_fp16.safetensors \
  "$MODEL_ROOT/vae/minimax_h3_video_vae_fp16.safetensors" \
  5207808496 \
  7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522

download_model \
  h3_audio_vae \
  Comfy-Org/MiniMax-H3 \
  eb8a16107c595128b3a578f82d2ce2f75920c355 \
  vae/minimax_h3_audio_vae_fp32.safetensors \
  "$MODEL_ROOT/vae/minimax_h3_audio_vae_fp32.safetensors" \
  605254808 \
  8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48

log 'restarting ComfyUI so model selectors refresh'
supervisorctl restart comfyui

for _ in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:18188/system_stats >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:18188/system_stats >/dev/null

log 'bootstrap completed successfully'
