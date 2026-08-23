from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


client_path = Path("app/components/tools/upscale-client.ts")
client = client_path.read_text(encoding="utf-8")
client = replace_once(
    client,
    '''export const UPSCALE_PROFILES = [\n    {\n        id: "seedvr2_7b_sharp_nvfp4",''',
    '''export const UPSCALE_PROFILES = [\n    {\n        id: "seedvr2_7b_sharp_fp16",\n        label: "SeedVR2 7B Sharp FP16 · 高品質預設",\n        description: "最高品質的 SeedVR2 7B Sharp FP16；適合追求肌膚、髮絲與材質細節。目前僅完成 UI，後端模型與 workflow 尚未啟用。",\n        supportsImages: true,\n    },\n    {\n        id: "seedvr2_7b_sharp_nvfp4",''',
    "FP16 profile",
)
client = replace_once(
    client,
    '''export type UpscaleProfile = typeof UPSCALE_PROFILES[number]["id"];\nexport const DEFAULT_UPSCALE_PROFILE: UpscaleProfile = "h3_latent_2x";''',
    '''export type UpscaleProfile = typeof UPSCALE_PROFILES[number]["id"];\nexport const DEFAULT_UPSCALE_UI_PROFILE: UpscaleProfile = "seedvr2_7b_sharp_fp16";\nexport const DEFAULT_UPSCALE_PROFILE: UpscaleProfile = "h3_latent_2x";''',
    "UI default profile",
)
client_path.write_text(client, encoding="utf-8")

workspace_path = Path("app/components/tools/UpscaleWorkspace.tsx")
workspace = workspace_path.read_text(encoding="utf-8")
workspace = replace_once(
    workspace,
    '''    DEFAULT_UPSCALE_PROFILE,\n    SEEDVR2_SCALE_MIN,''',
    '''    DEFAULT_UPSCALE_PROFILE,\n    DEFAULT_UPSCALE_UI_PROFILE,\n    SEEDVR2_SCALE_MIN,''',
    "UI default import",
)
workspace = replace_once(
    workspace,
    '''    const [profile, setProfile] = useState<UpscaleProfile>(DEFAULT_UPSCALE_PROFILE);''',
    '''    const [profile, setProfile] = useState<UpscaleProfile>(DEFAULT_UPSCALE_UI_PROFILE);''',
    "UI default state",
)
workspace = replace_once(
    workspace,
    '''    const sourceKind = source?.kind || "video";\n    const isSeedVR2 = profile === "seedvr2_7b_sharp_nvfp4";\n    const activeScale = isSeedVR2 ? (scale || "—") : UPSCALE_SCALE;''',
    '''    const sourceKind = source?.kind || "video";\n    const backendPending = profile === "seedvr2_7b_sharp_fp16";\n    const isSeedVR2 = profile === "seedvr2_7b_sharp_fp16" || profile === "seedvr2_7b_sharp_nvfp4";\n    const activeScale = isSeedVR2 ? (scale || "—") : UPSCALE_SCALE;''',
    "FP16 SeedVR2 state",
)
workspace = replace_once(
    workspace,
    '''    const refreshHealth = useCallback(async () => {\n        setHealthLoading(true);\n        try {''',
    '''    const refreshHealth = useCallback(async () => {\n        setHealthLoading(true);\n        if (backendPending) {\n            setHealth(null);\n            setHealthError("");\n            setHealthLoading(false);\n            return;\n        }\n        try {''',
    "pending health guard",
)
workspace = replace_once(
    workspace,
    '''    }, [profile, sourceKind]);''',
    '''    }, [backendPending, profile, sourceKind]);''',
    "health dependencies",
)
workspace = workspace.replace('if (uploaded.kind === "image") setProfile("seedvr2_7b_sharp_nvfp4");', 'if (uploaded.kind === "image") setProfile(DEFAULT_UPSCALE_UI_PROFILE);')
workspace = workspace.replace('if (selected.kind === "image") setProfile("seedvr2_7b_sharp_nvfp4");', 'if (selected.kind === "image") setProfile(DEFAULT_UPSCALE_UI_PROFILE);')
workspace = replace_once(
    workspace,
    '''        if (active || busy) return;\n        if (health?.ready === false) {''',
    '''        if (active || busy) return;\n        if (backendPending) {\n            setError(locale === "en"\n                ? "SeedVR2 7B Sharp FP16 is the high-quality UI default, but its backend model and workflow are not enabled yet."\n                : "SeedVR2 7B Sharp FP16 已設為高品質預設，但後端模型與 workflow 尚未啟用。");\n            document.getElementById("upscale-readiness")?.focus();\n            return;\n        }\n        if (health?.ready === false) {''',
    "submit guard",
)
workspace = replace_once(
    workspace,
    '''    const statusLabel = job\n        ? `${jobStatusLabel(job.status === "completed" ? "complete" : job.status, "upscale", locale)}${job.stage ? ` · ${job.stage}` : ""}`\n        : "已就緒，可開始升頻";\n    const readinessLabel = healthLoading ? localizedReadinessLabel("checking", locale) : health?.ready ? localizedReadinessLabel("ready", locale) : localizedReadinessLabel("unavailable", locale);''',
    '''    const statusLabel = job\n        ? `${jobStatusLabel(job.status === "completed" ? "complete" : job.status, "upscale", locale)}${job.stage ? ` · ${job.stage}` : ""}`\n        : backendPending\n            ? (locale === "en" ? "FP16 high-quality UI ready · backend pending" : "FP16 高品質 UI 已就緒 · 等待後端支援")\n            : "已就緒，可開始升頻";\n    const readinessLabel = backendPending\n        ? (locale === "en" ? "Backend support pending" : "等待後端支援")\n        : healthLoading\n            ? localizedReadinessLabel("checking", locale)\n            : health?.ready\n                ? localizedReadinessLabel("ready", locale)\n                : localizedReadinessLabel("unavailable", locale);''',
    "pending status copy",
)
workspace = replace_once(
    workspace,
    '''                            <span>{health?.comfyUi === false ? "ComfyUI 未連線。" : `${availableModels}/${modelTotal || 0} 個模型檔案可用 · ${missingNodes.length ? `${missingNodes.length} 個節點缺失` : "原生節點可用"}`}</span>''',
    '''                            <span>{backendPending\n                                ? (locale === "en" ? "FP16 is available in the UI only; generation remains disabled until the backend model and workflow are connected." : "FP16 高品質模式目前只加入 UI；後端模型與 workflow 接好前不會送出生成工作。")\n                                : health?.comfyUi === false\n                                    ? "ComfyUI 未連線。"\n                                    : `${availableModels}/${modelTotal || 0} 個模型檔案可用 · ${missingNodes.length ? `${missingNodes.length} 個節點缺失` : "原生節點可用"}`}</span>''',
    "readiness detail",
)
workspace = replace_once(
    workspace,
    '''                        <button type="button" className={styles.textButton} onClick={() => void refreshHealth()} disabled={healthLoading || Boolean(busy)}>{ACTION_LABELS.refresh}</button>''',
    '''                        <button type="button" className={styles.textButton} onClick={() => void refreshHealth()} disabled={backendPending || healthLoading || Boolean(busy)}>{ACTION_LABELS.refresh}</button>''',
    "refresh disabled",
)
workspace = replace_once(
    workspace,
    '''                    <button type="button" className={styles.primaryButton} onClick={() => void start()} disabled={active || Boolean(busy)} aria-busy={busy === "submit" || busy === "upload"} aria-describedby="upscale-readiness">\n                        {busy === "submit" ? "建立工作中…" : active ? "升頻中…" : `開始 ${activeScale}× 升頻`}\n                    </button>''',
    '''                    <button type="button" className={styles.primaryButton} onClick={() => void start()} disabled={backendPending || active || Boolean(busy)} aria-busy={busy === "submit" || busy === "upload"} aria-describedby="upscale-readiness">\n                        {backendPending ? (locale === "en" ? "FP16 backend not enabled" : "FP16 後端尚未啟用") : busy === "submit" ? "建立工作中…" : active ? "升頻中…" : `開始 ${activeScale}× 升頻`}\n                    </button>''',
    "primary button guard",
)
workspace_path.write_text(workspace, encoding="utf-8")

