"use client";

import { useState, type ChangeEvent, type ReactNode } from "react";
import {
    singleCreateModeDefaults,
    singleCreateModelProfilesForMode,
} from "../../lib/single-create-controller.mjs";
import { WORKFLOW_NODE_TYPES } from "../../lib/workflow-project.mjs";
import type { WorkflowNode } from "./workflow-types";
import styles from "./WorkspaceInspector.module.css";

type WorkspaceInspectorProps = {
    node: WorkflowNode | null;
    brief: string;
    locale: string;
    promptRunning?: boolean;
    promptRunError?: string;
    h3Running?: boolean;
    h3RunError?: string;
    onBriefChange: (value: string) => void;
    onConfigChange: (patch: Record<string, unknown>) => void;
    onGeneratePrompt?: (nodeId: string) => void;
    onRunH3?: (nodeId: string) => void;
};

const VIDEO_MODES = ["t2v", "i2v", "fl2v", "l2v", "ref2v", "ref2v_motion", "replace"] as const;
const VIDEO_MODE_LABELS: Record<string, [string, string]> = {
    t2v: ["文字生片", "Text to Video"],
    i2v: ["參考圖生片", "Image to Video"],
    fl2v: ["首尾幀生片", "First + Last Frame"],
    l2v: ["尾幀生片", "Last Frame to Video"],
    ref2v: ["多圖參考", "Multi-reference"],
    ref2v_motion: ["角色動作參考", "Character Motion"],
    replace: ["影片替換", "Video Replace"],
};
const MODEL_LABELS: Record<string, string> = {
    nvfp4_blackwell: "NVFP4 Blackwell",
    int4_convrot_low_vram: "INT4 ConvRot",
    official_pruned_int8_convrot: "Official INT8",
    ref2va_pruned_nvfp4: "Ref2VA Pruned NVFP4",
    wan22_animate_fp8: "Wan2.2 Animate",
};

