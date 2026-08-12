#!/usr/bin/env bash
set -euo pipefail

readonly MANIFEST_PATH="${H3_RUNTIME_MANIFEST:-/workspace/runtime-manifest.json}"
readonly PYTHON_BIN="${H3_RUNTIME_PYTHON:-/venv/main/bin/python}"

[[ -f "$MANIFEST_PATH" ]] || { printf 'runtime manifest not found: %s\n' "$MANIFEST_PATH" >&2; exit 1; }

manifest_query() {
  "$PYTHON_BIN" - "$MANIFEST_PATH" "$@" <<'PY'
import json
import sys

manifest_path, command, *args = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
if manifest.get("schemaVersion") != 1:
    raise SystemExit(f"unsupported manifest schemaVersion: {manifest.get('schemaVersion')!r}")
if command == "meta":
    print(manifest["manifestVersion"], manifest["bootstrapVersion"])
elif command == "comfyui":
    item = manifest["comfyui"]
    print("\t".join((item["repository"], item["revision"], item["path"], item.get("requirements", ""))))
elif command == "custom":
    for item in manifest.get("customNodes", []):
        print("\t".join((item["name"], item["repository"], item["revision"], item["path"], item.get("requirements", ""))))
elif command == "models":
    for item in manifest["models"]:
        print("\t".join((item["id"], item["repository"], item["revision"], item["remotePath"], item["targetPath"], str(item["size"]), item["sha256"])))
elif command == "ollama":
    for item in manifest["ollama"]["models"]:
        print("\t".join((item["name"], item.get("version", ""), item.get("digest") or "")))
elif command == "persistent":
    item = manifest["persistent"]
    print("\t".join((item["cacheRoot"], item["statePath"], item["volumeMount"])))
elif command == "remote_ports":
    item = manifest.get("remote", {})
    print("\t".join((str(item.get("comfyPort", 18188)), str(item.get("ollamaPort", 11434)))))
else:
    raise SystemExit(f"unknown manifest query: {command}")
PY
}

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

quarantine_file() {
  local path="$1"
  if [[ -e "$path" ]]; then
    local quarantine="${path}.bad.$(date -u +%Y%m%dT%H%M%SZ)"
    mv -- "$path" "$quarantine"
    log "quarantined invalid artifact $path -> $quarantine"
  fi
}

verify_file() {
  local path="$1" expected_size="$2" expected_sha="$3"
  [[ -f "$path" ]] || return 1
  [[ "$(stat -c '%s' "$path")" == "$expected_size" ]] || return 1
  printf '%s  %s\n' "$expected_sha" "$path" | sha256sum --check --status
}

install_atomic() {
  local source="$1" target="$2" temporary="${2}.tmp.$$"
  mkdir -p "$(dirname "$target")"
  rm -f -- "$temporary"
  cp --reflink=auto -- "$source" "$temporary" 2>/dev/null || cp -- "$source" "$temporary"
  chmod 0644 "$temporary"
  mv -f -- "$temporary" "$target"
}

ensure_git_checkout() {
  local label="$1" repository="$2" revision="$3" target="$4"
  if [[ ! -d "$target/.git" ]]; then
    [[ ! -e "$target" ]] || quarantine_file "$target"
    mkdir -p "$(dirname "$target")"
    log "cloning $label at $revision"
    git clone --no-checkout "$repository" "$target"
  fi
  git -C "$target" fetch --depth 1 origin "$revision"
  git -C "$target" checkout --detach "$revision"
  [[ "$(git -C "$target" rev-parse HEAD)" == "$revision" ]] || { log "ERROR $label revision drift"; return 1; }
}

install_requirements() {
  local root="$1" requirements="$2"
  [[ -n "$requirements" && -f "$root/$requirements" ]] || return 0
  "$PYTHON_BIN" -m pip install --disable-pip-version-check -r "$root/$requirements"
}

download_model() {
  local label="$1" repo="$2" revision="$3" remote_path="$4" target_path="$5" expected_size="$6" expected_sha="$7"
  local cache_path="$CACHE_ROOT/models/$label/$(basename "$remote_path")"
  local staging_dir="$STAGING_ROOT/$label/$revision" source_path="$staging_dir/$remote_path"

  if verify_file "$target_path" "$expected_size" "$expected_sha"; then
    log "verified existing $label"
    return 0
  fi
  quarantine_file "$target_path"
  if ! verify_file "$cache_path" "$expected_size" "$expected_sha"; then
    quarantine_file "$cache_path"
    mkdir -p "$staging_dir"
    log "downloading $label at $revision"
    /venv/main/bin/hf download "$repo" "$remote_path" --revision "$revision" --local-dir "$staging_dir"
    if [[ "$(stat -c '%s' "$source_path")" != "$expected_size" ]]; then
      local prefix_sha trailing_text
      prefix_sha="$(head -c "$expected_size" "$source_path" | sha256sum | awk '{print $1}')"
      trailing_text="$(tail -c "+$((expected_size + 1))" "$source_path" | tr -d '\r\n')"
      if [[ "$prefix_sha" == "$expected_sha" && "$trailing_text" =~ ^L2P_bypass_[A-Za-z0-9._-]+_[0-9]+$ ]]; then
        truncate -s "$expected_size" "$source_path"
      fi
    fi
    verify_file "$source_path" "$expected_size" "$expected_sha" || { quarantine_file "$source_path"; return 1; }
    mkdir -p "$(dirname "$cache_path")"
    mv -f -- "$source_path" "$cache_path"
  else
    log "restoring verified $label from persistent cache"
  fi
  install_atomic "$cache_path" "$target_path"
  verify_file "$target_path" "$expected_size" "$expected_sha"
}

