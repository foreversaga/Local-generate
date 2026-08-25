#!/usr/bin/env bash

set -Eeuo pipefail

readonly SERVICE_UNIT="h3-studio-web.service"
readonly SERVICE_NAME="H3 Studio Web/API"
readonly WEB_PORT="8787"
readonly WEB_ORIGIN="http://127.0.0.1:${WEB_PORT}"
readonly HEALTH_URL="${WEB_ORIGIN}/app/api/health"
readonly APP_URL="${WEB_ORIGIN}/app"
readonly COMFY_QUEUE_URL="http://127.0.0.1:8188/queue"
readonly SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_ROOT="$(cd -- "${SCRIPT_ROOT}/.." && pwd -P)"
readonly PRODUCTION_ENTRY="${PROJECT_ROOT}/dist/server/index.js"
readonly PRODUCTION_MANIFEST="${PROJECT_ROOT}/dist/client/.vite/manifest.json"

force_restart=0
restart_attempted=0

usage() {
  cat <<'EOF'
Usage: ./scripts/restart-web-linux.sh [--force]

Restart the Linux h3-studio-web.service production Web/API process.

Options:
  --force  Restart even when active-work checks cannot be completed or report work.
  -h, --help
           Show this help message.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'WARNING: %s\n' "$*" >&2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1"
}

fetch_optional() {
  curl --silent --show-error --fail --max-time 5 "$1" 2>/dev/null || true
}

read_health_metrics() {
  node -e '
    let source = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { source += chunk; });
    process.stdin.on("end", () => {
      const payload = JSON.parse(source);
      const value = (candidate) => Number.isFinite(Number(candidate)) ? Number(candidate) : 0;
      process.stdout.write([
        value(payload?.runtime?.activeOperations),
        value(payload?.gpu?.activeCount),
        value(payload?.gpu?.queuedCount),
        payload?.comfy?.online === true ? "1" : "0",
      ].join(" "));
    });
  '
}

read_comfy_queue_metrics() {
  node -e '
    let source = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { source += chunk; });
    process.stdin.on("end", () => {
      const payload = JSON.parse(source);
      const running = Array.isArray(payload?.queue_running) ? payload.queue_running.length : 0;
      const pending = Array.isArray(payload?.queue_pending) ? payload.queue_pending.length : 0;
      process.stdout.write(`${running} ${pending}`);
    });
  '
}

assert_health_payload() {
  node -e '
    let source = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { source += chunk; });
    process.stdin.on("end", () => {
      const payload = JSON.parse(source);
      if (payload?.bridge !== true || !payload?.runtime || !payload?.gpu) process.exit(1);
    });
  '
}

show_failure_diagnostics() {
  local status=$?
  if (( status != 0 && restart_attempted == 1 )); then
    printf '\nRecent %s status:\n' "${SERVICE_UNIT}" >&2
    systemctl --user status "${SERVICE_UNIT}" --no-pager --lines=20 >&2 || true
    printf '\nRecent %s journal:\n' "${SERVICE_UNIT}" >&2
    journalctl --user --unit "${SERVICE_UNIT}" --lines=60 --no-pager >&2 || true
  fi
  exit "${status}"
}

for argument in "$@"; do
  case "${argument}" in
    --force)
      force_restart=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "Unknown argument: ${argument}"
      ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || fail "This script is Linux-only."
require_command curl
require_command find
require_command node
require_command npm
require_command systemctl
require_command systemd-run
require_command journalctl

[[ -f "${PRODUCTION_ENTRY}" ]] || fail "Production build is missing at ${PRODUCTION_ENTRY}. Run npm run build first."
[[ -f "${PRODUCTION_MANIFEST}" ]] || fail "Production asset manifest is missing at ${PRODUCTION_MANIFEST}. Run npm run build first."
newer_app_source="$(find "${PROJECT_ROOT}/app" -type f -newer "${PRODUCTION_ENTRY}" -print -quit)"
[[ -z "${newer_app_source}" ]] \
  || fail "Production build is stale; ${newer_app_source} is newer than ${PRODUCTION_ENTRY}. Run npm run build first."

systemctl --user show-environment >/dev/null 2>&1 \
  || fail "The user systemd manager is unavailable. Run this script from the interactive Linux user session."

health_payload="$(fetch_optional "${HEALTH_URL}")"
comfy_reported_online=0
if [[ -n "${health_payload}" ]]; then
  if health_metrics="$(printf '%s' "${health_payload}" | read_health_metrics)"; then
    read -r active_operations gpu_active gpu_queued comfy_reported_online <<<"${health_metrics}"
    if (( active_operations > 0 || gpu_active > 0 || gpu_queued > 0 )); then
      if (( force_restart == 0 )); then
        fail "Active Web/API work detected (operations=${active_operations}, gpu_active=${gpu_active}, gpu_queued=${gpu_queued}); refusing to interrupt it."
      fi
      warn "Forcing restart while Web/API work is active."
    fi
  elif (( force_restart == 0 )); then
    fail "The current Web/API health response is not valid JSON. Use --force only after checking active jobs manually."
  else
    warn "Ignoring an invalid Web/API health response because --force was supplied."
    health_payload=""
  fi
else
  warn "The current Web/API health endpoint is unavailable; continuing with the direct ComfyUI queue check."
fi

