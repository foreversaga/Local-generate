"use client";

import { useEffect, useMemo, useState } from "react";
import type { StudioAsset } from "../library/asset-client";
import type { UnifiedJob } from "../jobs/job-client";
import { useUnifiedJobsFeed } from "../jobs/useUnifiedJobsFeed";
import { useI18n } from "../../i18n/I18nProvider";
import { attachWorkflowAssetNode, updateWorkflowAssetRole } from "../../lib/workflow-assets.mjs";
import { updateWorkflowNodeConfig } from "../../lib/workflow-graph.mjs";
import {
    bindWorkflowNodeJob,
    unbindWorkflowNodeJob,
    workflowExecutionState,
} from "../../lib/workflow-jobs.mjs";
import { updateWorkflowProjectBrief, WORKFLOW_NODE_TYPES } from "../../lib/workflow-project.mjs";
import { getWorkflowProject, saveWorkflowProject } from "../../lib/workflow-project-store.mjs";
import { AssetDock } from "./AssetDock";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkspaceActivity } from "./WorkspaceActivity";
import { WorkspaceInspector } from "./WorkspaceInspector";
import type { WorkflowProject } from "./workflow-types";
import styles from "./ProjectWorkspace.module.css";

type ProjectChangeOptions = { recordHistory?: boolean };
type CanvasPosition = { x: number; y: number };

const HISTORY_LIMIT = 30;

