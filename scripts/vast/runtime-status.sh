#!/usr/bin/env bash
set -euo pipefail

readonly MANIFEST_PATH="${H3_RUNTIME_MANIFEST:-/workspace/runtime-manifest.json}"
readonly STATE_PATH="${H3_RUNTIME_STATE:-/workspace/.h3-runtime-state.json}"
readonly PYTHON_BIN="${H3_RUNTIME_PYTHON:-/venv/main/bin/python}"

"$PYTHON_BIN" - "$MANIFEST_PATH" "$STATE_PATH" <<'PY'
import hashlib
import json
import os
import subprocess
import sys
import urllib.request

manifest_path, state_path = sys.argv[1:]

def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return None

manifest = read_json(manifest_path)
state = read_json(state_path)
if not manifest:
    print(json.dumps({"ok": False, "error": "manifest_missing", "manifestPath": manifest_path}))
    raise SystemExit(0)

def file_status(item):
    path = item["targetPath"]
    if not os.path.isfile(path):
        return {"id": item["id"], "path": path, "status": "missing"}
    size = os.path.getsize(path)
    if size != item["size"]:
        return {"id": item["id"], "path": path, "status": "size-mismatch", "size": size, "expectedSize": item["size"]}
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    return {"id": item["id"], "path": path, "status": "ok" if actual == item["sha256"] else "sha256-mismatch", "sha256": actual, "expectedSha256": item["sha256"]}

def git_status(item):
    path = item["path"]
    if not os.path.isdir(os.path.join(path, ".git")):
        return {"name": item.get("name", "ComfyUI"), "path": path, "status": "missing", "expectedRevision": item["revision"]}
    try:
        actual = subprocess.check_output(["git", "-C", path, "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return {"name": item.get("name", "ComfyUI"), "path": path, "status": "unreadable", "expectedRevision": item["revision"]}
    return {"name": item.get("name", "ComfyUI"), "path": path, "status": "ok" if actual == item["revision"] else "revision-drift", "actualRevision": actual, "expectedRevision": item["revision"]}

try:
    comfy_port = manifest.get("remote", {}).get("comfyPort", 18188)
    with urllib.request.urlopen(f"http://127.0.0.1:{comfy_port}/object_info", timeout=5) as response:
        object_info = json.load(response)
except Exception as exc:
    object_info = None

native_nodes = []
for node_name in manifest.get("nativeNodes", []):
    native_nodes.append({
        "name": node_name,
        "status": "ok" if object_info and node_name in object_info else "missing",
    })
if object_info is None:
    native_nodes.append({"name": "ComfyUI /object_info", "status": "unavailable"})

try:
    with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=3) as response:
        ollama_payload = json.load(response)
except Exception as exc:
    ollama_payload = {"error": str(exc), "models": []}

ollama_by_name = {item.get("name"): item for item in ollama_payload.get("models", [])}
ollama_status = []
for item in manifest["ollama"]["models"]:
    actual = ollama_by_name.get(item["name"])
    if not actual:
        ollama_status.append({"name": item["name"], "status": "missing", "expectedDigest": item.get("digest")})
        continue
    expected_digest = item.get("digest") or (state or {}).get("ollamaDigests", {}).get(item["name"])
    digest_ok = expected_digest is None or actual.get("digest") == expected_digest
    status = "ok" if digest_ok and expected_digest else ("unverified" if digest_ok else "digest-drift")
    ollama_status.append({"name": item["name"], "status": status, "digest": actual.get("digest"), "expectedDigest": expected_digest, "size": actual.get("size")})

components = {
    "comfyui": git_status(manifest["comfyui"]),
    "customNodes": [git_status(item) for item in manifest.get("customNodes", [])],
    "nativeNodes": native_nodes,
    "models": [file_status(item) for item in manifest["models"]],
    "ollama": ollama_status,
}
storage = manifest.get("persistent", {})
storage_status = {
    "volumeMount": storage.get("volumeMount"),
    "cacheRoot": storage.get("cacheRoot"),
    "cachePresent": bool(storage.get("cacheRoot") and os.path.isdir(storage["cacheRoot"])),
    "statePresent": os.path.isfile(state_path),
}
state_ok = bool(state and state.get("manifestSha256"))
drift = []
if not state:
    drift.append("state-missing")
elif state.get("manifestVersion") != manifest.get("manifestVersion"):
    drift.append("manifest-version-drift")
elif state.get("manifestSha256") != sha256_file(manifest_path):
    drift.append("manifest-checksum-drift")
for group in components.values():
    values = group if isinstance(group, list) else [group]
    drift.extend(f"{item.get('name', item.get('id', 'component'))}:{item['status']}" for item in values if item.get("status") != "ok")

print(json.dumps({
    "ok": not drift,
    "manifestVersion": manifest.get("manifestVersion"),
    "bootstrapVersion": manifest.get("bootstrapVersion"),
    "manifestPath": manifest_path,
    "statePath": state_path,
    "statePresent": state_ok,
    "storage": storage_status,
    "drift": drift,
    "components": components,
}, separators=(",", ":")))
PY
