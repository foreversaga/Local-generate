"use client";

import { useState, type ChangeEvent, type ReactNode } from "react";
import { WORKFLOW_NODE_TYPES } from "../../lib/workflow-project.mjs";
import type { WorkflowNode } from "./workflow-types";
import styles from "./WorkspaceInspector.module.css";

type WorkspaceInspectorProps = {
    node: WorkflowNode | null;
    brief: string;
    locale: string;
    onBriefChange: (value: string) => void;
    onConfigChange: (patch: Record<string, unknown>) => void;
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

export function WorkspaceInspector({
    node,
    brief,
    locale,
    onBriefChange,
    onConfigChange,
}: WorkspaceInspectorProps) {
    const zh = locale.toLowerCase().startsWith("zh");
    const [advancedOpen, setAdvancedOpen] = useState(false);

    if (!node) {
        return <aside className={styles.inspector}><p className={styles.empty}>{zh ? "選取一個節點以查看設定。" : "Select a node to view its settings."}</p></aside>;
    }

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
                        <select value={stringConfig(node, "role", "character")} onChange={(event) => onConfigChange({ role: event.target.value })}>
                            <option value="character">{zh ? "角色" : "Character"}</option>
                            <option value="face">{zh ? "臉部" : "Face"}</option>
                            <option value="clothing">{zh ? "服裝" : "Clothing"}</option>
                            <option value="pose">{zh ? "姿勢" : "Pose"}</option>
                            <option value="scene">{zh ? "場景" : "Scene"}</option>
                            <option value="video">{zh ? "影片" : "Video"}</option>
                            <option value="audio">{zh ? "音訊" : "Audio"}</option>
                        </select>
                    </Field>
                    <Field label={zh ? "素材名稱" : "Asset name"} helper={zh ? "下一階段會直接連到 Library Asset Dock。" : "The next asset checkpoint connects this directly to the Library Asset Dock."}>
                        <input value={stringConfig(node, "assetName")} onChange={(event) => onConfigChange({ assetName: event.target.value })} placeholder={zh ? "尚未選擇素材" : "No asset selected"} />
                    </Field>
                </>
            )}

            {node.type === WORKFLOW_NODE_TYPES.prompt && (
                <>
                    <Field label={zh ? "Skill" : "Skill"}>
                        <select value={stringConfig(node, "skill", "auto")} onChange={(event) => onConfigChange({ skill: event.target.value })}>
                            <option value="auto">Auto</option>
                            <option value="h3-prompt">H3 Prompt</option>
                            <option value="ref2v-prompt">Ref2V Prompt</option>
                            <option value="camera-control">Camera Control</option>
                        </select>
                    </Field>
                    <Field label={zh ? "Provider" : "Provider"}>
                        <select value={stringConfig(node, "provider", "auto")} onChange={(event) => onConfigChange({ provider: event.target.value })}>
                            <option value="auto">Auto</option>
                            <option value="ollama">Ollama</option>
                            <option value="codex">Codex CLI</option>
                        </select>
                    </Field>
                    <Field label={zh ? "提示詞" : "Prompt"}>
                        <textarea value={stringConfig(node, "prompt")} onChange={(event) => onConfigChange({ prompt: event.target.value })} rows={9} placeholder={zh ? "由 Brief / Skill 產生，或直接輸入。" : "Generated from the Brief/Skill or entered directly."} />
                    </Field>
                </>
            )}

            {node.type === WORKFLOW_NODE_TYPES.h3Video && (
                <>
                    <Field label={zh ? "模式" : "Mode"}>
                        <select value={stringConfig(node, "mode", "t2v")} onChange={(event) => onConfigChange({ mode: event.target.value })}>
                            {VIDEO_MODES.map((mode) => <option key={mode} value={mode}>{VIDEO_MODE_LABELS[mode][zh ? 0 : 1]}</option>)}
                        </select>
                    </Field>
                    <Field label={zh ? "模型" : "Model"}>
                        <select value={stringConfig(node, "modelProfile", "nvfp4_blackwell")} onChange={(event) => onConfigChange({ modelProfile: event.target.value })}>
                            <option value="nvfp4_blackwell">NVFP4 Blackwell</option>
                            <option value="int4_convrot_low_vram">INT4 ConvRot</option>
                            <option value="official_pruned_int8_convrot">Official INT8</option>
                            <option value="ref2va_pruned_nvfp4">Ref2VA Pruned NVFP4</option>
                            <option value="wan22_animate_fp8">Wan2.2 Animate</option>
                        </select>
                    </Field>
                    <div className={styles.twoColumns}>
                        <Field label={zh ? "時長" : "Duration"}>
                            <NumberInput value={numberDraftConfig(node, "duration", 5)} min={1} max={60} step={1} onChange={(value) => onConfigChange({ duration: value })} />
                        </Field>
                        <Field label={zh ? "尺寸" : "Resolution"}>
                            <select value={stringConfig(node, "resolution", "736x416")} onChange={(event) => onConfigChange({ resolution: event.target.value })}>
                                <option value="736x416">736 × 416</option>
                                <option value="416x736">416 × 736</option>
                                <option value="768x768">768 × 768</option>
                                <option value="custom">{zh ? "自訂" : "Custom"}</option>
                            </select>
                        </Field>
                    </div>
                    <button type="button" className={styles.disclosure} aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
                        <span>{zh ? "進階生成設定" : "Advanced generation"}</span><span aria-hidden="true">{advancedOpen ? "−" : "+"}</span>
                    </button>
                    {advancedOpen && (
                        <div className={styles.advanced}>
                            <Field label="Steps"><NumberInput value={numberDraftConfig(node, "steps", 20)} min={1} max={100} step={1} onChange={(value) => onConfigChange({ steps: value })} /></Field>
                            <Field label="Seed"><NumberInput value={numberDraftConfig(node, "seed", 12345)} min={0} max={2147483647} step={1} onChange={(value) => onConfigChange({ seed: value })} /></Field>
                            <Field label={zh ? "LoRA" : "LoRA"}><input value={stringConfig(node, "loraName")} onChange={(event) => onConfigChange({ loraName: event.target.value })} placeholder={zh ? "選填" : "Optional"} /></Field>
                        </div>
                    )}
                    <a className={styles.primaryLink} href="/app/create/single">{zh ? "使用現有 Single 執行" : "Run with existing Single flow"}</a>
                    <p className={styles.helper}>{zh ? "目前 Workspace 已保存 H3 node 設定；直接執行仍沿用既有 Single request contract，等 controller 抽離後會在此直接生成。" : "The workspace now persists H3 node settings. Execution still uses the existing Single request contract until the shared controller extraction is complete."}</p>
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
                <p className={styles.helper}>{zh ? "完成的圖片或影片會在後續 Jobs / Asset Dock 整合階段自動連到這個節點並註冊進 Library。" : "Completed media will be linked here and registered in Library when Jobs and Asset Dock integration is enabled."}</p>
            )}
        </aside>
    );
}

function Field({ label, helper, children }: { label: string; helper?: string; children: ReactNode }) {
    return <label className={styles.field}><span>{label}</span>{children}{helper && <small>{helper}</small>}</label>;
}

function NumberInput({
    value,
    min,
    max,
    step,
    onChange,
}: {
    value: number | "";
    min: number;
    max: number;
    step: number;
    onChange: (value: number | "") => void;
}) {
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

function numberDraftConfig(node: WorkflowNode, key: string, fallback: number): number | "" {
    const value = node.config[key];
    if (value === "") return "";
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
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
        ready: ["可編輯", "Ready"],
        waiting: ["等待", "Waiting"],
        running: ["執行中", "Running"],
        complete: ["完成", "Complete"],
        error: ["失敗", "Failed"],
    };
    return labels[status]?.[zh ? 0 : 1] || status;
}