comfy_queue_payload="$(fetch_optional "${COMFY_QUEUE_URL}")"
if [[ -n "${comfy_queue_payload}" ]]; then
  if comfy_metrics="$(printf '%s' "${comfy_queue_payload}" | read_comfy_queue_metrics)"; then
    read -r comfy_running comfy_pending <<<"${comfy_metrics}"
    if (( comfy_running > 0 || comfy_pending > 0 )); then
      if (( force_restart == 0 )); then
        fail "ComfyUI has active work (running=${comfy_running}, pending=${comfy_pending}); refusing to interrupt its Web/API controller."
      fi
      warn "Forcing restart while the ComfyUI queue is busy."
    fi
  elif (( force_restart == 0 )); then
    fail "The ComfyUI queue response is not valid JSON. Use --force only after checking the queue manually."
  else
    warn "Ignoring an invalid ComfyUI queue response because --force was supplied."
  fi
elif (( comfy_reported_online == 1 && force_restart == 0 )); then
  fail "ComfyUI was reported online but its queue could not be checked. Retry or use --force after checking it manually."
elif [[ -z "${health_payload}" ]] && (( force_restart == 0 )); then
  fail "Neither the Web/API activity state nor the ComfyUI queue could be verified. Retry or use --force after checking active work manually."
else
  warn "ComfyUI is offline or its queue is unavailable; no ComfyUI service will be restarted."
fi

load_state="$(systemctl --user show "${SERVICE_UNIT}" --property=LoadState --value 2>/dev/null || true)"
old_pid="$(systemctl --user show "${SERVICE_UNIT}" --property=MainPID --value 2>/dev/null || true)"
old_pid="${old_pid:-0}"

trap show_failure_diagnostics EXIT
restart_attempted=1

if [[ "${load_state}" == "loaded" ]]; then
  service_working_directory="$(systemctl --user show "${SERVICE_UNIT}" --property=WorkingDirectory --value --no-pager)"
  [[ "${service_working_directory}" == "${PROJECT_ROOT}" ]] \
    || fail "${SERVICE_UNIT} belongs to a different working directory (${service_working_directory}); refusing to restart it."
  printf 'Restarting %s...\n' "${SERVICE_UNIT}"
  systemctl --user restart "${SERVICE_UNIT}"
elif [[ -z "${load_state}" || "${load_state}" == "not-found" ]]; then
  npm_binary="$(command -v npm)"
  printf 'Creating %s for %s...\n' "${SERVICE_UNIT}" "${PROJECT_ROOT}"
  systemd-run \
    --user \
    --unit="${SERVICE_UNIT%.service}" \
    --description="${SERVICE_NAME}" \
    --property=Restart=on-failure \
    --property=RestartSec=3s \
    --working-directory="${PROJECT_ROOT}" \
    --setenv="PATH=${PATH}" \
    "${npm_binary}" run start
else
  fail "Unexpected LoadState for ${SERVICE_UNIT}: ${load_state}"
fi

printf 'Waiting for %s...\n' "${HEALTH_URL}"
ready_payload=""
for _attempt in $(seq 1 60); do
  if systemctl --user is-active --quiet "${SERVICE_UNIT}"; then
    ready_payload="$(fetch_optional "${HEALTH_URL}")"
    if [[ -n "${ready_payload}" ]] && printf '%s' "${ready_payload}" | assert_health_payload; then
      break
    fi
  fi
  ready_payload=""
  sleep 0.5
done
[[ -n "${ready_payload}" ]] || fail "${SERVICE_UNIT} did not return a valid health response within 30 seconds."

app_html="$(curl --silent --show-error --fail --location --max-time 10 "${APP_URL}")" \
  || fail "${APP_URL} did not return HTTP 200 after restart."
[[ "${app_html}" == *"<!DOCTYPE html>"* && "${app_html}" == *"H3 STUDIO"* ]] \
  || fail "${APP_URL} returned an unexpected document after restart."

mapfile -t static_assets < <(
  printf '%s' "${app_html}" | node -e '
    let source = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { source += chunk; });
    process.stdin.on("end", () => {
      const matches = [...source.matchAll(/["\x27](\/_next\/static\/(?:css|chunks)\/[^"\x27?]+)["\x27]/g)];
      process.stdout.write([...new Set(matches.map((match) => match[1]))].join("\n"));
    });
  '
)
(( ${#static_assets[@]} > 0 )) || fail "No production static assets were referenced by ${APP_URL}."
for asset_path in "${static_assets[@]}"; do
  curl --silent --show-error --fail --max-time 10 --output /dev/null "${WEB_ORIGIN}${asset_path}" \
    || fail "Production asset is unavailable after restart: ${asset_path}"
done

systemctl --user is-active --quiet "${SERVICE_UNIT}" || fail "${SERVICE_UNIT} is not active after restart."
new_pid="$(systemctl --user show "${SERVICE_UNIT}" --property=MainPID --value --no-pager)"
[[ "${new_pid}" =~ ^[1-9][0-9]*$ ]] || fail "${SERVICE_UNIT} has no valid MainPID after restart."

if command -v ss >/dev/null 2>&1; then
  listener_line="$(ss --listening --tcp --numeric --processes "sport = :${WEB_PORT}" 2>/dev/null | tail -n +2 | head -n 1 || true)"
  [[ -n "${listener_line}" ]] || fail "No TCP listener was found on port ${WEB_PORT} after restart."
else
  warn "ss is unavailable; the successful HTTP checks still prove port ${WEB_PORT} is reachable."
fi

trap - EXIT
printf '%s is ready.\n' "${SERVICE_NAME}"
printf 'Service: %s (old MainPID=%s, new MainPID=%s)\n' "${SERVICE_UNIT}" "${old_pid}" "${new_pid}"
printf 'Health: %s\n' "${HEALTH_URL}"
printf 'App: %s\n' "${APP_URL}"
printf 'Static assets verified: %s\n' "${#static_assets[@]}"
printf 'ComfyUI was not restarted.\n'