export function WorkspaceInspector({
    node,
    brief,
    locale,
    promptRunning = false,
    promptRunError = "",
    h3Running = false,
    h3RunError = "",
    onBriefChange,
    onConfigChange,
    onGeneratePrompt,
    onRunH3,
}: WorkspaceInspectorProps) {
    const zh = locale.toLowerCase().startsWith("zh");
    const [advancedOpen, setAdvancedOpen] = useState(false);

    if (!node) {
        return <aside className={styles.inspector}><p className={styles.empty}>{zh ? "選取一個節點以查看設定。" : "Select a node to view its settings."}</p></aside>;
    }

    const mode = stringConfig(node, "mode", "t2v");
    const modeDefaults = singleCreateModeDefaults(mode);
    const modelProfiles = singleCreateModelProfilesForMode(mode);
    const width = numberDraftConfig(node, "width", modeDefaults.width);
    const height = numberDraftConfig(node, "height", modeDefaults.height);
    const duration = numberDraftConfig(node, "duration", 5);
    const resolution = resolutionValue(width, height);

    return (
        <aside className={styles.inspector} aria-label={zh ? "節點設定" : "Node inspector"}>
            <div className={styles.header}>
                <span>{nodeTypeLabel(node.type, locale)}</span>
                <h2>{node.title}</h2>
                <small>{statusLabel(node.status, locale)}</small>
            </div>

            {node.type === WORKFLOW_NODE_TYPES.brief && (
                <Field label={zh ? "專案需求" : "Project brief"} helper={zh ? "修改會自動儲存到目前專案。" : "Changes are saved automatically to this project."}>
                    <textarea value={brief} onChange={(event) => onBriefChange(event.target.value)} rows={12} maxLength={4000} />
                </Field>
            )}

            {node.type === WORKFLOW_NODE_TYPES.asset && (
                <>
                    <Field label={zh ? "素材角色" : "Asset role"}>
                        <select value={stringConfig(node, "role", "reference")} onChange={(event) => onConfigChange({ role: event.target.value })}>
                            <option value="character">{zh ? "角色" : "Character"}</option>
                            <option value="face">{zh ? "臉部" : "Face"}</option>
                            <option value="clothing">{zh ? "服裝" : "Clothing"}</option>
                            <option value="first-frame">{zh ? "首幀" : "First frame"}</option>
                            <option value="last-frame">{zh ? "尾幀" : "Last frame"}</option>
                            <option value="motion-video">{zh ? "動作影片" : "Motion video"}</option>
                            <option value="pose">{zh ? "姿勢" : "Pose"}</option>
                            <option value="scene">{zh ? "場景" : "Scene"}</option>
                            <option value="video">{zh ? "一般影片" : "Video"}</option>
                            <option value="audio">{zh ? "音訊" : "Audio"}</option>
                            <option value="reference">{zh ? "一般參考" : "Reference"}</option>
                        </select>
                    </Field>
                    <Field label={zh ? "素材名稱" : "Asset name"} helper={zh ? "素材實體仍由 Library 管理，Workspace 只保存引用與角色。" : "Library owns the file; Workspace stores only its reference and role."}>
                        <input value={stringConfig(node, "assetName")} readOnly placeholder={zh ? "尚未綁定素材" : "No asset bound"} />
                    </Field>
                </>
            )}

            {node.type === WORKFLOW_NODE_TYPES.prompt && (
                <>
                    <Field label="Skill">
                        <select value={stringConfig(node, "skill", "auto")} onChange={(event) => onConfigChange({ skill: event.target.value })}>
                            <option value="auto">Auto</option>
                            <option value="h3-prompt">H3 Prompt</option>
                            <option value="ref2v-prompt">Ref2V Prompt</option>
                            <option value="camera-control">Camera Control</option>
                        </select>
                    </Field>
                    <Field label="Provider">
                        <select value={stringConfig(node, "provider", "auto")} onChange={(event) => onConfigChange({ provider: event.target.value })}>
                            <option value="auto">Auto</option>
                            <option value="ollama">Ollama</option>
                            <option value="codex">Codex CLI</option>
                            <option value="hermes">Hermes</option>
                        </select>
                    </Field>
                    <Field label={zh ? "提示詞" : "Prompt"}>
                        <textarea value={stringConfig(node, "prompt")} onChange={(event) => onConfigChange({ prompt: event.target.value, ollamaPromptReceipt: "" })} rows={9} placeholder={zh ? "由 Brief / Skill 產生，或直接輸入。" : "Generated from the Brief/Skill or entered directly."} />
                    </Field>
                    <Field label={zh ? "負面提示詞" : "Negative prompt"}>
                        <textarea value={stringConfig(node, "negativePrompt")} onChange={(event) => onConfigChange({ negativePrompt: event.target.value })} rows={5} placeholder={zh ? "選填" : "Optional"} />
                    </Field>
                    <button type="button" className={styles.primaryButton} disabled={promptRunning || !onGeneratePrompt} onClick={() => onGeneratePrompt?.(node.id)}>
                        {promptRunning ? (zh ? "產生提示詞中…" : "Generating prompt…") : (zh ? "從 Brief 產生提示詞" : "Generate from Brief")}
                    </button>
                    {promptRunError && <p className={styles.runError} role="alert">{promptRunError}</p>}
                    <p className={styles.helper}>{zh ? "Auto 會沿用 Settings 的提示詞提供者與模型；圖片/影片模式會把 Project 素材一併送到現有提示詞 API。" : "Auto uses the provider and model from Settings; visual modes send the Project assets through the existing prompt API."}</p>
                </>
            )}

            {node.type === WORKFLOW_NODE_TYPES.h3Video && (
                <>
                    <Field label={zh ? "模式" : "Mode"}>
                        <select
                            value={mode}
                            onChange={(event) => {
                                const nextMode = event.target.value;
                                const defaults = singleCreateModeDefaults(nextMode);
                                onConfigChange({ mode: nextMode, ...defaults });
                            }}
                        >
                            {VIDEO_MODES.map((option) => <option key={option} value={option}>{VIDEO_MODE_LABELS[option][zh ? 0 : 1]}</option>)}
                        </select>
                    </Field>
                    <Field label={zh ? "模型" : "Model"}>
                        <select value={stringConfig(node, "modelProfile", modeDefaults.modelProfile)} onChange={(event) => onConfigChange({ modelProfile: event.target.value })}>
                            {modelProfiles.map((profile) => <option key={profile} value={profile}>{MODEL_LABELS[profile] || profile}</option>)}
                        </select>
                    </Field>
                    <div className={styles.twoColumns}>
                        <Field label={zh ? "時長" : "Duration"}>
                            <NumberInput value={duration} min={1} max={60} step={1} onChange={(value) => onConfigChange({ duration: value, ...(mode === "ref2v_motion" && typeof value === "number" ? { referenceVideoEnd: Number(numberDraftConfig(node, "referenceVideoStart", 0)) + value } : {}) })} />
                        </Field>
                        <Field label={zh ? "尺寸" : "Resolution"}>
                            <select
                                value={resolution}
                                onChange={(event) => {
                                    const parsed = parseResolution(event.target.value);
                                    if (parsed) onConfigChange(parsed);
                                }}
                            >
                                <option value="736x416">736 × 416</option>
                                <option value="416x736">416 × 736</option>
                                <option value="768x768">768 × 768</option>
                                <option value="832x480">832 × 480</option>
                                <option value="custom">{zh ? "自訂" : "Custom"}</option>
                            </select>
                        </Field>
                    </div>
                    {resolution === "custom" && (
                        <div className={styles.twoColumns}>
                            <Field label={zh ? "寬度" : "Width"}><NumberInput value={width} min={32} max={2048} step={32} onChange={(value) => onConfigChange({ width: value })} /></Field>
                            <Field label={zh ? "高度" : "Height"}><NumberInput value={height} min={32} max={2048} step={32} onChange={(value) => onConfigChange({ height: value })} /></Field>
                        </div>
                    )}

                    {mode === "ref2v_motion" && (
                        <div className={styles.advancedInline}>
                            <div className={styles.twoColumns}>
                                <Field label={zh ? "動作開始秒數" : "Motion start"}><NumberInput value={numberDraftConfig(node, "referenceVideoStart", 0)} min={0} max={60} step={0.5} onChange={(value) => onConfigChange({ referenceVideoStart: value, ...(typeof value === "number" && typeof duration === "number" ? { referenceVideoEnd: value + duration } : {}) })} /></Field>
                                <Field label={zh ? "動作結束秒數" : "Motion end"}><NumberInput value={numberDraftConfig(node, "referenceVideoEnd", Number(duration) || 5)} min={0.5} max={60} step={0.5} onChange={(value) => onConfigChange({ referenceVideoEnd: value, ...(typeof value === "number" ? { duration: Math.max(0.5, value - Number(numberDraftConfig(node, "referenceVideoStart", 0))) } : {}) })} /></Field>
                            </div>
                            <Field label={zh ? "動作影片解析度上限" : "Motion video max dimension"}>
                                <select value={String(numberDraftConfig(node, "referenceVideoMaxDimension", 720))} onChange={(event) => onConfigChange({ referenceVideoMaxDimension: Number(event.target.value) })}>
                                    <option value="0">{zh ? "原始" : "Original"}</option>
                                    <option value="480">480</option>
                                    <option value="720">720</option>
                                    <option value="960">960</option>
                                </select>
                            </Field>
                            <Field label={zh ? "服裝來源" : "Clothing source"}>
                                <select value={stringConfig(node, "clothingMode", "character")} onChange={(event) => onConfigChange({ clothingMode: event.target.value })}>
                                    <option value="character">{zh ? "沿用角色" : "Character"}</option>
                                    <option value="reference">{zh ? "服裝參考圖" : "Reference images"}</option>
                                    <option value="description">{zh ? "文字描述" : "Description"}</option>
                                </select>
                            </Field>
                            {stringConfig(node, "clothingMode", "character") === "description" && (
                                <Field label={zh ? "服裝描述" : "Clothing description"}>
                                    <textarea value={stringConfig(node, "clothingDescription")} onChange={(event) => onConfigChange({ clothingDescription: event.target.value })} rows={4} />
                                </Field>
                            )}
                        </div>
                    )}

                    <button type="button" className={styles.disclosure} aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
                        <span>{zh ? "進階生成設定" : "Advanced generation"}</span><span aria-hidden="true">{advancedOpen ? "−" : "+"}</span>
                    </button>
                    {advancedOpen && (
                        <div className={styles.advanced}>
                            <Field label="Steps"><NumberInput value={numberDraftConfig(node, "steps", modeDefaults.steps)} min={1} max={80} step={1} onChange={(value) => onConfigChange({ steps: value })} /></Field>
                            <Field label="Seed"><NumberInput value={numberDraftConfig(node, "seed", 12345)} min={0} max={2147483647} step={1} onChange={(value) => onConfigChange({ seed: value })} /></Field>
                            <Field label={zh ? "輸出名稱" : "Output name"}><input value={stringConfig(node, "outputName")} onChange={(event) => onConfigChange({ outputName: event.target.value })} placeholder={zh ? "選填" : "Optional"} /></Field>
                            {mode === "replace" ? (
                                <>
                                    <Field label="Character LoRA"><input value={stringConfig(node, "loraName")} onChange={(event) => onConfigChange({ loraName: event.target.value })} placeholder={zh ? "選填" : "Optional"} /></Field>
                                    <Field label={zh ? "LoRA 強度" : "LoRA strength"}><NumberInput value={numberDraftConfig(node, "loraStrength", 0.75)} min={0} max={2} step={0.05} onChange={(value) => onConfigChange({ loraStrength: value })} /></Field>
                                </>
                            ) : (
                                <>
                                    <Field label="H3 Realism People">
                                        <select value={booleanConfig(node, "h3LoraEnabled", false) ? "on" : "off"} onChange={(event) => onConfigChange({ h3LoraEnabled: event.target.value === "on" })}>
                                            <option value="off">{zh ? "不套用" : "Off"}</option>
                                            <option value="on">{zh ? "套用" : "On"}</option>
                                        </select>
                                    </Field>
                                    {booleanConfig(node, "h3LoraEnabled", false) && <Field label={zh ? "H3 LoRA 強度" : "H3 LoRA strength"}><NumberInput value={numberDraftConfig(node, "h3LoraStrength", 0.8)} min={0} max={2} step={0.05} onChange={(value) => onConfigChange({ h3LoraStrength: value })} /></Field>}
                                </>
                            )}
                        </div>
                    )}
                    <button type="button" className={styles.primaryButton} disabled={h3Running || !onRunH3} onClick={() => onRunH3?.(node.id)}>
                        {h3Running ? (zh ? "建立工作中…" : "Creating job…") : (zh ? "直接執行 H3" : "Run H3")}
                    </button>
                    {h3RunError && <p className={styles.runError} role="alert">{h3RunError}</p>}
                    <p className={styles.helper}>{zh ? "會使用 Project 的 Prompt 與素材角色直接建立既有 Single Video Job；生成狀態會自動綁回這個節點。" : "Creates the existing Single Video job directly from the Project prompt and asset roles, then binds progress back to this node."}</p>
                </>
            )}

            {node.type === WORKFLOW_NODE_TYPES.openPose && (
                <>
                    <Field label={zh ? "ControlNet 強度" : "ControlNet strength"}>
                        <NumberInput value={numberDraftConfig(node, "strength", 0.8)} min={0} max={2} step={0.05} onChange={(value) => onConfigChange({ strength: value })} />
                    </Field>
                    <a className={styles.secondaryLink} href="/app/tools/pose-to-image">{zh ? "開啟現有 OpenPose 工具" : "Open existing OpenPose tool"}</a>
                </>
            )}

            {node.type === WORKFLOW_NODE_TYPES.upscale && (
                <>
                    <Field label={zh ? "放大倍率" : "Scale"}>
                        <select value={stringConfig(node, "scale", "2")} onChange={(event) => onConfigChange({ scale: event.target.value })}>
                            <option value="2">2×</option>
                            <option value="4">4×</option>
                        </select>
                    </Field>
                    <a className={styles.secondaryLink} href="/app/tools/upscale">{zh ? "開啟現有升頻工具" : "Open existing Upscale tool"}</a>
                </>
            )}

            {node.type === WORKFLOW_NODE_TYPES.output && (
                <p className={styles.helper}>{zh ? "生成結果會由既有 Job backend 註冊進 Library；在 Activity 可直接開啟結果。" : "The existing job backend registers completed media in Library; open the result from Activity."}</p>
            )}
        </aside>
    );
}

