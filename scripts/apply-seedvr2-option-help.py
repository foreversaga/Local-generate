from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


workspace_path = Path("app/components/tools/UpscaleWorkspace.tsx")
workspace = workspace_path.read_text(encoding="utf-8")
workspace = replace_once(
    workspace,
    '} from "./upscale-client";\nimport styles from "./UpscaleWorkspace.module.css";',
    '} from "./upscale-client";\nimport { getSeedVR2Help } from "./seedvr2-help";\nimport styles from "./UpscaleWorkspace.module.css";',
    "SeedVR2 help import",
)
workspace = replace_once(
    workspace,
    '    const selectedProfile = UPSCALE_PROFILES.find((item) => item.id === profile) || UPSCALE_PROFILES[0];\n    const missingNodes = useMemo(',
    '    const selectedProfile = UPSCALE_PROFILES.find((item) => item.id === profile) || UPSCALE_PROFILES[0];\n    const seedVR2Help = getSeedVR2Help(locale);\n    const missingNodes = useMemo(',
    "SeedVR2 localized help",
)

replacements = [
    (
        '                                    <input type="number" min={SEEDVR2_SCALE_MIN} max={SEEDVR2_SCALE_MAX} step="0.25" value={scale} onChange={(event) => setScale(event.target.value)} disabled={active || Boolean(busy)} />',
        '                                    <input type="number" min={SEEDVR2_SCALE_MIN} max={SEEDVR2_SCALE_MAX} step="0.25" value={scale} onChange={(event) => setScale(event.target.value)} disabled={active || Boolean(busy)} />\n                                    <small className={styles.fieldHelp}>{seedVR2Help.scale}</small>',
        "scale help",
    ),
    (
        '                                    <input type="number" min="0" max="2147483647" step="1" value={seed} placeholder="留空為隨機" onChange={(event) => setSeed(event.target.value)} disabled={active || Boolean(busy)} />',
        '                                    <input type="number" min="0" max="2147483647" step="1" value={seed} placeholder="留空為隨機" onChange={(event) => setSeed(event.target.value)} disabled={active || Boolean(busy)} />\n                                    <small className={styles.fieldHelp}>{seedVR2Help.seed}</small>',
        "seed help",
    ),
    (
        '                                    <select value={resizeMethod} onChange={(event) => setResizeMethod(event.target.value as SeedVR2ResizeMethod)} disabled={active || Boolean(busy)}>\n                                        {SEEDVR2_RESIZE_METHODS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}\n                                    </select>',
        '                                    <select value={resizeMethod} onChange={(event) => setResizeMethod(event.target.value as SeedVR2ResizeMethod)} disabled={active || Boolean(busy)}>\n                                        {SEEDVR2_RESIZE_METHODS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}\n                                    </select>\n                                    <small className={styles.fieldHelp}>{seedVR2Help.resize[resizeMethod]}</small>',
        "resize help",
    ),
    (
        '                                    <select value={colorCorrection} onChange={(event) => setColorCorrection(event.target.value as SeedVR2ColorCorrection)} disabled={active || Boolean(busy)}>\n                                        {SEEDVR2_COLOR_CORRECTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}\n                                    </select>',
        '                                    <select value={colorCorrection} onChange={(event) => setColorCorrection(event.target.value as SeedVR2ColorCorrection)} disabled={active || Boolean(busy)}>\n                                        {SEEDVR2_COLOR_CORRECTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}\n                                    </select>\n                                    <small className={styles.fieldHelp}>{seedVR2Help.colorCorrection[colorCorrection]}</small>',
        "color correction help",
    ),
    (
        '                                            <input type="number" min="1" max="20" step="1" value={steps} onChange={(event) => setSteps(event.target.value)} disabled={active || Boolean(busy)} />',
        '                                            <input type="number" min="1" max="20" step="1" value={steps} onChange={(event) => setSteps(event.target.value)} disabled={active || Boolean(busy)} />\n                                            <small className={styles.fieldHelp}>{seedVR2Help.steps}</small>',
        "steps help",
    ),
    (
        '                                            <input type="number" min="0" max="20" step="0.05" value={cfg} onChange={(event) => setCfg(event.target.value)} disabled={active || Boolean(busy)} />',
        '                                            <input type="number" min="0" max="20" step="0.05" value={cfg} onChange={(event) => setCfg(event.target.value)} disabled={active || Boolean(busy)} />\n                                            <small className={styles.fieldHelp}>{seedVR2Help.cfg}</small>',
        "cfg help",
    ),
    (
        '                                            <select value={samplerName} onChange={(event) => setSamplerName(event.target.value as SeedVR2SamplerName)} disabled={active || Boolean(busy)}>\n                                                {SEEDVR2_SAMPLERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}\n                                            </select>',
        '                                            <select value={samplerName} onChange={(event) => setSamplerName(event.target.value as SeedVR2SamplerName)} disabled={active || Boolean(busy)}>\n                                                {SEEDVR2_SAMPLERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}\n                                            </select>\n                                            <small className={styles.fieldHelp}>{seedVR2Help.sampler[samplerName]}</small>',
        "sampler help",
    ),
    (
        '                                            <select value={scheduler} onChange={(event) => setScheduler(event.target.value as SeedVR2Scheduler)} disabled={active || Boolean(busy)}>\n                                                {SEEDVR2_SCHEDULERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}\n                                            </select>',
        '                                            <select value={scheduler} onChange={(event) => setScheduler(event.target.value as SeedVR2Scheduler)} disabled={active || Boolean(busy)}>\n                                                {SEEDVR2_SCHEDULERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}\n                                            </select>\n                                            <small className={styles.fieldHelp}>{seedVR2Help.scheduler[scheduler]}</small>',
        "scheduler help",
    ),
    (
        '                                            <input type="number" min="0" max="1" step="0.05" value={denoise} onChange={(event) => setDenoise(event.target.value)} disabled={active || Boolean(busy)} />',
        '                                            <input type="number" min="0" max="1" step="0.05" value={denoise} onChange={(event) => setDenoise(event.target.value)} disabled={active || Boolean(busy)} />\n                                            <small className={styles.fieldHelp}>{seedVR2Help.denoise}</small>',
        "denoise help",
    ),
]
for old, new, label in replacements:
    workspace = replace_once(workspace, old, new, label)
