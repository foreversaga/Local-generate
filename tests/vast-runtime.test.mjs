import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vastRoot = path.join(projectRoot, "scripts", "vast");

async function readVastFile(name) {
  return readFile(path.join(vastRoot, name), "utf8");
}

test("Vast runtime manifest pins the rebuild inventory", async () => {
  const manifest = JSON.parse(await readVastFile("runtime-manifest.json"));

  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.manifestVersion, /^\d{4}\.\d{2}\.\d{2}$/);
  assert.match(manifest.bootstrapVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.remote.comfyPort, 18188);
  assert.equal(manifest.remote.ollamaPort, 11434);
  assert.equal(manifest.models.length, 7);
  assert.ok(manifest.nativeNodes.includes("MiniMaxH3ImageToVideo"));
  assert.ok(manifest.nativeNodes.includes("SaveVideo"));
  assert.equal(new Set(manifest.models.map((model) => model.id)).size, manifest.models.length);
  assert.deepEqual(
    manifest.models.find((model) => model.id === "seedvr2_7b_sharp_nvfp4"),
    {
      id: "seedvr2_7b_sharp_nvfp4",
      repository: "Comfy-Org/SeedVR2",
      revision: "10f035adc869a5b3ffc466360b869641511c0610",
      remotePath: "diffusion_models/seedvr2_7b_sharp_nvfp4.safetensors",
      targetPath: "/workspace/ComfyUI/models/diffusion_models/seedvr2_7b_sharp_nvfp4.safetensors",
      size: 4759694792,
      sha256: "80d57af7722f5a5bd4c01d2ab2688f2bf05e552e59d3d3287257de709db10397",
    },
  );
  assert.equal(new Set(manifest.customNodes.map((node) => node.name)).size, manifest.customNodes.length);
  for (const model of manifest.models) {
    assert.ok(model.repository);
    assert.match(model.revision, /^[0-9a-f]{40}$/);
    assert.ok(model.remotePath);
    assert.ok(model.targetPath.startsWith("/workspace/ComfyUI/"));
    assert.ok(Number.isSafeInteger(model.size) && model.size > 0);
    assert.match(model.sha256, /^[0-9a-f]{64}$/);
  }
  for (const node of manifest.customNodes) {
    assert.match(node.revision, /^[0-9a-f]{40}$/);
    assert.ok(node.repository.startsWith("https://"));
    assert.ok(node.path.startsWith("/workspace/ComfyUI/custom_nodes/"));
  }
  assert.equal(manifest.ollama.models.length, 2);
  assert.equal(manifest.ollama.digestPolicy, "registry-digest-recorded-by-runtime-status");
});

test("Vast connection settings are centralized and safe to copy", async () => {
  const example = JSON.parse(await readVastFile("vast-runtime.config.example.json"));
  assert.equal(example.schemaVersion, 1);
  assert.equal(example.instance.host, "replace-with-vast-host");
  assert.ok(example.instance.sshPort > 0);
  assert.ok(example.tunnel.localComfyPort > 0);
  assert.ok(example.tunnel.localOllamaPort > 0);
  assert.equal(existsSync(path.join(vastRoot, "vast-runtime.config.json")), false);
});

test("Vast bootstrap and drift status scripts pass shell syntax checks", async (t) => {
  const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  if (process.platform === "win32" && !existsSync(bash)) {
    t.skip("Git Bash is not installed");
    return;
  }
  execFileSync(bash, ["-n", path.join(vastRoot, "h3-bootstrap.sh")], { cwd: projectRoot, stdio: "pipe" });
  execFileSync(bash, ["-n", path.join(vastRoot, "runtime-status.sh")], { cwd: projectRoot, stdio: "pipe" });
});

test("Vast scripts consume the manifest and keep replacement state outside source control", async () => {
  const bootstrap = await readVastFile("h3-bootstrap.sh");
  const status = await readVastFile("runtime-status.sh");
  const config = await readVastFile("runtime-config.ps1");
  assert.match(bootstrap, /H3_RUNTIME_MANIFEST/);
  assert.match(bootstrap, /quarantine_file/);
  assert.match(bootstrap, /install_atomic/);
  assert.match(bootstrap, /manifestSha256/);
  assert.match(status, /manifest-checksum-drift/);
  assert.match(status, /sha256/);
  assert.match(config, /VAST_RUNTIME_CONFIG/);
});