IFS=$'\t' read -r COMFY_REPOSITORY COMFY_REVISION COMFY_ROOT COMFY_REQUIREMENTS < <(manifest_query comfyui)
IFS=$'\t' read -r CACHE_ROOT STATE_PATH VOLUME_MOUNT < <(manifest_query persistent)
IFS=$'\t' read -r REMOTE_COMFY_PORT REMOTE_OLLAMA_PORT < <(manifest_query remote_ports)
STAGING_ROOT="$CACHE_ROOT/staging"
MODEL_ROOT="$COMFY_ROOT/models"
MANIFEST_SHA="$(sha256sum "$MANIFEST_PATH" | awk '{print $1}')"
mkdir -p "$CACHE_ROOT" "$STAGING_ROOT"
read -r MANIFEST_VERSION BOOTSTRAP_VERSION < <(manifest_query meta)
log "starting Vast H3 bootstrap manifest=$MANIFEST_VERSION bootstrap=$BOOTSTRAP_VERSION"

ensure_git_checkout "ComfyUI" "$COMFY_REPOSITORY" "$COMFY_REVISION" "$COMFY_ROOT"
install_requirements "$COMFY_ROOT" "$COMFY_REQUIREMENTS"
while IFS=$'\t' read -r node_name node_repository node_revision node_path node_requirements; do
  [[ -n "$node_name" ]] || continue
  ensure_git_checkout "$node_name" "$node_repository" "$node_revision" "$node_path"
  install_requirements "$node_path" "$node_requirements"
done < <(manifest_query custom)

if [[ ! -x /usr/local/bin/ollama ]]; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
install -m 0755 /workspace/ollama.sh /opt/supervisor-scripts/ollama.sh
install -m 0644 /workspace/ollama.conf /etc/supervisor/conf.d/ollama.conf
supervisorctl reread
supervisorctl update
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:11434/api/tags >/dev/null && break || sleep 1; done
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null
while IFS=$'\t' read -r ollama_model _ollama_version _ollama_digest; do
  [[ -n "$ollama_model" ]] || continue
  OLLAMA_HOST=http://127.0.0.1:11434 /usr/local/bin/ollama pull "$ollama_model"
done < <(manifest_query ollama)

while IFS=$'\t' read -r model_id model_repo model_revision model_remote_path model_target_path model_size model_sha; do
  [[ -n "$model_id" ]] || continue
  download_model "$model_id" "$model_repo" "$model_revision" "$model_remote_path" "$model_target_path" "$model_size" "$model_sha"
done < <(manifest_query models)

log 'restarting ComfyUI so model selectors refresh'
supervisorctl restart comfyui
for _ in $(seq 1 120); do curl -fsS "http://127.0.0.1:${REMOTE_COMFY_PORT}/system_stats" >/dev/null && break || sleep 1; done
curl -fsS "http://127.0.0.1:${REMOTE_COMFY_PORT}/system_stats" >/dev/null

"$PYTHON_BIN" - "$MANIFEST_PATH" "$STATE_PATH" "$MANIFEST_SHA" "$CACHE_ROOT" "$VOLUME_MOUNT" <<'PY'
import json
import sys
import urllib.request
from datetime import datetime, timezone
manifest_path, state_path, manifest_sha, cache_root, volume_mount = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
try:
    with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=5) as response:
        ollama_models = {item.get("name"): item.get("digest") for item in json.load(response).get("models", [])}
except Exception:
    ollama_models = {}
state = {
    "schemaVersion": 1,
    "manifestVersion": manifest["manifestVersion"],
    "bootstrapVersion": manifest["bootstrapVersion"],
    "manifestSha256": manifest_sha,
    "completedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "cacheRoot": cache_root,
    "volumeMount": volume_mount,
    "models": [item["id"] for item in manifest["models"]],
    "customNodes": [item["name"] for item in manifest.get("customNodes", [])],
    "nativeNodes": manifest.get("nativeNodes", []),
    "ollamaModels": [item["name"] for item in manifest["ollama"]["models"]],
    "ollamaDigests": {item["name"]: ollama_models.get(item["name"]) for item in manifest["ollama"]["models"]},
}
with open(state_path, "w", encoding="utf-8") as handle:
    json.dump(state, handle, indent=2)
    handle.write("\n")
PY
log "bootstrap completed successfully; cache=$CACHE_ROOT persistentVolume=$VOLUME_MOUNT"
