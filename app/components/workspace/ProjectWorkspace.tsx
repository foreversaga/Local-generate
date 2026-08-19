"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
    updateWorkflowProjectBrief,
    WORKFLOW_NODE_STATUS,
    WORKFLOW_NODE_TYPES,
} from "../../lib/workflow-project.mjs";
import { getWorkflowProject, saveWorkflowProject } from "../../lib/workflow-project-store.mjs";
import styles from "./ProjectWorkspace.module.css";

type WorkflowNode = {
    id: string;
    type: string;
    title: string;
    position: { x: number; y: number };
    status: string;
    config: Record<string, unknown>;
};

type WorkflowEdge = { id: string; source: string; target: string };

type WorkflowProject = {
    version: number;
    id: string;
    name: string;
    brief: string;
    createdAt: string;
    updatedAt: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    assets: unknown[];
    checkpoints: unknown[];
};

export function ProjectWorkspace({ projectId }: { projectId: string }) {
    const { locale } = useI18n();
    const copy = workspaceCopy(locale);
    const [project, setProject] = useState<WorkflowProject | null>(null);
    const [selectedNodeId, setSelectedNodeId] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [savedAt, setSavedAt] = useState("");

    useEffect(() => {
        const timer = window.setTimeout(() => {
            const storedProject = getWorkflowProject(window.localStorage, projectId) as WorkflowProject | null;
            setProject(storedProject);
            setSelectedNodeId(storedProject?.nodes[0]?.id || "");
            setLoaded(true);
        }, 0);
        return () => window.clearTimeout(timer);
    }, [projectId]);

    useEffect(() => {
        if (!loaded || !project) return;
        const timer = window.setTimeout(() => {
            saveWorkflowProject(window.localStorage, project);
            setSavedAt(new Date().toISOString());
        }, 250);
        return () => window.clearTimeout(timer);
    }, [loaded, project]);

    const selectedNode = useMemo(
        () => project?.nodes.find((node) => node.id === selectedNodeId) || null,
        [project, selectedNodeId],
    );

    if (!loaded) return <div className={styles.state}>{copy.loading}</div>;
    if (!project) {
        return (
            <div className={styles.state}>
                <strong>{copy.notFound}</strong>
                <a href="/app/create">{copy.back}</a>
            </div>
        );
    }

    function updateBrief(value: string) {
        setProject((current) => current ? updateWorkflowProjectBrief(current, value) as WorkflowProject : current);
    }

    function updateName(value: string) {
        setProject((current) => current ? {
            ...current,
            name: value,
            updatedAt: new Date().toISOString(),
        } : current);
    }

    return (
        <div className={styles.workspace}>
            <header className={styles.workspaceHeader}>
                <div className={styles.titleGroup}>
                    <a href="/app/create" className={styles.backLink}>← {copy.back}</a>
                    <input
                        aria-label={copy.projectName}
                        value={project.name}
                        onChange={(event) => updateName(event.target.value)}
                    />
                </div>
                <div className={styles.saveState}>
                    <span className={styles.saveDot} aria-hidden="true" />
                    <span>{savedAt ? copy.saved : copy.local}</span>
                </div>
            </header>

            <div className={styles.body}>
                <section className={styles.canvasPanel} aria-label={copy.canvas}>
                    <div className={styles.canvasScroller}>
                        <div className={styles.canvas}>
                            <svg className={styles.edges} viewBox="0 0 960 520" aria-hidden="true">
                                {project.edges.map((edge) => {
                                    const source = project.nodes.find((node) => node.id === edge.source);
                                    const target = project.nodes.find((node) => node.id === edge.target);
                                    if (!source || !target) return null;
                                    return (
                                        <line
                                            key={edge.id}
                                            x1={safeCoordinate(source.position?.x, 0) + 164}
                                            y1={safeCoordinate(source.position?.y, 0) + 47}
                                            x2={safeCoordinate(target.position?.x, 0) - 10}
                                            y2={safeCoordinate(target.position?.y, 0) + 47}
                                        />
                                    );
                                })}
                            </svg>
                            {project.nodes.map((node) => (
                                <button
                                    key={node.id}
                                    type="button"
                                    className={`${styles.node} ${selectedNodeId === node.id ? styles.nodeSelected : ""}`}
                                    style={{ left: safeCoordinate(node.position?.x, 0), top: safeCoordinate(node.position?.y, 0) }}
                                    onClick={() => setSelectedNodeId(node.id)}
                                    aria-pressed={selectedNodeId === node.id}
                                >
                                    <span className={styles.nodeType}>{nodeLabel(node.type, locale)}</span>
                                    <strong>{node.title}</strong>
                                    <span className={styles.nodeStatus} data-status={node.status}>
                                        <span aria-hidden="true" />{statusLabel(node.status, locale)}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                </section>

                <aside className={styles.inspector} aria-label={copy.inspector}>
                    {selectedNode ? (
                        <NodeInspector node={selectedNode} brief={project.brief} locale={locale} onBriefChange={updateBrief} />
                    ) : <p>{copy.selectNode}</p>}
                </aside>
            </div>
        </div>
    );
}

function NodeInspector({
    node,
    brief,
    locale,
    onBriefChange,
}: {
    node: WorkflowNode;
    brief: string;
    locale: string;
    onBriefChange: (value: string) => void;
}) {
    const zh = locale.toLowerCase().startsWith("zh");
    return (
        <div className={styles.inspectorContent}>
            <span className={styles.inspectorEyebrow}>{nodeLabel(node.type, locale)}</span>
            <h2>{node.title}</h2>
            {node.type === WORKFLOW_NODE_TYPES.brief ? (
                <label className={styles.field}>
                    <span>{zh ? "專案需求" : "Project brief"}</span>
                    <textarea value={brief} onChange={(event) => onBriefChange(event.target.value)} rows={12} maxLength={4000} />
                    <small>{zh ? "修改後會自動儲存在目前專案。" : "Changes are saved to this project automatically."}</small>
                </label>
            ) : (
                <>
                    <p className={styles.nodeDescription}>{nodeDescription(node.type, locale)}</p>
                    {node.type === WORKFLOW_NODE_TYPES.h3Video && (
                        <a className={styles.primaryLink} href="/app/create/single">
                            {zh ? "使用現有 Single 流程生成" : "Generate with existing Single flow"}
                        </a>
                    )}
                </>
            )}
        </div>
    );
}

function safeCoordinate(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function nodeLabel(type: string, locale: string) {
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
        [WORKFLOW_NODE_STATUS.ready]: ["可編輯", "Ready"],
        [WORKFLOW_NODE_STATUS.waiting]: ["等待", "Waiting"],
        [WORKFLOW_NODE_STATUS.running]: ["執行中", "Running"],
        [WORKFLOW_NODE_STATUS.complete]: ["完成", "Complete"],
        [WORKFLOW_NODE_STATUS.error]: ["失敗", "Failed"],
    };
    return labels[status]?.[zh ? 0 : 1] || status;
}

function nodeDescription(type: string, locale: string) {
    const zh = locale.toLowerCase().startsWith("zh");
    const descriptions: Record<string, [string, string]> = {
        [WORKFLOW_NODE_TYPES.prompt]: [
            "這個節點將承接現有 Prompt Assistant / Skill。下一個 checkpoint 會把 Provider、模型與 Skill 設定移到這裡。",
            "This node will host the existing Prompt Assistant and skills. Provider, model and skill controls move here in the next checkpoint.",
        ],
        [WORKFLOW_NODE_TYPES.h3Video]: [
            "影片節點會沿用現有 /app/api/generate request contract 與 Jobs 系統；目前先保留既有 Single 流程作為執行入口。",
            "The video node reuses the existing /app/api/generate request contract and Jobs system. The current Single flow remains the execution entry for this checkpoint.",
        ],
        [WORKFLOW_NODE_TYPES.output]: [
            "完成的圖片或影片會連到 Output 節點，後續直接與 Library Asset Dock 共用同一份素材資料。",
            "Completed media connects to this output node and will share the same asset data with the Library Asset Dock.",
        ],
    };
    return descriptions[type]?.[zh ? 0 : 1] || (zh ? "選取節點後在此調整設定。" : "Select a node to edit its settings here.");
}

function workspaceCopy(locale: string) {
    return locale.toLowerCase().startsWith("zh")
        ? {
            loading: "載入專案中…",
            notFound: "找不到這個本機專案。",
            back: "返回建立",
            projectName: "專案名稱",
            saved: "已儲存在本機",
            local: "本機專案",
            canvas: "Workflow Canvas",
            inspector: "節點設定",
            selectNode: "選取一個節點以查看設定。",
        }
        : {
            loading: "Loading project…",
            notFound: "This local project could not be found.",
            back: "Back to Create",
            projectName: "Project name",
            saved: "Saved locally",
            local: "Local project",
            canvas: "Workflow Canvas",
            inspector: "Node inspector",
            selectNode: "Select a node to view its settings.",
        };
}
