import { solH3Error } from "./request.mjs";

export const SOL_H3_JOB_STATES = Object.freeze([
  "queued",
  "waiting_gpu",
  "preparing",
  "qwen_running",
  "stage1_running",
  "upscaling",
  "adapting",
  "stage2_running",
  "validating",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export const SOL_H3_TERMINAL_STATES = Object.freeze(new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]));

export const SOL_H3_RESTARTABLE_STATES = Object.freeze(new Set([
  "queued",
  "waiting_gpu",
]));

const TRANSITIONS = Object.freeze({
  queued: new Set(["waiting_gpu", "cancel_requested", "cancelled", "failed"]),
  waiting_gpu: new Set(["preparing", "cancel_requested", "cancelled", "failed"]),
  preparing: new Set(["qwen_running", "cancel_requested", "cancelled", "failed", "interrupted"]),
  qwen_running: new Set(["stage1_running", "cancel_requested", "cancelled", "failed", "interrupted"]),
  stage1_running: new Set(["upscaling", "cancel_requested", "cancelled", "failed", "interrupted"]),
  upscaling: new Set(["adapting", "cancel_requested", "cancelled", "failed", "interrupted"]),
  adapting: new Set(["stage2_running", "cancel_requested", "cancelled", "failed", "interrupted"]),
  stage2_running: new Set(["validating", "cancel_requested", "cancelled", "failed", "interrupted"]),
  validating: new Set(["succeeded", "cancel_requested", "cancelled", "failed", "interrupted"]),
  cancel_requested: new Set(["cancelled", "failed", "interrupted"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
});

export function isSolH3JobState(value) {
  return SOL_H3_JOB_STATES.includes(value);
}

export function isSolH3TerminalState(value) {
  return SOL_H3_TERMINAL_STATES.has(value);
}

export function canTransitionSolH3Job(from, to) {
  if (!isSolH3JobState(from) || !isSolH3JobState(to)) return false;
  if (from === to) return true;
  return TRANSITIONS[from]?.has(to) === true;
}

export function assertSolH3JobTransition(from, to) {
  if (!canTransitionSolH3Job(from, to)) {
    throw solH3Error(
      "SOL_H3_JOB_TRANSITION_INVALID",
      `Invalid Sol-H3 job transition: ${String(from)} -> ${String(to)}.`,
      409,
      { from, to },
    );
  }
  return to;
}

export function recoveryStateForSolH3Job(status) {
  if (!isSolH3JobState(status)) {
    return { action: "ignore", status };
  }
  if (SOL_H3_RESTARTABLE_STATES.has(status)) {
    return { action: "reload", status: "queued" };
  }
  if (SOL_H3_TERMINAL_STATES.has(status)) {
    return { action: "keep", status };
  }
  return { action: "interrupt", status: "interrupted" };
}
