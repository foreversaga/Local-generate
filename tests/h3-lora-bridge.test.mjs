import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const isolatedSingleVideoRoot = await mkdtemp(path.join(os.tmpdir(), "h3-lora-bridge-jobs-"));
process.env.MINIMAX_H3_SINGLE_VIDEO_DATA_ROOT = isolatedSingleVideoRoot;
after(async () => {
  await rm(isolatedSingleVideoRoot, { recursive: true, force: true });
});

const {
  H3_REALISM_PEOPLE_LORA_NAME,
  H3_REALISM_PEOPLE_TRIGGER,
  H3_REALISM_PEOPLE_DEFAULT_STRENGTH,
  resolveH3LoraSelection,
  injectH3LoraTrigger,
  h3RuntimeGraphSupportsMode,
  promptMode,
} = await import("../local-bridge.mjs");

test("H3 Realism People selection is canonical and defaults to 0.8", () => {
  const selection = resolveH3LoraSelection({ mode: "t2v", h3LoraEnabled: true }, "t2v");
  assert.deepEqual(selection, {
    selected: true,
    name: H3_REALISM_PEOPLE_LORA_NAME,
    trigger: H3_REALISM_PEOPLE_TRIGGER,
    strength: H3_REALISM_PEOPLE_DEFAULT_STRENGTH,
    preset: H3_REALISM_PEOPLE_LORA_NAME,
  });
});

test("H3 trigger injection is idempotent and respects complete-token boundaries", () => {
  assert.equal(injectH3LoraTrigger("a person walks"), "r34l1sm, a person walks");
  assert.equal(injectH3LoraTrigger("r34l1sm, a person walks"), "r34l1sm, a person walks");
  assert.equal(injectH3LoraTrigger("r34l1smatic person"), "r34l1sm, r34l1smatic person");
});

test("H3 preset cannot be routed to Wan replacement or renamed arbitrarily", () => {
  assert.throws(
    () => resolveH3LoraSelection({ mode: "replace", h3LoraEnabled: true }, "replace"),
    (error) => error.code === "H3_LORA_MODE_UNSUPPORTED" && error.status === 422,
  );
  assert.throws(
    () => resolveH3LoraSelection({ mode: "t2v", h3LoraEnabled: true, characterLoraName: "other.safetensors" }, "t2v"),
    (error) => error.code === "H3_LORA_PRESET_NAME_INVALID" && error.status === 400,
  );
  assert.throws(
    () => resolveH3LoraSelection({ mode: "t2v", h3LoraEnabled: true, characterLoraId: "registry-id" }, "t2v"),
    (error) => error.code === "H3_LORA_ID_INVALID" && error.status === 400,
  );
});

test("H3 graph capability distinguishes Ref2V from image modes", () => {
  const info = { MiniMaxH3ImageToVideo: {}, MiniMaxH3ReferenceToVideo: {} };
  assert.equal(h3RuntimeGraphSupportsMode(info, "t2v"), true);
  assert.equal(h3RuntimeGraphSupportsMode(info, "ref2v"), true);
  assert.equal(h3RuntimeGraphSupportsMode(info, "r2v"), true);
  assert.equal(h3RuntimeGraphSupportsMode({ MiniMaxH3ImageToVideo: {} }, "ref2v"), false);
});

test("native R2V mode spelling canonicalizes to the Ref2V bridge path", () => {
  assert.equal(promptMode("r2v"), "ref2v");
  assert.equal(resolveH3LoraSelection({ mode: "r2v", h3LoraEnabled: true }, "r2v").name, H3_REALISM_PEOPLE_LORA_NAME);
});
