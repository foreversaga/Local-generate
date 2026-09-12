import test from "node:test";
import assert from "node:assert/strict";

import { parseSolH3RunnerTiming } from "../server/sol-h3/timing.mjs";

test("maps official runner warmup and formal E2E timing to milliseconds", () => {
  const timing = parseSolH3RunnerTiming({
    startup_and_warmup_s: 321.546956717,
    requests: [{
      status: "PASS",
      e2e_s: 62.370506014,
      qwen_s: 2.431639926,
      stage1_s: 18.212206884,
      stage2_s: 38.848562876,
      stage2_phases_s: { joint_video_audio_stage2_s: 28.62845 },
    }],
  });

  assert.deepEqual(timing, {
    source: "official-sol-h3-results",
    startupAndWarmupMs: 321547,
    formalGenerationMs: 62371,
    qwenMs: 2432,
    stage1Ms: 18212,
    stage2Ms: 38849,
    stage2PhasesMs: { joint_video_audio_stage2_s: 28628 },
    requestCount: 1,
  });
});

test("does not invent timing when the runner report has no measurements", () => {
  assert.equal(parseSolH3RunnerTiming({ status: "PASS", requests: [] }), null);
  assert.equal(parseSolH3RunnerTiming(null), null);
});
