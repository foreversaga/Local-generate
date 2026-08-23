#!/usr/bin/env bash
set -euo pipefail

readonly COMFY_ROOT=/workspace/ComfyUI
readonly MODEL_ROOT="$COMFY_ROOT/models"
readonly STAGING_ROOT=/workspace/.seedvr2-model-staging
readonly SEEDVR2_REPO=Comfy-Org/SeedVR2
readonly SEEDVR2_REVISION=10f035adc869a5b3ffc466360b869641511c0610
readonly SEEDVR2_FP16_REVISION=a457bf495efbd40ea92f699f7d2b5d2febeca176
readonly SEEDVR2_VAE_REVISION=0bb1f83c716d1cad6dfa730b643a4f603bc2b70b

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

download_model() {
  local label="$1"
  local remote_path="$2"
  local target_path="$3"
  local expected_size="$4"
  local expected_sha="$5"
  local revision="${6:-$SEEDVR2_REVISION}"
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
  /venv/main/bin/hf download "$SEEDVR2_REPO" "$remote_path" \
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

download_model \
  seedvr2_7b_sharp_nvfp4 \
  diffusion_models/seedvr2_7b_sharp_nvfp4.safetensors \
  "$MODEL_ROOT/diffusion_models/seedvr2_7b_sharp_nvfp4.safetensors" \
  4759694792 \
  80d57af7722f5a5bd4c01d2ab2688f2bf05e552e59d3d3287257de709db10397

download_model \
  seedvr2_7b_sharp_fp16 \
  diffusion_models/seedvr2_7b_sharp_fp16.safetensors \
  "$MODEL_ROOT/diffusion_models/seedvr2_7b_sharp_fp16.safetensors" \
  16480583960 \
  70823bca54b9c24eeb56e1c452697c7c2a430867e58db0e376c6e260f3a4489d \
  "$SEEDVR2_FP16_REVISION"

download_model \
  seedvr2_ema_vae \
  vae/seedvr2_ema_vae_fp16.safetensors \
  "$MODEL_ROOT/vae/seedvr2_ema_vae_fp16.safetensors" \
  501324814 \
  20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1 \
  "$SEEDVR2_VAE_REVISION"

log 'restarting ComfyUI so SeedVR2 model selectors refresh'
supervisorctl restart comfyui

for _ in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:18188/system_stats >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:18188/system_stats >/dev/null

log 'SeedVR2 bootstrap completed successfully'
