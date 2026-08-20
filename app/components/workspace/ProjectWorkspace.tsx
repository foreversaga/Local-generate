"use client";

import { useEffect, useMemo, useState } from "react";
import type { StudioAsset } from "../library/asset-client";
import type { UnifiedJob } from "../jobs/job-client";
import { refreshUnifiedJobsFeed, useUnifiedJobsFeed } from "../jobs/useUnifiedJobsFeed";
import { useI18n } from "../../i18n/I18nProvider";
import { attachWorkflowAssetNode, updateWorkflowAssetRole } from "../../lib/workflow-assets.mjs";
import {
    approveWorkflowCheckpoint,
    createWorkflowCheckpoint,
    reopenWorkflowCheckpoint,
    restoreWorkflowCheckpoint,
} from "../../lib/workflow-checkpoints.mjs";
import { updateWorkflowNodeConfig } from "../../lib/workflow-graph.mjs";
import { applyWorkflowAgentPlan } from "../../lib/workflow-agent-plan.mjs";
import { bindWorkflowNodeJob, unbindWorkflowNodeJob, workflowExecutionState } from "../../lib/workflow-jobs.mjs";
import { updateWorkflowProjectBrief, WORKFLOW_NODE_TYPES } from "../../lib/workflow-project.mjs";
import { getWorkflowProject, saveWorkflowProject } from "../../lib/workflow-project-store.mjs";
import { AssetDock } from "./AssetDock";
import { executeWorkflowPromptNode } from "./workspace-prompt-client";
import { executeWorkflowH3Node } from "./workspace-render-client";
import { executeWorkflowOpenPoseNode, executeWorkflowUpscaleNode } from "./workspace-tool-client";
import { executeWorkflowPlanner } from "./workspace-planner-client";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkspaceActivity } from "./WorkspaceActivity";
import { WorkspaceCheckpoints } from "./WorkspaceCheckpoints";
import { WorkspaceInspector } from "./WorkspaceInspector";
import type { WorkflowProject } from "./workflow-types";
import styles from "./ProjectWorkspace.module.css";