export function ProjectWorkspace({ projectId }: { projectId: string }) {
    const { locale } = useI18n();
    const copy = workspaceCopy(locale);
    const { jobs } = useUnifiedJobsFeed();
    const [project, setProject] = useState<WorkflowProject | null>(null);
    const [selectedNodeId, setSelectedNodeId] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [savedAt, setSavedAt] = useState("");
    const [historyPast, setHistoryPast] = useState<WorkflowProject[]>([]);
    const [historyFuture, setHistoryFuture] = useState<WorkflowProject[]>([]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            const storedProject = getWorkflowProject(window.localStorage, projectId) as WorkflowProject | null;
            setProject(storedProject);
            setSelectedNodeId(storedProject?.nodes[0]?.id || "");
            setHistoryPast([]);
            setHistoryFuture([]);
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
    const executionStates = useMemo(() => {
        if (!project) return {};
        return Object.fromEntries(project.nodes.map((node) => [node.id, workflowExecutionState(node, jobs)]));
    }, [jobs, project]);

    if (!loaded) return <div className={styles.state}>{copy.loading}</div>;
    if (!project) {
        return (
            <div className={styles.state}>
                <strong>{copy.notFound}</strong>
                <a href="/app/create">{copy.back}</a>
            </div>
        );
    }

    function applyProjectChange(nextProject: WorkflowProject, options: ProjectChangeOptions = {}) {
        if (options.recordHistory !== false) recordHistorySnapshot();
        setProject(nextProject);
    }

    function recordHistorySnapshot() {
        if (!project) return;
        setHistoryPast((current) => [...current.slice(-(HISTORY_LIMIT - 1)), project]);
        setHistoryFuture([]);
    }

    function undo() {
        if (!project || historyPast.length === 0) return;
        const previous = historyPast.at(-1);
        if (!previous) return;
        setHistoryPast((current) => current.slice(0, -1));
        setHistoryFuture((current) => [project, ...current].slice(0, HISTORY_LIMIT));
        const restored = touchRestoredProject(previous);
        setProject(restored);
        ensureSelectedNode(restored);
    }

    function redo() {
        if (!project || historyFuture.length === 0) return;
        const next = historyFuture[0];
        setHistoryFuture((current) => current.slice(1));
        setHistoryPast((current) => [...current.slice(-(HISTORY_LIMIT - 1)), project]);
        const restored = touchRestoredProject(next);
        setProject(restored);
        ensureSelectedNode(restored);
    }

    function ensureSelectedNode(nextProject: WorkflowProject) {
        if (nextProject.nodes.some((node) => node.id === selectedNodeId)) return;
        setSelectedNodeId(nextProject.nodes[0]?.id || "");
    }

    function updateBrief(value: string) {
        const nextProject = updateWorkflowProjectBrief(project, value) as WorkflowProject;
        applyProjectChange(nextProject, { recordHistory: true });
    }

    function updateName(value: string) {
        applyProjectChange({ ...project, name: value, updatedAt: new Date().toISOString() }, { recordHistory: false });
    }

    function updateSelectedNodeConfig(patch: Record<string, unknown>) {
        if (!selectedNode) return;
        let nextProject = updateWorkflowNodeConfig(project, selectedNode.id, patch) as WorkflowProject;
        const assetKey = typeof selectedNode.config.projectAssetKey === "string" ? selectedNode.config.projectAssetKey : "";
        const role = typeof patch.role === "string" ? patch.role : "";
        if (selectedNode.type === WORKFLOW_NODE_TYPES.asset && assetKey && role) {
            nextProject = updateWorkflowAssetRole(nextProject, assetKey, role) as WorkflowProject;
        }
        applyProjectChange(nextProject, { recordHistory: true });
    }

    function addAssetToCanvas(asset: StudioAsset, position?: CanvasPosition) {
        const nextProject = attachWorkflowAssetNode(project, asset, {
            position: position || defaultAssetPosition(project.assets.length),
        }) as WorkflowProject;
        const addedNode = nextProject.nodes.at(-1);
        applyProjectChange(nextProject, { recordHistory: true });
        if (addedNode) setSelectedNodeId(addedNode.id);
    }

    function bindJob(nodeId: string, job: UnifiedJob) {
        const nextProject = bindWorkflowNodeJob(project, nodeId, job) as WorkflowProject;
        applyProjectChange(nextProject, { recordHistory: true });
    }

    function unbindJob(nodeId: string) {
        const nextProject = unbindWorkflowNodeJob(project, nodeId) as WorkflowProject;
        applyProjectChange(nextProject, { recordHistory: true });
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
                <AssetDock locale={locale} projectAssets={project.assets} onAddAsset={(asset) => addAssetToCanvas(asset)} />
                <WorkflowCanvas
                    project={project}
                    locale={locale}
                    selectedNodeId={selectedNodeId}
                    executionStates={executionStates}
                    canUndo={historyPast.length > 0}
                    canRedo={historyFuture.length > 0}
                    onSelectNode={setSelectedNodeId}
                    onProjectChange={applyProjectChange}
                    onBeginContinuousEdit={recordHistorySnapshot}
                    onDropAsset={addAssetToCanvas}
                    onUndo={undo}
                    onRedo={redo}
                />
                <WorkspaceInspector
                    key={selectedNode?.id || "empty"}
                    node={selectedNode}
                    brief={project.brief}
                    locale={locale}
                    onBriefChange={updateBrief}
                    onConfigChange={updateSelectedNodeConfig}
                />
            </div>

            <WorkspaceActivity
                locale={locale}
                project={project}
                selectedNodeId={selectedNodeId}
                onBindJob={bindJob}
                onUnbindJob={unbindJob}
            />
        </div>
    );
}

function defaultAssetPosition(index: number): CanvasPosition {
    return {
        x: 70 + (index % 3) * 42,
        y: 360 + Math.floor(index / 3) * 110,
    };
}

function touchRestoredProject(project: WorkflowProject): WorkflowProject {
    return { ...project, updatedAt: new Date().toISOString() };
}

function workspaceCopy(locale: string) {
    return locale.toLowerCase().startsWith("zh")
        ? { loading: "載入專案中…", notFound: "找不到這個本機專案。", back: "返回建立", projectName: "專案名稱", saved: "已儲存在本機", local: "本機專案" }
        : { loading: "Loading project…", notFound: "This local project could not be found.", back: "Back to Create", projectName: "Project name", saved: "Saved locally", local: "Local project" };
}
