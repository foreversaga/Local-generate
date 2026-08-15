import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRef2VCameraPlanContext,
  createDefaultRef2VCameraPlan,
  mergeNegativePromptTerms,
  normalizeRef2VCameraPlan,
} from "../app/lib/ref2v-camera-plan.mjs";

test("camera plans keep stable codes while sanitizing timing and unavailable references", () => {
  const plan = normalizeRef2VCameraPlan({
    videoPolicy: "camera_only",
    global: { style: "documentary", composition: "thirds", transition: "fade", imperfections: ["film_grain", "unknown"], avoidances: ["random_zoom"] },
    shots: [
      { startMs: 400, pictureRefs: [1, 3], primaryMotion: "push_in" },
      { startMs: 9000, pictureRefs: [2], primaryMotion: "invalid" },
    ],
  }, { duration: 5, referenceCount: 2, hasVideo: true });
  assert.equal(plan.shots[0].startMs, 0);
  assert.equal(plan.shots[1].startMs, 4999);
  assert.deepEqual(plan.shots[0].pictureRefs, [1]);
  assert.equal(plan.shots[1].primaryMotion, "auto");
  assert.deepEqual(plan.global.imperfections, ["film_grain"]);
});

test("camera plan compiles to natural English Ref2VA instructions and negative terms", () => {
  const plan = createDefaultRef2VCameraPlan({ referenceCount: 1, hasVideo: true });
  plan.global.style = "smartphone";
  plan.global.imperfections = ["autofocus_breathing"];
  plan.global.avoidances = ["random_zoom"];
  plan.shots[0].primaryMotion = "handheld_follow";
  const compiled = buildRef2VCameraPlanContext(plan, { duration: 5, referenceCount: 1, hasVideo: true });
  assert.match(compiled.context, /natural English prose/);
  assert.match(compiled.context, /casual smartphone footage/);
  assert.match(compiled.context, /handheld follow shot/);
  assert.match(compiled.context, /<Picture 1>/);
  assert.doesNotMatch(compiled.context, /手機實拍|手持跟拍/);
  assert.deepEqual(compiled.negativeTerms, ["unmotivated random zooms"]);
  assert.equal(mergeNegativePromptTerms("flicker, unmotivated random zooms", compiled.negativeTerms), "flicker, unmotivated random zooms");
});