type ProjectChangeOptions = { recordHistory?: boolean };
type CanvasPosition = { x: number; y: number };
type ExecutionState = ReturnType<typeof workflowExecutionState>;

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
    const [promptRunningNodeId, setPromptRunningNodeId] = useState("");
    const [promptRunError, setPromptRunError] = useState("");
    const [h3RunningNodeId, setH3RunningNodeId] = useState("");
    const [h3RunError, setH3RunError] = useState("");
    const [openPoseRunningNodeId, setOpenPoseRunningNodeId] = useState("");
    const [openPoseRunError, setOpenPoseRunError] = useState("");
    const [upscaleRunningNodeId, setUpscaleRunningNodeId] = useState("");
    const [upscaleRunError, setUpscaleRunError] = useState("");
    const [plannerRunning, setPlannerRunning] = useState(false);
    const [plannerRunError, setPlannerRunError] = useState("");

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

    const selectedNode = useMemo(() => project?.nodes.find((node) => node.id === selectedNodeId) || null, [project, selectedNodeId]);
    const executionStates = useMemo<Record<string, ExecutionState>>(() => {
        if (!project) return {};
        return Object.fromEntries(project.nodes.map((node) => [node.id, workflowExecutionState(node, jobs)]));
    }, [jobs, project]);
    const selectedExecutionState = selectedNode ? executionStates[selectedNode.id] : null;
    const selectedH3Busy = nodeBusy(selectedNode?.type === WORKFLOW_NODE_TYPES.h3Video, h3RunningNodeId, selectedNodeId, selectedExecutionState);
    const selectedOpenPoseBusy = nodeBusy(selectedNode?.type === WORKFLOW_NODE_TYPES.openPose, openPoseRunningNodeId, selectedNodeId, selectedExecutionState);
    const selectedUpscaleBusy = nodeBusy(selectedNode?.type === WORKFLOW_NODE_TYPES.upscale, upscaleRunningNodeId, selectedNodeId, selectedExecutionState);

    if (!loaded) return <div className={styles.state}>{copy.loading}</div>;
    if (!project) {
        return <div className={styles.state}><strong>{copy.notFound}</strong><a href="/app/create">{copy.back}</a></div>;
    }

    function applyProjectChange(nextProject: WorkflowProject, options: ProjectChangeOptions = {}) {
        if (options.recordHistory !== false) recordHistorySnapshot();
        setProject(nextProject);
    }

    function recordHistorySnapshot() {
        setHistoryPast((current) => [...current.slice(-(HISTORY_LIMIT - 1)), project]);
        setHistoryFuture([]);
    }

    function undo() {
        if (historyPast.length === 0) return;
        const previous = historyPast.at(-1);
        if (!previous) return;
        setHistoryPast((current) => current.slice(0, -1));
        setHistoryFuture((current) => [project, ...current].slice(0, HISTORY_LIMIT));
        const restored = touchRestoredProject(previous);
        setProject(restored);
        ensureSelectedNode(restored);
    }

    function redo() {
        if (historyFuture.length === 0) return;
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
        setPlannerRunError("");
        applyProjectChange(updateWorkflowProjectBrief(project, value) as WorkflowProject, { recordHistory: true });
    }

    async function planWorkflow() {
        if (plannerRunning) return;
        setPlannerRunning(true);
        setPlannerRunError("");
        try {
            const plan = await executeWorkflowPlanner(project);
            let nextProject = applyWorkflowAgentPlan(project, plan) as WorkflowProject;
            nextProject = createWorkflowCheckpoint(nextProject, { type: "agent-plan" }) as WorkflowProject;
            applyProjectChange(nextProject, { recordHistory: true });
        } catch (error) {
            setPlannerRunError(error instanceof Error ? error.message : copy.plannerFailed);
        } finally {
            setPlannerRunning(false);
        }
    }

    function updateName(value: string) {
        applyProjectChange({ ...project, name: value, updatedAt: new Date().toISOString() }, { recordHistory: false });
    }

    function updateSelectedNodeConfig(patch: Record<string, unknown>) {
        if (!selectedNode) return;
        let nextProject = updateWorkflowNodeConfig(project, selectedNode.id, patch) as WorkflowProject;
        const assetKey = typeof selectedNode.config.projectAssetKey === "string" ? selectedNode.config.projectAssetKey : "";
        const role = typeof patch.role === "string" ? patch.role : "";
        if (selectedNode.type === WORKFLOW_NODE_TYPES.asset && assetKey && role) nextProject = updateWorkflowAssetRole(nextProject, assetKey, role) as WorkflowProject;
        clearExecutionErrors();
        applyProjectChange(nextProject, { recordHistory: true });
    }

    function addAssetToCanvas(asset: StudioAsset, position?: CanvasPosition) {
        const nextProject = attachWorkflowAssetNode(project, asset, { position: position || defaultAssetPosition(project.assets.length) }) as WorkflowProject;
        const addedNode = nextProject.nodes.at(-1);
        applyProjectChange(nextProject, { recordHistory: true });
        if (addedNode) setSelectedNodeId(addedNode.id);
    }

    function bindJob(nodeId: string, job: UnifiedJob) {
        applyProjectChange(bindWorkflowNodeJob(project, nodeId, job) as WorkflowProject, { recordHistory: true });
    }

    function unbindJob(nodeId: string) {
        applyProjectChange(unbindWorkflowNodeJob(project, nodeId) as WorkflowProject, { recordHistory: true });
    }

    async function generatePrompt(nodeId: string) {
        if (promptRunningNodeId) return;
        setPromptRunningNodeId(nodeId);
        setPromptRunError("");
        try {
            const result = await executeWorkflowPromptNode(project, nodeId);
            applyProjectChange(updateWorkflowNodeConfig(project, nodeId, {
                prompt: result.prompt,
                negativePrompt: result.negativePrompt,
                ollamaPromptReceipt: result.ollamaPromptReceipt,
            }) as WorkflowProject, { recordHistory: true });
        } catch (error) {
            setPromptRunError(error instanceof Error ? error.message : copy.promptFailed);
        } finally {
            setPromptRunningNodeId("");
        }
    }

    async function runH3Node(nodeId: string) {
        if (h3RunningNodeId || rejectActiveJob(nodeId, setH3RunError)) return;
        setH3RunningNodeId(nodeId);
        setH3RunError("");
        try {
            const result = await executeWorkflowH3Node(project, nodeId, jobs);
            if (result.issues.length) {
                setH3RunError(result.issues.map((issue) => issue.message).join("\n"));
                return;
            }
            const job = result.jobs[0];
            if (!job) throw new Error(copy.noJobCreated);
            bindJob(nodeId, job);
            await refreshUnifiedJobsFeed();
        } catch (error) {
            setH3RunError(error instanceof Error ? error.message : copy.runFailed);
        } finally {
            setH3RunningNodeId("");
        }
    }

    async function runOpenPoseNode(nodeId: string) {
        if (openPoseRunningNodeId || rejectActiveJob(nodeId, setOpenPoseRunError)) return;
        setOpenPoseRunningNodeId(nodeId);
        setOpenPoseRunError("");
        try {
            bindJob(nodeId, await executeWorkflowOpenPoseNode(project, nodeId));
            await refreshUnifiedJobsFeed();
        } catch (error) {
            setOpenPoseRunError(error instanceof Error ? error.message : copy.openPoseFailed);
        } finally {
            setOpenPoseRunningNodeId("");
        }
    }

    async function runUpscaleNode(nodeId: string) {
        if (upscaleRunningNodeId || rejectActiveJob(nodeId, setUpscaleRunError)) return;
        setUpscaleRunningNodeId(nodeId);
        setUpscaleRunError("");
        try {
            bindJob(nodeId, await executeWorkflowUpscaleNode(project, nodeId, jobs));
            await refreshUnifiedJobsFeed();
        } catch (error) {
            setUpscaleRunError(error instanceof Error ? error.message : copy.upscaleFailed);
        } finally {
            setUpscaleRunningNodeId("");
        }
    }

    function rejectActiveJob(nodeId: string, setError: (value: string) => void) {
        if (!isActiveExecution(executionStates[nodeId])) return false;
        setError(copy.activeJobExists);
        return true;
    }

    function clearExecutionErrors() {
        setPromptRunError("");
        setH3RunError("");
        setOpenPoseRunError("");
        setUpscaleRunError("");
        setPlannerRunError("");
    }

    function createCheckpoint(type: string) {
        applyProjectChange(createWorkflowCheckpoint(project, { type }) as WorkflowProject, { recordHistory: true });
    }
    function approveCheckpoint(checkpointId: string) { applyProjectChange(approveWorkflowCheckpoint(project, checkpointId) as WorkflowProject, { recordHistory: true }); }
    function reopenCheckpoint(checkpointId: string) { applyProjectChange(reopenWorkflowCheckpoint(project, checkpointId) as WorkflowProject, { recordHistory: true }); }
    function restoreCheckpoint(checkpointId: string) {
        const restored = restoreWorkflowCheckpoint(project, checkpointId) as WorkflowProject;
        applyProjectChange(restored, { recordHistory: true });
        ensureSelectedNode(restored);
    }

    return (
        <div className={styles.workspace}>
            <header className={styles.workspaceHeader}>
                <div className={styles.titleGroup}><a href="/app/create" className={styles.backLink}>← {copy.back}</a><input aria-label={copy.projectName} value={project.name} onChange={(event) => updateName(event.target.value)} /></div>
                <div className={styles.saveState}><span className={styles.saveDot} aria-hidden="true" /><span>{savedAt ? copy.saved : copy.local}</span></div>
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
                    onSelectNode={(nodeId) => { setSelectedNodeId(nodeId); clearExecutionErrors(); }}
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
                    promptRunning={Boolean(selectedNode && promptRunningNodeId === selectedNode.id)}
                    promptRunError={selectedNode?.type === WORKFLOW_NODE_TYPES.prompt ? promptRunError : ""}
                    h3Running={selectedH3Busy}
                    h3RunError={selectedNode?.type === WORKFLOW_NODE_TYPES.h3Video ? h3RunError : ""}
                    openPoseRunning={selectedOpenPoseBusy}
                    openPoseRunError={selectedNode?.type === WORKFLOW_NODE_TYPES.openPose ? openPoseRunError : ""}
                    upscaleRunning={selectedUpscaleBusy}
                    upscaleRunError={selectedNode?.type === WORKFLOW_NODE_TYPES.upscale ? upscaleRunError : ""}
                    plannerRunning={plannerRunning}
                    plannerRunError={selectedNode?.type === WORKFLOW_NODE_TYPES.brief ? plannerRunError : ""}
                    onBriefChange={updateBrief}
                    onPlanWorkflow={() => void planWorkflow()}
                    onConfigChange={updateSelectedNodeConfig}
                    onGeneratePrompt={(nodeId) => void generatePrompt(nodeId)}
                    onRunH3={(nodeId) => void runH3Node(nodeId)}
                    onRunOpenPose={(nodeId) => void runOpenPoseNode(nodeId)}
                    onRunUpscale={(nodeId) => void runUpscaleNode(nodeId)}
                />
            </div>

            <WorkspaceActivity locale={locale} project={project} selectedNodeId={selectedNodeId} onBindJob={bindJob} onUnbindJob={unbindJob} />
            <WorkspaceCheckpoints locale={locale} checkpoints={project.checkpoints} onCreate={createCheckpoint} onApprove={approveCheckpoint} onReopen={reopenCheckpoint} onRestore={restoreCheckpoint} />
        </div>
    );
}

