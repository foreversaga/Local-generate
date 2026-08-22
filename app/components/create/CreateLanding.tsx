"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { draftForCreateAsset } from "../../lib/create-asset-start.mjs";
import { SINGLE_CREATE_DRAFT_STORAGE_KEY } from "../../lib/single-create-draft.mjs";
import { jobStatusLabel, localizedCopy, sourceLabel } from "../../lib/ui-copy.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import { AssetPickerButton } from "../library/AssetPickerButton";
import type { StudioAsset } from "../library/asset-client";
import { fetchUnifiedJobs, type UnifiedJob } from "../jobs/job-client";
import styles from "./CreateLanding.module.css";

export function CreateLanding() {
    const { locale, t } = useI18n();
    const { ACTION_LABELS } = localizedCopy(locale);
    const router = useRouter();
    const [jobs, setJobs] = useState<UnifiedJob[]>([]);

    useEffect(() => {
        void fetchUnifiedJobs({ limitPerSource: 5, summary: true, includeOutputAvailability: false })
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
                    title={t("create.single.title")}
                    description={t("create.single.description")}
                    href="/app/create/single"
                />
                <WorkflowCard
                    code="02 / LONG"
                    title={t("create.long.title")}
                    description={t("create.long.description")}
                    href="/app/create/long"
                />
            </section>

            <section className={styles.assetStart} aria-labelledby="tools-heading">
                <div>
                    <span>{t("create.tools.eyebrow")}</span>
                    <h2 id="tools-heading">{t("create.tools.title")}</h2>
                    <p>{t("create.tools.description")}</p>
                </div>
                <div className={styles.toolLinks}>
                    <a className={styles.toolLink} href="/app/tools/image-to-image">
                        <span><strong>{t("tools.img2img.title")}</strong><small>Image to Image</small></span>
                        <span>{ACTION_LABELS.openTool} →</span>
                    </a>
                    <a className={styles.toolLink} href="/app/tools/upscale">
                        <span><strong>{t("tools.upscale.title")}</strong><small>Image &amp; Video Upscale</small></span>
                        <span>{ACTION_LABELS.openTool} →</span>
                    </a>
                </div>
            </section>

            <section className={styles.assetStart}>
                <div>
                    <span>{t("create.fromAsset.eyebrow")}</span>
                    <h2>{t("create.fromAsset.title")}</h2>
                    <p>{t("create.fromAsset.description")}</p>
                </div>
            <AssetPickerButton allowedRoots={["input", "output"]} label={t("create.fromAsset.action")} onSelect={startFromAsset} />
            </section>

            <section className={styles.recent}>
                <header>
                    <div><span>{t("create.recent")}</span><h2>{t("create.recent")}</h2></div>
                    <a href="/app/jobs">{ACTION_LABELS.viewAll} →</a>
                </header>
                <div className={styles.jobList}>
                    {jobs.map((job) => (
                        <a key={`${job.source}:${job.id}`} href={`/app/jobs/${encodeURIComponent(job.id)}?source=${job.source}`}>
                            <span className={`${styles.dot} ${styles[`dot_${job.status}`] || ""}`} />
                            <span><strong>{job.title}</strong><small>{jobStatusLabel(job.status, job.source, locale)} · {job.progress}% · {sourceLabel(job.source, locale)}</small></span>
                        </a>
                    ))}
                    {!jobs.length && <p>{t("create.noRecent")}</p>}
                </div>
            </section>
        </div>
    );
}

function isCreateAssetRoot(root: StudioAsset["root"]): root is "input" | "output" {
    return root === "input" || root === "output";
}

function WorkflowCard({ code, title, description, href }: { code: string; title: string; description: string; href: string }) {
    const { t } = useI18n();
    return <a className={styles.card} href={href}><span>{code}</span><h2>{title}</h2><p>{description}</p><strong>{t("action.openFlow")} →</strong></a>;
}
