"use client";

import { useState } from "react";
import { WORKFLOW_CHECKPOINT_TYPES } from "../../lib/workflow-checkpoints.mjs";
import type { WorkflowCheckpoint } from "./workflow-types";
import styles from "./WorkspaceCheckpoints.module.css";

type WorkspaceCheckpointsProps = {
    locale: string;
    checkpoints: WorkflowCheckpoint[];
    onCreate: (type: string) => void;
    onApprove: (checkpointId: string) => void;
    onReopen: (checkpointId: string) => void;
    onRestore: (checkpointId: string) => void;
};

export function WorkspaceCheckpoints({
    locale,
    checkpoints,
    onCreate,
    onApprove,
    onReopen,
    onRestore,
}: WorkspaceCheckpointsProps) {
    const zh = locale.toLowerCase().startsWith("zh");
    const copy = checkpointCopy(zh);
    const [type, setType] = useState("render-ready");

    function restore(checkpointId: string) {
        if (!window.confirm(copy.restoreConfirm)) return;
        onRestore(checkpointId);
    }

    return (
        <section className={styles.panel} aria-label={copy.title}>
            <header className={styles.header}>
                <div>
                    <span>CHECKPOINTS</span>
                    <h2>{copy.title}</h2>
                </div>
                <div className={styles.createControls}>
                    <select value={type} onChange={(event) => setType(event.target.value)} aria-label={copy.type}>
                        {WORKFLOW_CHECKPOINT_TYPES.map((option) => (
                            <option key={option} value={option}>{checkpointTypeLabel(option, zh)}</option>
                        ))}
                    </select>
                    <button type="button" onClick={() => onCreate(type)}>{copy.create}</button>
                </div>
            </header>

            <p className={styles.description}>{copy.description}</p>

            <div className={styles.list}>
                {[...checkpoints].reverse().slice(0, 8).map((checkpoint) => (
                    <article key={checkpoint.id} className={styles.item}>
                        <div className={styles.itemMain}>
                            <span className={styles.status} data-status={checkpoint.status} aria-hidden="true" />
                            <div>
                                <strong>{checkpoint.label || checkpointTypeLabel(checkpoint.type, zh)}</strong>
                                <small>{checkpointTypeLabel(checkpoint.type, zh)} · {formatDate(checkpoint.createdAt, locale)}</small>
                            </div>
                        </div>
                        <div className={styles.actions}>
                            {checkpoint.status === "pending"
                                ? <button type="button" onClick={() => onApprove(checkpoint.id)}>{copy.approve}</button>
                                : <button type="button" onClick={() => onReopen(checkpoint.id)}>{copy.reopen}</button>}
                            <button type="button" onClick={() => restore(checkpoint.id)}>{copy.restore}</button>
                        </div>
                    </article>
                ))}
                {!checkpoints.length && <div className={styles.empty}>{copy.empty}</div>}
            </div>
        </section>
    );
}

function checkpointTypeLabel(type: string, zh: boolean) {
    const labels: Record<string, [string, string]> = {
        "prompt-review": ["提示詞確認", "Prompt review"],
        "render-ready": ["生成前確認", "Render ready"],
        "media-review": ["生成結果確認", "Media review"],
        "pre-upscale": ["升頻前確認", "Pre-upscale review"],
    };
    return labels[type]?.[zh ? 0 : 1] || type;
}

function formatDate(value: string, locale: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}

function checkpointCopy(zh: boolean) {
    return zh
        ? {
            title: "Review Checkpoints",
            type: "Checkpoint 類型",
            create: "建立 Checkpoint",
            approve: "Approve",
            reopen: "重新開啟",
            restore: "Restore",
            restoreConfirm: "確定恢復這個 Checkpoint？目前 Canvas、節點設定與素材引用會回到當時狀態；Jobs 歷史不會被刪除。",
            description: "在高成本生成前後保存可恢復狀態。Restore 只還原 Project graph/config/assets，不會修改 Jobs 歷史。",
            empty: "尚未建立 Checkpoint。",
        }
        : {
            title: "Review checkpoints",
            type: "Checkpoint type",
            create: "Create checkpoint",
            approve: "Approve",
            reopen: "Reopen",
            restore: "Restore",
            restoreConfirm: "Restore this checkpoint? Canvas, node settings, and asset references return to that state. Job history is not deleted.",
            description: "Save restorable state before and after expensive generation. Restore affects only project graph/config/assets, not Jobs history.",
            empty: "No checkpoints yet.",
        };
}
