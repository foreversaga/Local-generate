"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { draftForCreateAsset } from "../../lib/create-asset-start.mjs";
import { SINGLE_CREATE_DRAFT_STORAGE_KEY } from "../../lib/single-create-draft.mjs";
import { ACTION_LABELS, jobStatusLabel, sourceLabel } from "../../lib/ui-copy.mjs";
import { AssetPickerButton } from "../library/AssetPickerButton";
import type { StudioAsset } from "../library/asset-client";
import { fetchUnifiedJobs, type UnifiedJob } from "../jobs/job-client";
import styles from "./CreateLanding.module.css";

export function CreateLanding() {
    const router = useRouter();
    const [jobs, setJobs] = useState<UnifiedJob[]>([]);

    useEffect(() => {
        void fetchUnifiedJobs()
            .then((snapshot) => setJobs(snapshot.jobs.slice(0, 3)))
            .catch(() => setJobs([]));
    }, []);

    function startFromAsset(assets: StudioAsset[]) {
        const asset = assets[0];
        if (!asset || !isCreateAssetRoot(asset.root)) return;
        const serialized = window.localStorage.getItem(SINGLE_CREATE_DRAFT_STORAGE_KEY);
        const draft = draftForCreateAsset(serialized, asset);
        window.localStorage.setItem(SINGLE_CREATE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
        router.push("/app/create/single");
    }

    return (
        <div className={styles.layout}>
            <section className={styles.cards}>
                <WorkflowCard
                    code="01 / SINGLE"
                    title="單次影片"
                    description="T2V、I2V、首尾幀、Ref2V 與 Replace；包含提示詞助理、自動儲存草稿與檢查摘要。"
                    href="/app/create/single"
                />
                <WorkflowCard
                    code="02 / LONG"
                    title="長影片"
                    description="故事、參考素材、規劃、時間軸、片段檢視與可恢復的序列草稿。"
                    href="/app/create/long"
                />
            </section>

            <section className={styles.assetStart} aria-labelledby="tools-heading">
                <div>
                    <span>工具</span>
                    <h2 id="tools-heading">以圖生圖與影片升頻</h2>
                    <p>直接進入工具工作台；以圖生圖可從素材庫選取圖片，影片升頻可選取影片或上傳來源。</p>
                </div>
                <div className={styles.toolLinks}>
                    <a className={styles.toolLink} href="/app/tools/image-to-image">
                        <span><strong>以圖生圖</strong><small>Image to Image</small></span>
                        <span>{ACTION_LABELS.openTool} →</span>
                    </a>
                    <a className={styles.toolLink} href="/app/tools/upscale">
                        <span><strong>影片升頻</strong><small>Video Upscale</small></span>
                        <span>{ACTION_LABELS.openTool} →</span>
                    </a>
                </div>
            </section>

            <section className={styles.assetStart}>
                <div>
                    <span>從素材開始</span>
                    <h2>從素材庫開始</h2>
                    <p>圖片會作為單次 I2V 參考素材；影片會作為 Ref2V 影片參考素材。完整素材管理仍在素材庫。</p>
                </div>
                <AssetPickerButton root="input" label="從素材庫選擇" onSelect={startFromAsset} />
            </section>

            <section className={styles.recent}>
                <header>
                    <div><span>最近工作</span><h2>最近工作</h2></div>
                    <a href="/app/jobs">{ACTION_LABELS.viewAll} →</a>
                </header>
                <div className={styles.jobList}>
                    {jobs.map((job) => (
                        <a key={`${job.source}:${job.id}`} href={`/app/jobs/${encodeURIComponent(job.id)}?source=${job.source}`}>
                            <span className={`${styles.dot} ${styles[`dot_${job.status}`] || ""}`} />
                            <span><strong>{job.title}</strong><small>{jobStatusLabel(job.status, job.source)} · {job.progress}% · {sourceLabel(job.source)}</small></span>
                        </a>
                    ))}
                    {!jobs.length && <p>尚無最近工作。</p>}
                </div>
            </section>
        </div>
    );
}

function isCreateAssetRoot(root: StudioAsset["root"]): root is "input" | "output" {
    return root === "input" || root === "output";
}

function WorkflowCard({ code, title, description, href }: { code: string; title: string; description: string; href: string }) {
    return <a className={styles.card} href={href}><span>{code}</span><h2>{title}</h2><p>{description}</p><strong>開啟流程 →</strong></a>;
}
