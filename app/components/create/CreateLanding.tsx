"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { draftForCreateAsset } from "../../lib/create-asset-start.mjs";
import { SINGLE_CREATE_DRAFT_STORAGE_KEY } from "../../lib/single-create-draft.mjs";
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
                    title="Single Video"
                    description="T2V、I2V、首尾幀、Ref2V 與 Replace；包含 Prompt Assistant、draft autosave 與 validation summary。"
                    href="/app/create/single"
                />
                <WorkflowCard
                    code="02 / LONG"
                    title="Long Video"
                    description="Story、references、planner、timeline、segment review 與可恢復 sequence draft。"
                    href="/app/create/long"
                />
            </section>

            <section className={styles.assetStart} aria-labelledby="tools-heading">
                <div>
                    <span>TOOLS</span>
                    <h2 id="tools-heading">Image-to-Image 與 Video Upscale</h2>
                    <p>直接進入工具工作台；以圖生圖可從 Library 選取圖片，Video Upscale 可選取影片或上傳來源。</p>
                </div>
                <div className={styles.toolLinks}>
                    <a className={styles.toolLink} href="/app/tools/image-to-image">
                        <span><strong>Image to Image</strong><small>以圖生圖</small></span>
                        <span>Open tool →</span>
                    </a>
                    <a className={styles.toolLink} href="/app/tools/upscale">
                        <span><strong>Video Upscale</strong><small>影片升頻</small></span>
                        <span>Open tool →</span>
                    </a>
                </div>
            </section>

            <section className={styles.assetStart}>
                <div>
                    <span>START FROM ASSET</span>
                    <h2>從 Library 素材開始</h2>
                    <p>圖片會映射為 Single I2V reference；影片會映射為 Ref2V video reference。完整素材管理仍留在 Library。</p>
                </div>
                <AssetPickerButton root="input" label="Choose asset" onSelect={startFromAsset} />
            </section>

            <section className={styles.recent}>
                <header>
                    <div><span>RECENT JOBS</span><h2>最近工作</h2></div>
                    <a href="/app/jobs">View all →</a>
                </header>
                <div className={styles.jobList}>
                    {jobs.map((job) => (
                        <a key={`${job.source}:${job.id}`} href={`/app/jobs/${encodeURIComponent(job.id)}?source=${job.source}`}>
                            <span className={`${styles.dot} ${styles[`dot_${job.status}`] || ""}`} />
                            <span><strong>{job.title}</strong><small>{job.status} · {job.progress}% · {job.source}</small></span>
                        </a>
                    ))}
                    {!jobs.length && <p>No recent jobs yet.</p>}
                </div>
            </section>
        </div>
    );
}

function isCreateAssetRoot(root: StudioAsset["root"]): root is "input" | "output" {
    return root === "input" || root === "output";
}

function WorkflowCard({ code, title, description, href }: { code: string; title: string; description: string; href: string }) {
    return <a className={styles.card} href={href}><span>{code}</span><h2>{title}</h2><p>{description}</p><strong>Open workflow →</strong></a>;
}