function nodeBusy(isType: boolean, localRunningNodeId: string, selectedNodeId: string, state: ExecutionState | null) {
    return Boolean(isType && (localRunningNodeId === selectedNodeId || isActiveExecution(state)));
}
function isActiveExecution(state: ExecutionState | null | undefined) { return state?.status === "queued" || state?.status === "running"; }
function defaultAssetPosition(index: number): CanvasPosition { return { x: 70 + (index % 3) * 42, y: 360 + Math.floor(index / 3) * 110 }; }
function touchRestoredProject(project: WorkflowProject): WorkflowProject { return { ...project, updatedAt: new Date().toISOString() }; }
function workspaceCopy(locale: string) {
    return locale.toLowerCase().startsWith("zh")
        ? { loading: "載入專案中…", notFound: "找不到這個本機專案。", back: "返回建立", projectName: "專案名稱", saved: "已儲存在本機", local: "本機專案", promptFailed: "無法產生提示詞。", plannerFailed: "Hermes 無法規劃工作流。", activeJobExists: "這個節點已有排隊中或執行中的工作，請先等待完成或取消工作。", noJobCreated: "生成 API 沒有回傳工作。", runFailed: "無法建立生成工作。", openPoseFailed: "無法啟動 OpenPose 生圖工作。", upscaleFailed: "無法啟動升頻工作。" }
        : { loading: "Loading project…", notFound: "This local project could not be found.", back: "Back to Create", projectName: "Project name", saved: "Saved locally", local: "Local project", promptFailed: "Unable to generate the prompt.", plannerFailed: "Hermes could not plan the workflow.", activeJobExists: "This node already has a queued or running job. Finish or cancel it before starting another.", noJobCreated: "The generation API did not return a job.", runFailed: "Unable to create the generation job.", openPoseFailed: "Unable to start the OpenPose image job.", upscaleFailed: "Unable to start the upscale job." };
}
