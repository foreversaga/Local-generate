"use client";

import { useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { StudioAsset } from "../library/asset-client";
import {
    addWorkflowNode,
    connectWorkflowNodes,
    duplicateWorkflowNode,
    moveWorkflowNode,
    removeWorkflowNode,
    validateWorkflowConnection,
    WORKFLOW_CREATABLE_NODE_TYPES,
} from "../../lib/workflow-graph.mjs";
import { WORKFLOW_NODE_TYPES } from "../../lib/workflow-project.mjs";
import { readWorkspaceAssetDrag, WORKSPACE_ASSET_DRAG_TYPE } from "./workspace-asset-dnd";
import type { WorkflowNode, WorkflowProject } from "./workflow-types";
import styles from "./WorkflowCanvas.module.css";

type ProjectChangeOptions = { recordHistory?: boolean };
type CanvasPosition = { x: number; y: number };
type ExecutionState = {
    status: string;
    progress: number;
    etaMs: number | null;
    error: string;
    missing: boolean;
} | null;

type WorkflowCanvasProps = {
    project: WorkflowProject;
    locale: string;
    selectedNodeId: string;
    executionStates: Record<string, ExecutionState>;
    canUndo: boolean;
    canRedo: boolean;
    onSelectNode: (nodeId: string) => void;
    onProjectChange: (project: WorkflowProject, options?: ProjectChangeOptions) => void;
    onBeginContinuousEdit: () => void;
    onDropAsset: (asset: StudioAsset, position: CanvasPosition) => void;
    onUndo: () => void;
    onRedo: () => void;
};

type DragState = {
    nodeId: string;
    pointerId: number;
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
    moved: boolean;
};

const CANVAS_WIDTH = 1120;
const CANVAS_HEIGHT = 680;
const NODE_WIDTH = 174;
const NODE_HEIGHT = 94;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.35;
const ZOOM_STEP = 0.1;

export function WorkflowCanvas({
    project,
    locale,
    selectedNodeId,
    executionStates,
    canUndo,
    canRedo,
    onSelectNode,
    onProjectChange,
    onBeginContinuousEdit,
    onDropAsset,
    onUndo,
    onRedo,
}: WorkflowCanvasProps) {
    const copy = canvasCopy(locale);
    const [connectionSourceId, setConnectionSourceId] = useState("");
    const [interactionError, setInteractionError] = useState("");
    const [zoom, setZoom] = useState(1);
    const canvasRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<DragState | null>(null);
    const suppressClickRef = useRef(false);
    const selectedNode = useMemo(
        () => project.nodes.find((node) => node.id === selectedNodeId) || null,
        [project.nodes, selectedNodeId],
    );

    function addNode(type: string) {
        const nextProject = addWorkflowNode(project, type) as WorkflowProject;
        const addedNode = nextProject.nodes.at(-1);
        onProjectChange(nextProject, { recordHistory: true });
        if (addedNode) onSelectNode(addedNode.id);
        setInteractionError("");
    }

    function duplicateSelectedNode() {
        if (!selectedNode) return;
        const nextProject = duplicateWorkflowNode(project, selectedNode.id) as WorkflowProject;
        const duplicated = nextProject.nodes.at(-1);
        onProjectChange(nextProject, { recordHistory: true });
        if (duplicated) onSelectNode(duplicated.id);
        setInteractionError("");
    }

    function deleteSelectedNode() {
        if (!selectedNode) return;
        try {
            const nextProject = removeWorkflowNode(project, selectedNode.id) as WorkflowProject;
            onProjectChange(nextProject, { recordHistory: true });
            onSelectNode(nextProject.nodes[0]?.id || "");
            setConnectionSourceId((current) => current === selectedNode.id ? "" : current);
            setInteractionError("");
        } catch (error) {
            setInteractionError(error instanceof Error ? error.message : copy.deleteFailed);
        }
    }

    function toggleConnectionMode() {
        if (!selectedNode) return;
        setConnectionSourceId((current) => current === selectedNode.id ? "" : selectedNode.id);
        setInteractionError("");
    }

    function handleNodeClick(node: WorkflowNode) {
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
        }
        if (!connectionSourceId) {
            onSelectNode(node.id);
            return;
        }
        if (connectionSourceId === node.id) {
            setConnectionSourceId("");
            setInteractionError("");
            return;
        }

        const validation = validateWorkflowConnection(project, connectionSourceId, node.id);
        if (!validation.valid) {
            setInteractionError(connectionErrorMessage(validation.code, locale, validation.message));
            return;
        }
        const nextProject = connectWorkflowNodes(project, connectionSourceId, node.id) as WorkflowProject;
        onProjectChange(nextProject, { recordHistory: true });
        onSelectNode(node.id);
        setConnectionSourceId("");
        setInteractionError("");
    }

    function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>, node: WorkflowNode) {
        if (event.button !== 0 || connectionSourceId) return;
        dragRef.current = {
            nodeId: node.id,
            pointerId: event.pointerId,
            pointerX: event.clientX,
            pointerY: event.clientY,
            startX: node.position.x,
            startY: node.position.y,
            moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    }

    function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = (event.clientX - drag.pointerX) / zoom;
        const dy = (event.clientY - drag.pointerY) / zoom;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        if (!drag.moved) {
            drag.moved = true;
            onBeginContinuousEdit();
        }
        const nextProject = moveWorkflowNode(project, drag.nodeId, {
            x: drag.startX + dx,
            y: drag.startY + dy,
        }) as WorkflowProject;
        onProjectChange(nextProject, { recordHistory: false });
    }

    function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        suppressClickRef.current = drag.moved;
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }

    function handleAssetDragOver(event: ReactDragEvent<HTMLDivElement>) {
        if (!event.dataTransfer.types.includes(WORKSPACE_ASSET_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    }

    function handleAssetDrop(event: ReactDragEvent<HTMLDivElement>) {
        const asset = readWorkspaceAssetDrag(event.dataTransfer);
        const canvas = canvasRef.current;
        if (!asset || !canvas) return;
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) / zoom - NODE_WIDTH / 2;
        const y = (event.clientY - rect.top) / zoom - NODE_HEIGHT / 2;
        onDropAsset(asset, {
            x: clampCoordinate(x, 0, CANVAS_WIDTH - NODE_WIDTH),
            y: clampCoordinate(y, 0, CANVAS_HEIGHT - NODE_HEIGHT),
        });
        setInteractionError("");
    }

    function changeZoom(delta: number) {
        setZoom((current) => clampZoom(current + delta));
    }

    return (
        <section className={styles.panel} aria-label={copy.canvas}>
            <div className={styles.toolbar}>
                <div className={styles.palette} aria-label={copy.addNode}>
                    {WORKFLOW_CREATABLE_NODE_TYPES.map((type) => (
                        <button key={type} type="button" onClick={() => addNode(type)}>
                            + {nodeTypeLabel(type, locale)}
                        </button>
                    ))}
                </div>
                <div className={styles.actions}>
                    <button type="button" onClick={onUndo} disabled={!canUndo} title={copy.undo}>↶</button>
                    <button type="button" onClick={onRedo} disabled={!canRedo} title={copy.redo}>↷</button>
                    <span className={styles.divider} aria-hidden="true" />
                    <button type="button" onClick={() => changeZoom(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} title={copy.zoomOut}>−</button>
                    <button type="button" className={styles.zoomValue} onClick={() => setZoom(1)} title={copy.resetZoom}>{Math.round(zoom * 100)}%</button>
                    <button type="button" onClick={() => changeZoom(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} title={copy.zoomIn}>+</button>
                    <span className={styles.divider} aria-hidden="true" />
                    <button type="button" onClick={toggleConnectionMode} disabled={!selectedNode} aria-pressed={Boolean(connectionSourceId)}>
                        {connectionSourceId ? copy.cancelConnect : copy.connect}
                    </button>
                    <button type="button" onClick={duplicateSelectedNode} disabled={!selectedNode}>{copy.duplicate}</button>
                    <button type="button" onClick={deleteSelectedNode} disabled={!selectedNode || selectedNode.type === WORKFLOW_NODE_TYPES.brief}>{copy.delete}</button>
                </div>
            </div>

            {(connectionSourceId || interactionError) && (
                <div className={`${styles.notice} ${interactionError ? styles.noticeError : ""}`} role={interactionError ? "alert" : "status"}>
                    {interactionError || copy.connectHelp}
                </div>
            )}

            <div className={styles.scroller} onDragOver={handleAssetDragOver} onDrop={handleAssetDrop}>
                <div className={styles.bounds} style={{ width: CANVAS_WIDTH * zoom, height: CANVAS_HEIGHT * zoom }}>
                    <div
                        ref={canvasRef}
                        className={styles.canvas}
                        style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, transform: `scale(${zoom})`, transformOrigin: "0 0" }}
                    >
                        <svg className={styles.edges} viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} aria-hidden="true">
                            {project.edges.map((edge) => {
                                const source = project.nodes.find((node) => node.id === edge.source);
                                const target = project.nodes.find((node) => node.id === edge.target);
                                if (!source || !target) return null;
                                return <path key={edge.id} d={edgePath(source, target)} data-active={connectionSourceId === source.id || undefined} />;
                            })}
                        </svg>

                        {project.nodes.map((node) => {
                            const execution = executionStates[node.id];
                            const displayStatus = execution?.status || node.status;
                            const activeExecution = execution && ["queued", "running"].includes(execution.status);
                            return (
                                <button
                                    key={node.id}
                                    type="button"
                                    className={`${styles.node} ${selectedNodeId === node.id ? styles.nodeSelected : ""} ${connectionSourceId === node.id ? styles.nodeConnecting : ""}`}
                                    style={{ left: node.position.x, top: node.position.y }}
                                    onClick={() => handleNodeClick(node)}
                                    onPointerDown={(event) => handlePointerDown(event, node)}
                                    onPointerMove={handlePointerMove}
                                    onPointerUp={handlePointerUp}
                                    onPointerCancel={handlePointerUp}
                                    aria-pressed={selectedNodeId === node.id}
                                >
                                    <span className={styles.nodeType}>{nodeTypeLabel(node.type, locale)}</span>
                                    <strong>{node.title}</strong>
                                    <span className={styles.nodeStatus} data-status={displayStatus}>
                                        <span aria-hidden="true" />{statusLabel(displayStatus, locale)}{execution && !execution.missing ? ` · ${execution.progress}%` : ""}
                                    </span>
                                    {activeExecution && <span className={styles.nodeProgress} aria-hidden="true"><span style={{ width: `${execution.progress}%` }} /></span>}
                                    {execution?.error && <small className={styles.nodeError}>{execution.error}</small>}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>
        </section>
    );
}

function edgePath(source: WorkflowNode, target: WorkflowNode) {
    const sourceX = source.position.x + NODE_WIDTH;
    const sourceY = source.position.y + NODE_HEIGHT / 2;
    const targetX = target.position.x;
    const targetY = target.position.y + NODE_HEIGHT / 2;
    const controlOffset = Math.max(50, Math.abs(targetX - sourceX) * 0.45);
    return `M ${sourceX} ${sourceY} C ${sourceX + controlOffset} ${sourceY}, ${targetX - controlOffset} ${targetY}, ${targetX} ${targetY}`;
}

function clampCoordinate(value: number, min: number, max: number) {
    return Math.round(Math.min(max, Math.max(min, value)));
}

function clampZoom(value: number) {
    return Number(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)).toFixed(2));
}

function nodeTypeLabel(type: string, locale: string) {
    const zh = locale.toLowerCase().startsWith("zh");
    const labels: Record<string, [string, string]> = {
        [WORKFLOW_NODE_TYPES.brief]: ["需求", "Brief"],
        [WORKFLOW_NODE_TYPES.asset]: ["素材", "Asset"],
        [WORKFLOW_NODE_TYPES.prompt]: ["提示詞", "Prompt"],
        [WORKFLOW_NODE_TYPES.h3Video]: ["H3 影片", "H3 Video"],
        [WORKFLOW_NODE_TYPES.openPose]: ["OpenPose", "OpenPose"],
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
        queued: ["排隊中", "Queued"],
        running: ["執行中", "Running"],
        complete: ["完成", "Complete"],
        partial: ["部分完成", "Partial"],
        cancelled: ["已取消", "Cancelled"],
        error: ["失敗", "Failed"],
    };
    return labels[status]?.[zh ? 0 : 1] || status;
}

function connectionErrorMessage(code: string, locale: string, fallback: string) {
    if (!locale.toLowerCase().startsWith("zh")) return fallback;
    const messages: Record<string, string> = {
        "missing-node": "請選擇兩個存在的工作流節點。",
        "self-loop": "節點不能連接到自己。",
        "duplicate-edge": "這兩個節點已經連接。",
        "incompatible-types": "這兩種節點的資料方向不相容。",
        cycle: "工作流連線不能形成循環。",
    };
    return messages[code] || fallback;
}

function canvasCopy(locale: string) {
    return locale.toLowerCase().startsWith("zh")
        ? { canvas: "Workflow Canvas", addNode: "新增節點", undo: "復原", redo: "重做", zoomOut: "縮小", zoomIn: "放大", resetZoom: "重設縮放", connect: "連線", cancelConnect: "取消連線", connectHelp: "已進入連線模式：點選下一個節點建立資料流；再次點起點可取消。", duplicate: "複製", delete: "刪除", deleteFailed: "無法刪除節點。" }
        : { canvas: "Workflow Canvas", addNode: "Add node", undo: "Undo", redo: "Redo", zoomOut: "Zoom out", zoomIn: "Zoom in", resetZoom: "Reset zoom", connect: "Connect", cancelConnect: "Cancel connect", connectHelp: "Connect mode: select the target node to create a data flow, or select the source again to cancel.", duplicate: "Duplicate", delete: "Delete", deleteFailed: "Unable to delete node." };
}
