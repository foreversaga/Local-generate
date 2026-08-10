import assert from "node:assert/strict";
import test from "node:test";
import { draftForCreateAsset } from "../app/lib/create-asset-start.mjs";

const IMAGE = { root: "input", name: "first.png", kind: "image" };
const VIDEO = { root: "input", name: "motion.mp4", kind: "video" };

test("Create asset picker maps images into Single I2V draft role", () => {
    const draft = draftForCreateAsset(null, IMAGE);
    assert.equal(draft.mode, "i2v");
    assert.equal(draft.referenceImageKey, "input:first.png");
    assert.equal(draft.sourceVideoKey, null);
});

test("Create asset picker maps videos into Single Ref2V draft role and preserves existing prompt", () => {
    const existing = JSON.stringify({
        version: 1,
        prompt: "Keep this prompt",
        mode: "t2v",
    });
    const draft = draftForCreateAsset(existing, VIDEO);
    assert.equal(draft.mode, "ref2v");
    assert.equal(draft.modelProfile, "ref2va_pruned_nvfp4");
    assert.equal(draft.sourceVideoKey, "input:motion.mp4");
    assert.equal(draft.prompt, "Keep this prompt");
});
