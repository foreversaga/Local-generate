import assert from "node:assert/strict";
import test from "node:test";

import { parseTrainingProgress } from "../server/lora-training/runner.mjs";

test("parseTrainingProgress reads tqdm numerator and denominator instead of its percentage", () => {
  assert.deepEqual(
    parseTrainingProgress("steps: 55%|█████▌     | 55/390 [00:10<01:00, 5.3it/s]"),
    { step: 55, totalSteps: 390, eta: "01:00" },
  );
});

test("parseTrainingProgress preserves global_step and general step formats", () => {
  assert.deepEqual(parseTrainingProgress("global_step: 12"), { step: 12 });
  assert.deepEqual(parseTrainingProgress("step=7/20"), { step: 7, totalSteps: 20 });
  assert.deepEqual(parseTrainingProgress("3/10 [00:01]"), { step: 3, totalSteps: 10 });
});