workspace_path.write_text(workspace, encoding="utf-8")

css_path = Path("app/components/tools/UpscaleWorkspace.module.css")
css = css_path.read_text(encoding="utf-8")
if ".fieldHelp{" in css:
    raise RuntimeError("fieldHelp style already exists")
css += "\n.fieldHelp{display:block;margin:0;color:var(--muted-2);font-size:10px;font-weight:500;line-height:1.45}\n"
css_path.write_text(css, encoding="utf-8")

test_path = Path("tests/seedvr2-settings-ui.test.mjs")
test_source = test_path.read_text(encoding="utf-8")
if 'SeedVR2 controls explain what each setting and option does' in test_source:
    raise RuntimeError("SeedVR2 option help test already exists")
test_source += r'''

test("SeedVR2 controls explain what each setting and option does", async () => {
  const [workspace, helpCopy, styles] = await Promise.all([
    readFile(new URL("../app/components/tools/UpscaleWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/seedvr2-help.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/tools/UpscaleWorkspace.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /getSeedVR2Help\(locale\)/);
  assert.match(workspace, /seedVR2Help\.scale/);
  assert.match(workspace, /seedVR2Help\.seed/);
  assert.match(workspace, /seedVR2Help\.resize\[resizeMethod\]/);
  assert.match(workspace, /seedVR2Help\.colorCorrection\[colorCorrection\]/);
  assert.match(workspace, /seedVR2Help\.steps/);
  assert.match(workspace, /seedVR2Help\.cfg/);
  assert.match(workspace, /seedVR2Help\.sampler\[samplerName\]/);
  assert.match(workspace, /seedVR2Help\.scheduler\[scheduler\]/);
  assert.match(workspace, /seedVR2Help\.denoise/);
  assert.match(workspace, /styles\.fieldHelp/);
  assert.match(styles, /\.fieldHelp\{/);

  for (const option of [
    "lanczos", "bicubic", "bilinear", "nearest", "area",
    "wavelet", "adain", "none",
    "euler", "euler_ancestral", "heun", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "res_multistep",
    "simple", "normal", "karras", "exponential", "sgm_uniform", "ddim_uniform", "beta",
  ]) {
    assert.match(helpCopy, new RegExp(`${option}:`));
  }
  assert.match(helpCopy, /官方預設為 1/);
  assert.match(helpCopy, /留空會自動隨機/);
  assert.match(helpCopy, /官方預設，最適合官方 1 Step 配置/);
});
'''
test_path.write_text(test_source, encoding="utf-8")
