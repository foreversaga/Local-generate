"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "../../i18n/I18nProvider";
import { createWorkflowProject } from "../../lib/workflow-project.mjs";
import { listWorkflowProjects, saveWorkflowProject } from "../../lib/workflow-project-store.mjs";
import styles from "./ProjectCreatePanel.module.css";

type RecentProject = {
    id: string;
    name: string;
    brief: string;
    updatedAt: string;
};

export function ProjectCreatePanel() {
    const router = useRouter();
    const { locale } = useI18n();
    const copy = projectCopy(locale);
    const [brief, setBrief] = useState("");
    const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);

    useEffect(() => {
        setRecentProjects(listWorkflowProjects(window.localStorage).slice(0, 3));
    }, []);

    function createProject(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!brief.trim()) return;
        const project = createWorkflowProject({ brief });
        saveWorkflowProject(window.localStorage, project);
        router.push(`/app/create/workspace/${encodeURIComponent(project.id)}`);
    }

    return (
        <section className={styles.panel} aria-labelledby="project-create-heading">
            <div className={styles.copy}>
                <span>{copy.eyebrow}</span>
                <h2 id="project-create-heading">{copy.title}</h2>
                <p>{copy.description}</p>
            </div>

            <form className={styles.form} onSubmit={createProject}>
                <label className={styles.label} htmlFor="project-brief">{copy.label}</label>
                <textarea
                    id="project-brief"
                    value={brief}
                    onChange={(event) => setBrief(event.target.value)}
                    placeholder={copy.placeholder}
                    rows={5}
                    maxLength={4000}
                />
                <div className={styles.actions}>
                    <span>{brief.trim().length ? copy.ready : copy.helper}</span>
                    <button type="submit" disabled={!brief.trim()}>{copy.action}</button>
                </div>
            </form>

            {recentProjects.length > 0 && (
                <div className={styles.recent}>
                    <strong>{copy.recent}</strong>
                    <div className={styles.recentGrid}>
                        {recentProjects.map((project) => (
                            <a key={project.id} href={`/app/create/workspace/${encodeURIComponent(project.id)}`}>
                                <span>{project.name}</span>
                                <small>{formatUpdatedAt(project.updatedAt, locale)}</small>
                            </a>
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
}

function formatUpdatedAt(value: string, locale: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}

function projectCopy(locale: string) {
    return locale.toLowerCase().startsWith("zh")
        ? {
            eyebrow: "PROJECT WORKSPACE",
            title: "描述你想建立的內容",
            description: "先描述目標；Workspace 會把需求整理成可編輯的生成流程，既有 Single / Long 仍保留作為快速入口。",
            label: "專案需求",
            placeholder: "例如：使用四張角色參考圖，套用一段動作影片，生成 10 秒真人影片，完成後再升頻。",
            helper: "輸入需求後建立專案。",
            ready: "將建立 Brief → Prompt → H3 Video → Output 工作流。",
            action: "建立 Workspace",
            recent: "最近專案",
        }
        : {
            eyebrow: "PROJECT WORKSPACE",
            title: "Describe what you want to create",
            description: "Start from the goal. The workspace turns the brief into an editable generation flow while Single and Long remain available as quick starts.",
            label: "Project brief",
            placeholder: "Example: use four character references and a motion video to create a 10-second realistic video, then upscale the result.",
            helper: "Enter a brief to create a project.",
            ready: "Creates a Brief → Prompt → H3 Video → Output workflow.",
            action: "Create workspace",
            recent: "Recent projects",
        };
}