function Field({ label, helper, children }: { label: string; helper?: string; children: ReactNode }) {
    return <label className={styles.field}><span>{label}</span>{children}{helper && <small>{helper}</small>}</label>;
}

function NumberInput({ value, min, max, step, onChange }: { value: number | ""; min: number; max: number; step: number; onChange: (value: number | "") => void }) {
    function handleChange(event: ChangeEvent<HTMLInputElement>) {
        const next = event.target.value;
        onChange(next === "" ? "" : Number(next));
    }
    return <input type="number" value={value} min={min} max={max} step={step} onChange={handleChange} />;
}

function stringConfig(node: WorkflowNode, key: string, fallback = "") {
    const value = node.config[key];
    return typeof value === "string" ? value : fallback;
}

function booleanConfig(node: WorkflowNode, key: string, fallback: boolean) {
    const value = node.config[key];
    return typeof value === "boolean" ? value : fallback;
}

function numberDraftConfig(node: WorkflowNode, key: string, fallback: number): number | "" {
    const value = node.config[key];
    if (value === "") return "";
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function resolutionValue(width: number | "", height: number | "") {
    if (width === "" || height === "") return "custom";
    const value = `${width}x${height}`;
    return ["736x416", "416x736", "768x768", "832x480"].includes(value) ? value : "custom";
}

function parseResolution(value: string) {
    if (value === "custom") return null;
    const [width, height] = value.split("x").map(Number);
    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}

function nodeTypeLabel(type: string, locale: string) {
    const zh = locale.toLowerCase().startsWith("zh");
    const labels: Record<string, [string, string]> = {
        [WORKFLOW_NODE_TYPES.brief]: ["需求", "Brief"],
        [WORKFLOW_NODE_TYPES.asset]: ["素材", "Asset"],
        [WORKFLOW_NODE_TYPES.prompt]: ["提示詞", "Prompt"],
        [WORKFLOW_NODE_TYPES.h3Video]: ["影片生成", "Video generation"],
        [WORKFLOW_NODE_TYPES.openPose]: ["姿勢", "Pose"],
        [WORKFLOW_NODE_TYPES.upscale]: ["升頻", "Upscale"],
        [WORKFLOW_NODE_TYPES.output]: ["輸出", "Output"],
    };
    return labels[type]?.[zh ? 0 : 1] || type;
}

function statusLabel(status: string, locale: string) {
    const zh = locale.toLowerCase().startsWith("zh");
    const labels: Record<string, [string, string]> = {
        ready: ["可編輯", "Ready"], waiting: ["等待", "Waiting"], running: ["執行中", "Running"], complete: ["完成", "Complete"], error: ["失敗", "Failed"],
    };
    return labels[status]?.[zh ? 0 : 1] || status;
}
