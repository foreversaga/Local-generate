import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("app shell provides keyboard skip navigation and a stable main target", async () => {
    const [shell, css] = await Promise.all([
        read("app/components/shell/AppShell.tsx"),
        read("app/components/shell/AppShell.module.css"),
    ]);

    assert.match(shell, /href="#main-content"/);
    assert.match(shell, /<main id="main-content"/);
    assert.match(shell, /tabIndex=\{-1\}/);
    assert.match(css, /\.skipLink/);
    assert.match(css, /cursor:\s*not-allowed/);
});

test("tools landing is grouped by intent without changing tool routes", async () => {
    const tools = await read("app/(studio)/tools/page.tsx");

    assert.match(tools, /CREATE/);
    assert.match(tools, /EDIT/);
    assert.match(tools, /TRAIN/);
    assert.match(tools, /headingLevel=\{3\}/);

    for (const href of [
        "/app/tools/text-to-image",
        "/app/tools/pose-to-image",
        "/app/tools/image-to-image",
        "/app/tools/upscale",
        "/app/tools/video-character",
        "/app/tools/lora-trainer",
    ]) {
        assert.match(tools, new RegExp(`href="${href}"`));
    }
});

test("jobs expose status-aware next actions", async () => {
    const jobs = await read("app/components/jobs/JobsWorkspace.tsx");

    assert.match(jobs, /開啟結果/);
    assert.match(jobs, /檢查可用結果/);
    assert.match(jobs, /檢查錯誤/);
    assert.match(jobs, /查看進度/);
    assert.match(jobs, /aria-label=\{`\$\{actionLabel\}: \$\{job\.title\}`\}/);
});

test("settings keep diagnostics behind a technical-details disclosure", async () => {
    const [settings, css] = await Promise.all([
        read("app/components/settings/SettingsWorkspace.tsx"),
        read("app/components/settings/SettingsWorkspace.module.css"),
    ]);

    assert.match(settings, /<details className=\{styles\.technicalDetails\}>/);
    assert.match(settings, /端點、模型與 GPU 診斷/);
    assert.match(settings, /runtime\?\.comfyUrl \|\| health\?\.comfy\?\.url/);
    assert.match(css, /\.technicalDetails/);
    assert.match(css, /min-height:\s*50px/);
});

test("library toolbar remains reachable while browsing large asset collections", async () => {
    const css = await read("app/components/library/LibraryWorkspace.module.css");

    assert.match(css, /\.toolbar\{position:sticky;top:82px/);
    assert.match(css, /\.primaryTabs button[^}]*min-height:44px/);
    assert.match(css, /@media\(max-width:620px\)\{\.toolbar\{position:relative/);
});

test("Single Create keeps one professional disclosure and preserves asset roots", async () => {
    const [shell, landing] = await Promise.all([
        read("app/components/create/SingleCreateProgressiveShell.tsx"),
        read("app/components/create/CreateLanding.tsx"),
    ]);

    assert.match(shell, /role="switch"/);
    assert.match(shell, /專業設定/);
    assert.match(shell, /hasProfessionalValues/);
    assert.match(landing, /allowedRoots=\{\["input", "output"\]\}/);
});
