import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRef2VCharacterMotionContext,
  buildRef2VOrderedReferences,
  normalizeRef2VReferencePlan,
} from "../app/lib/ref2v-reference-plan.mjs";

test("orders character, face, then clothing references with aligned roles", () => {
  const result = buildRef2VOrderedReferences({
    characterImages: ["character-a", "character-b"],
    faceImages: ["face-a", "face-b"],
    clothingMode: "reference",
    clothingImages: ["outfit-a", "outfit-b"],
  });
  assert.deepEqual(result.references, ["character-a", "character-b", "face-a", "face-b", "outfit-a", "outfit-b"]);
  assert.deepEqual(result.roles, ["character", "character", "face", "face", "clothing", "clothing"]);
});

test("normalizes and validates the character-motion reference contract", () => {
  const plan = normalizeRef2VReferencePlan({
    workflow: "character_motion",
    referenceImageNames: ["hero.png", "face.png", "coat.png"],
    referenceImageRoles: ["character", "face", "clothing"],
    clothingMode: "reference",
  });
  assert.equal(plan.workflow, "character_motion");
  assert.throws(() => normalizeRef2VReferencePlan({
    workflow: "character_motion",
    referenceImageNames: ["face.png", "hero.png"],
    referenceImageRoles: ["face", "character"],
  }), { code: "REFERENCE_IMAGE_ROLE_ORDER_INVALID" });
  assert.throws(() => normalizeRef2VReferencePlan({
    workflow: "character_motion",
    referenceImageNames: ["hero.png"],
    referenceImageRoles: ["character"],
    clothingMode: "description",
  }), { code: "CLOTHING_DESCRIPTION_REQUIRED" });
});

test("compiles exact Picture labels and custom clothing into Ref2VA context", () => {
  const plan = normalizeRef2VReferencePlan({
    workflow: "character_motion",
    referenceImageNames: ["hero-a.png", "hero-b.png", "face.png", "coat.png"],
    referenceImageRoles: ["character", "character", "face", "clothing"],
    clothingMode: "reference",
  });
  const context = buildRef2VCharacterMotionContext(plan, { sourceVideoName: "dance.mp4" });
  assert.match(context, /<Picture 1> and <Picture 2> are the character-identity reference images/u);
  assert.match(context, /<Picture 3> is an additional high-detail facial/u);
  assert.match(context, /<Picture 4> is a clothing-only/u);
  assert.match(context, /<Video 1>.*dance\.mp4/u);
  assert.match(context, /attribute_transfer/u);

  const described = buildRef2VCharacterMotionContext(normalizeRef2VReferencePlan({
    workflow: "character_motion",
    referenceImageNames: ["hero.png"],
    referenceImageRoles: ["character"],
    clothingMode: "description",
    clothingDescription: "white leather jacket",
  }));
  assert.match(described, /white leather jacket/u);
  assert.match(described, /integrated into <Subject 1>/u);
});
