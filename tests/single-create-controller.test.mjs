import assert from "node:assert/strict";
import test from "node:test";
import {
    prepareSingleRenderBatch,
    singleCreateModeDefaults,
    singleCreateModelProfilesForMode,
} from "../app/lib/single-create-controller.mjs";

test("single create controller exposes mode-specific defaults and model compatibility", () => {
    assert.deepEqual(singleCreateModeDefaults("t2v"), {
        modelProfile: "nvfp4_blackwell",
        width: 736,
        height: 416,
        steps: 20,
    });
    assert.deepEqual(singleCreateModeDefaults("ref2v_motion"), {
        modelProfile: "ref2va_pruned_nvfp4",
        width: 736,
        height: 416,
        steps: 20,
    });
    assert.deepEqual(singleCreateModeDefaults("replace"), {
        modelProfile: "wan22_animate_fp8",
        width: 832,
        height: 480,
        steps: 6,
    });
    assert.deepEqual(singleCreateModelProfilesForMode("replace"), ["wan22_animate_fp8"]);
});

test("single create controller gates invalid input before building bridge requests", () => {
    const prepared = prepareSingleRenderBatch({
        mode: "i2v",
        prompt: "",
        negativePrompt: "",
        modelProfile: "nvfp4_blackwell",
        width: 736,
        height: 416,
        duration: 5,
        steps: 20,
        seed: 12345,
        renderCount: 1,
        referenceImage: null,
        referenceImages: [],
        lastFrameImage: null,
        sourceVideo: null,
    });

    assert.equal(prepared.requests.length, 0);
    assert.deepEqual(prepared.issues.map((issue) => issue.field), ["prompt", "referenceImage"]);
});

test("single create controller builds deterministic batch payloads with existing request semantics", () => {
    const prepared = prepareSingleRenderBatch({
        mode: "t2v",
        initialDescription: "A short beach walk",
        prompt: "A person walks naturally along the beach.",
        negativePrompt: "flicker",
        modelProfile: "nvfp4_blackwell",
        width: 736,
        height: 416,
        duration: 5,
        steps: 20,
        seed: 100,
        renderCount: 2,
        outputName: "beach.mp4",
        h3LoraEnabled: false,
        h3LoraStrength: 0.8,
        referenceImage: null,
        referenceImages: [],
        lastFrameImage: null,
        sourceVideo: null,
    }, { batchIdFactory: () => "batch-fixed" });

    assert.equal(prepared.issues.length, 0);
    assert.equal(prepared.requests.length, 2);
    assert.equal(prepared.requests[0].mode, "t2v");
    assert.equal(prepared.requests[0].seed, 100);
    assert.equal(prepared.requests[1].seed, 101);
    assert.equal(prepared.requests[0].batchId, "batch-fixed");
    assert.equal(prepared.requests[0].batchIndex, 1);
    assert.equal(prepared.requests[1].batchIndex, 2);
    assert.equal(prepared.requests[0].batchTotal, 2);
    assert.equal(prepared.requests[0].outputName, "beach-1");
    assert.equal(prepared.requests[1].outputName, "beach-2");
    assert.equal(prepared.requests[0].h3LoraEnabled, false);
    assert.equal(prepared.requests[0].characterLoraName, null);
});

test("single create controller normalizes character motion into the existing ref2v bridge contract", () => {
    const character = { name: "character.png", root: "input", kind: "image" };
    const motion = { name: "motion.mp4", root: "input", kind: "video" };
    const prepared = prepareSingleRenderBatch({
        mode: "ref2v_motion",
        initialDescription: "Keep identity and follow the motion.",
        prompt: "Use the reference identity and reproduce the motion naturally.",
        negativePrompt: "identity drift",
        modelProfile: "ref2va_pruned_nvfp4",
        width: 736,
        height: 416,
        duration: 5,
        steps: 20,
        seed: 9,
        renderCount: 1,
        h3LoraEnabled: false,
        referenceImage: null,
        referenceImages: [character],
        faceReferenceImages: [],
        clothingReferenceImages: [],
        clothingMode: "character",
        clothingDescription: "",
        sourceVideo: motion,
        referenceVideoStart: 0,
        referenceVideoEnd: 5,
        referenceVideoMaxDimension: 720,
        lastFrameImage: null,
    });

    assert.equal(prepared.issues.length, 0);
    assert.equal(prepared.requestMode, "ref2v");
    assert.equal(prepared.requests[0].mode, "ref2v");
    assert.equal(prepared.requests[0].ref2vWorkflow, "character_motion");
    assert.deepEqual(prepared.requests[0].referenceImageNames, ["character.png"]);
    assert.equal(prepared.requests[0].inputVideoName, "motion.mp4");
    assert.equal(prepared.requests[0].referenceVideoStart, 0);
    assert.equal(prepared.requests[0].referenceVideoEnd, 5);
});
