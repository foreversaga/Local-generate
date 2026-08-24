import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_LABELS,
  FIELD_LABELS,
  NAV_LABELS,
  localizedCopy,
  jobStatusLabel,
  readinessLabel,
  sourceLabel,
} from "../app/lib/ui-copy.mjs";

test("shared UI copy keeps navigation, actions, fields, and sources in zh-TW", () => {
  assert.deepEqual(NAV_LABELS, {
    create: "建立",
    jobs: "工作",
    library: "素材庫",
    tools: "工具",
    settings: "設定",
  });
  assert.equal(ACTION_LABELS.details, "查看詳情");
  assert.equal(ACTION_LABELS.browseLibrary, "從素材庫選擇");
  assert.equal(ACTION_LABELS.openOutput, "查看結果");
  assert.equal(FIELD_LABELS.prompt, "提示詞（Prompt）");
  assert.equal(FIELD_LABELS.negativePrompt, "負面提示詞");
  assert.equal(FIELD_LABELS.steps, "採樣步數（Steps）");
  assert.equal(FIELD_LABELS.seed, "隨機種子（Seed）");
  assert.equal(sourceLabel("training"), "訓練資料");
  assert.equal(sourceLabel("text2img"), "文字生圖");
  assert.equal(sourceLabel("output"), "生成結果");
});

test("shared UI copy maps backend statuses and tool domains", () => {
  const expected = {
    queued: "排隊中",
    running: "執行中",
    processing: "處理中",
    complete: "已完成",
    partial: "部分完成",
    failed: "失敗",
    error: "失敗",
    cancelled: "已取消",
    paused: "已暫停",
    checking: "檢查中",
    ready: "已就緒",
    unavailable: "無法使用",
    needs_attention: "需要處理",
  };
  for (const [status, label] of Object.entries(expected)) assert.equal(jobStatusLabel(status), label);
  assert.equal(jobStatusLabel("running", "video"), "生成中");
  assert.equal(jobStatusLabel("running", "upscale"), "升頻中");
  assert.equal(jobStatusLabel("running", "text2img"), "生成中");
  assert.equal(jobStatusLabel("running", "img2img"), "生成中");
  assert.equal(jobStatusLabel("running", "lora"), "訓練中");
  assert.equal(readinessLabel("needs_attention"), "需要處理");
});

test("shared UI copy presents English without changing backend values", () => {
  const english = localizedCopy("en");
  assert.equal(english.NAV_LABELS.create, "Create");
  assert.equal(english.ACTION_LABELS.details, "View details");
  assert.equal(english.FIELD_LABELS.prompt, "Prompt");
  assert.equal(jobStatusLabel("running", "upscale", "en"), "Upscaling");
  assert.equal(jobStatusLabel("needs_attention", undefined, "en"), "Needs attention");
  assert.equal(sourceLabel("long", "en"), "Long video");
  assert.equal(sourceLabel("text2img", "en"), "Text to Image");
  assert.equal(readinessLabel("ready", "en"), "Ready");
});
