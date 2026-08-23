from pathlib import Path

path = Path(__file__).resolve().parents[1] / "tests" / "video-upscale.test.mjs"
text = path.read_text(encoding="utf-8")
old = '''  assert.deepEqual(normalizeSeedVR2Settings({ scale: 1.25, resizeMethod: "area", colorCorrection: "none" }), {
    scale: 1.25,
    resizeMethod: "area",
    colorCorrection: "none",
  });'''
new = '''  assert.deepEqual(normalizeSeedVR2Settings({ scale: 1.25, resizeMethod: "area", colorCorrection: "none" }), {
    scale: 1.25,
    resizeMethod: "area",
    colorCorrection: "none",
    steps: 1,
    cfg: 1,
    samplerName: "euler",
    scheduler: "simple",
    denoise: 1,
  });'''
if text.count(old) != 1:
    raise RuntimeError("expected exactly one legacy SeedVR2 settings assertion")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("SeedVR2 legacy settings expectation updated.")
