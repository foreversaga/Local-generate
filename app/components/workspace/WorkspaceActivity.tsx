"use client";

import { useMemo, useState } from "react";
import { jobStatusLabel, sourceLabel } from "../../lib/ui-copy.mjs";
import {
    supportedJobSourcesForNode,
    workflowJobBinding,
    workflowJobForNode,
} from "../../lib/workflow-jobs.mjs";
import { performJobAction, type UnifiedJob } from "../jobs/job-client";
import { refreshUnifiedJobsFeed, useUnifiedJobsFeed } from "../jobs/useUnifiedJobsFeed";
import type { WorkflowNode, WorkflowProject } from "./workflow-types";
import styles from "./WorkspaceActivity.module.css";

type WorkspaceActivityProps = {
    locale: string;
    project: WorkflowProject;
    selectedNodeId: string;
    onBindJob: (nodeId: string, job: UnifiedJob) => void;
    onUnbindJob: (nodeId: string) => void;
};

export function WorkspaceActivity({
    locale,
    project,
    selectedNodeId,
    onBindJob,
    onUnbindJob,
}: WorkspaceActivityProps) {
    const zh = locale.toLowerCase().startsWith("zh");
    const copy = activityCopy(zh);
    const { jobs, errors, loading, error, updatedAt } = useUnifiedJobsFeed();
    const [actionError, setActionError] = useState("");
    const selectedNode = project.nodes.find((node) => node.id === selectedNodeId) || null;
    const selectedBinding = workflowJobBinding(selectedNode);
    const supportedSources = selectedNode ? supportedJobSourcesForNode(selectedNode.type) : [];
    const compatibleJobs = useMemo(
        () => jobs.filter((job) => supportedSources.includes(job.source)).slice(0, 4),
        [jobs, supportedSources],
    );
    const boundNodes = useMemo(
        () => project.nodes
            .map((node) => ({ node, job: workflowJobForNode(node, jobs) as UnifiedJob | null, binding: workflowJobBinding(node) }))
            .filter((item) => item.binding),
        [jobs, project.nodes],
    );

    async function cancelJob(job: UnifiedJob) {
        setActionError("");
        try {
            await performJobAction(job, "cancel");
            await refreshUnifiedJobsFeed();
        } catch (reason) {
            setActionError(reason instanceof Error ? reason.message : copy.actionError);
        }
    }

    return (
        <section className={styles.activity} aria-label={copy.title}>
            <header className={styles.header}>
                <div>
                    <span>ACTIVITY</span>
                    <h2>{copy.title}</h2>
                </div>
                <small>{loading ? copy.loading : updatedAt ? copy.updated : copy.waiting}</small>
            </header>

            {(error || errors.length > 0 || actionError) && (
                <div className={styles.warning} role="status">
                    {actionError || error || copy.partial}
                </div>
            )}

            <div className={styles.boundList}>
                {boundNodes.map(({ node, job, binding }) => (
                    <BoundJobRow
                        key={node.id}
                        node={node}
                        job={job}
                        binding={binding!}
                        locale={locale}
                        onUnbind={() => onUnbindJob(node.id)}
                        onCancel={job?.canCancel ? () => void cancelJob(job) : undefined}
                    />
                ))}
                {!boundNodes.length && <p className={styles.empty}>{copy.noBoundJobs}</p>}
            </div>

            {selectedNode && supportedSources.length > 0 && !selectedBinding && (
                <div className={styles.linkPanel}>
                    <div className={styles.linkHeading}>
                        <strong>{copy.linkTitle}</strong>
                        <span>{nodeTitle(selectedNode, locale)} · {supportedSources.map((source) => sourceLabel(source, locale)).join(" / ")}</span>
                    </div>
                    <div className={styles.compatibleJobs}>
                        {compatibleJobs.map((job) => (
                            <button key={`${job.source}:${job.id}`} type="button" onClick={() => onBindJob(selectedNode.id, job)}>
                                <span><strong>{job.title}</strong><small>{jobStatusLabel(job.status, job.source, locale)} · {Math.round(job.progress || 0)}%</small></span>
                                <span>{copy.link}</span>
                            </button>
                        ))}
                        {!loading && compatibleJobs.length === 0 && <p className={styles.empty}>{copy.noCompatible}</p>}
                    </div>
                </div>
            )}
        </section>
    );
}

function BoundJobRow({
    node,
    job,
    binding,
    locale,
    onUnbind,
    onCancel,
}: {
    node: WorkflowNode;
    job: UnifiedJob | null;
    binding: { jobId: string; source: string };
    locale: string;
    onUnbind: () => void;
    onCancel?: () => void;
}) {
    const zh = locale.toLowerCase().startsWith("zh");
    const status = job?.status || "queued";
    const progress = Math.max(0, Math.min(100, Math.round(Number(job?.progress) || 0)));
    return (
        <article className={styles.boundRow}>
            <div className={styles.boundCopy}>
                <span className={styles.statusDot} data-status={status} aria-hidden="true" />
                <div>
                    <strong>{node.title}</strong>
                    <small>{job ? `${jobStatusLabel(job.status, job.source, locale)} · ${progress}%${job.etaMs ? ` · ${formatEta(job.etaMs, zh)}` : ""}` : (zh ? "找不到已綁定的工作" : "Bound job is not available")}</small>
                </div>
            </div>
            {job && (job.status === "queued" || job.status === "running") && (
                <div className={styles.progress} aria-label={`${progress}%`}><span style={{ width: `${progress}%` }} /></div>
            )}
            <div className={styles.rowActions}>
                <a href={`/app/jobs/${encodeURIComponent(binding.jobId)}?source=${encodeURIComponent(binding.source)}`}>{zh ? "詳情" : "Details"}</a>
                {onCancel && <button type="button" onClick={onCancel}>{zh ? "取消" : "Cancel"}</button>}
                <button type="button" onClick={onUnbind}>{zh ? "解除" : "Unlink"}</button>
            </div>
        </article>
    );
}

function formatEta(ms: number, zh: boolean) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return zh ? `約 ${seconds} 秒` : `~${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return zh ? `約 ${minutes} 分 ${remaining} 秒` : `~${minutes}m ${remaining}s`;
}

function nodeTitle(node: WorkflowNode, locale: string) {
    if (node.title) return node.title;
    return locale.toLowerCase().startsWith("zh") ? "節點" : "Node";
}

function activityCopy(zh: boolean) {
    return zh
        ? {
            title: "工作狀態",
            loading: "載入中…",
            updated: "使用共享 Jobs feed",
            waiting: "等待 Jobs feed",
            partial: "部分工作來源目前無法取得；保留最後已知狀態。",
            actionError: "工作操作失敗。",
            noBoundJobs: "目前沒有節點綁定執行工作。",
            linkTitle: "連結現有工作",
            link: "連結",
            noCompatible: "沒有符合這個節點類型的近期工作。",
        }
        : {
            title: "Job activity",
            loading: "Loading…",
            updated: "Using shared Jobs feed",
            waiting: "Waiting for Jobs feed",
            partial: "Some job sources are unavailable; the last known state is retained.",
            actionError: "Job action failed.",
            noBoundJobs: "No workflow nodes are linked to execution jobs yet.",
            linkTitle: "Link an existing job",
            link: "Link",
            noCompatible: "No recent jobs match this node type.",
        };
}