test_path = Path("tests/seedvr2-settings-ui.test.mjs")
test_source = test_path.read_text(encoding="utf-8")
if 'SeedVR2 FP16 appears as the high-quality UI default without enabling backend submission' in test_source:
    raise RuntimeError("FP16 UI test already exists")
test_source += r'''

test("SeedVR2 FP16 appears as the high-quality UI default without enabling backend submission", async () => {
  const [workspace, client] = await Promise.all([
    readFile(new URL("../app/components/tools/UpscaleWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/upscale-client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(client, /id: "seedvr2_7b_sharp_fp16"/);
  assert.match(client, /SeedVR2 7B Sharp FP16 · 高品質預設/);
  assert.match(client, /DEFAULT_UPSCALE_UI_PROFILE: UpscaleProfile = "seedvr2_7b_sharp_fp16"/);
  assert.match(client, /DEFAULT_UPSCALE_PROFILE: UpscaleProfile = "h3_latent_2x"/);
  assert.match(workspace, /useState<UpscaleProfile>\(DEFAULT_UPSCALE_UI_PROFILE\)/);
  assert.match(workspace, /backendPending = profile === "seedvr2_7b_sharp_fp16"/);
  assert.match(workspace, /profile === "seedvr2_7b_sharp_fp16" \|\| profile === "seedvr2_7b_sharp_nvfp4"/);
  assert.match(workspace, /if \(uploaded\.kind === "image"\) setProfile\(DEFAULT_UPSCALE_UI_PROFILE\)/);
  assert.match(workspace, /if \(selected\.kind === "image"\) setProfile\(DEFAULT_UPSCALE_UI_PROFILE\)/);
  assert.match(workspace, /FP16 後端尚未啟用/);
  assert.match(workspace, /disabled=\{backendPending \|\| active \|\| Boolean\(busy\)\}/);
  assert.match(workspace, /if \(backendPending\) \{/);
});
'''
test_path.write_text(test_source, encoding="utf-8")
