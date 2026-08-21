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
  assert.equal(manifest.models.length, 20);
  assert.ok(manifest.nativeNodes.includes("MiniMaxH3ImageToVideo"));
  assert.ok(manifest.nativeNodes.includes("SaveVideo"));
  assert.ok(manifest.nativeNodes.includes("H3LatentUpscalerLoader"));
  assert.ok(manifest.nativeNodes.includes("H3CleanLatentUpscale2x"));
  assert.ok(manifest.nativeNodes.includes("WanAnimateToVideo"));
  assert.ok(manifest.nativeNodes.includes("DownloadAndLoadSAM2Model"));
  assert.ok(manifest.nativeNodes.includes("VAEDecodeAudio"));
  assert.ok(manifest.nativeNodes.includes("WanSCAILToVideo"));
  assert.ok(manifest.nativeNodes.includes("SAM3_Detect"));
  assert.ok(manifest.nativeNodes.includes("SAM3_VideoTrack"));
  assert.ok(manifest.nativeNodes.includes("SCAIL2ColoredMask"));
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
  assert.deepEqual(
    manifest.models.find((model) => model.id === "h3_latent_upscaler_2x"),
    {
      id: "h3_latent_upscaler_2x",
      repository: "Mamad8/H3-Latent-Upscaler-2x",
      revision: "d2245ba2ccd4e209007a9f80f2bfd6405861a95f",
      remotePath: "h3_clean_latent_upscaler_v1_mamad8.safetensors",
      targetPath: "/workspace/ComfyUI/models/h3_latent_upscalers/h3_clean_latent_upscaler_v1_mamad8.safetensors",
      size: 59022848,
      sha256: "28005ed952a879f8e1d59903bf9c4440fa589d7a39280f960bb3dfb430219c71",
    },
  );
  assert.deepEqual(
    manifest.models.find((model) => model.id === "h3_realism_people_lora"),
    {
      id: "h3_realism_people_lora",
      repository: "fal/MiniMax-H3-Realism-People-LoRA",
      revision: "039cc8579d7aa357a882d7f4111b25da4f72dccc",
      remotePath: "h3-realism-people-t2v-i2v-r2v.safetensors",
      targetPath: "/workspace/ComfyUI/models/loras/h3-realism-people-t2v-i2v-r2v.safetensors",
      size: 131229656,
      sha256: "acc529601d2da117fb81179e76c56e488a3beab1171659d305f04fa3655b787e",
    },
  );
  assert.deepEqual(
    manifest.models.find((model) => model.id === "wan22_animate_diffusion"),
    {
      id: "wan22_animate_diffusion",
      repository: "Kijai/WanVideo_comfy_fp8_scaled",
      revision: "033a4e487f60220b3d6e469599a6aebc46e13cee",
      remotePath: "Wan22Animate/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors",
      targetPath: "/workspace/ComfyUI/models/diffusion_models/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors",
      size: 18401760586,
      sha256: "2936b31473a967e7a429a6646bba60e7862d0938e178b58b2a140f391dd5b8e6",
    },
  );
  assert.deepEqual(
    manifest.models.find((model) => model.id === "sam2_hiera_base_plus"),
    {
      id: "sam2_hiera_base_plus",
      repository: "Kijai/sam2-safetensors",
      revision: "f885607d88bb3f9145efa49c3e3c50a9e5bf13eb",
      remotePath: "sam2_hiera_base_plus.safetensors",
      targetPath: "/workspace/ComfyUI/models/sam2/sam2_hiera_base_plus.safetensors",
      size: 323407992,
      sha256: "fa02d9028dcc4859c191f1d3f1ca1f7eefdb85f3b5e746c9ad738f322f3e89e2",
    },
  );
  assert.deepEqual(
    manifest.models.find((model) => model.id === "scail2_nvfp4"),
    {
      id: "scail2_nvfp4",
      repository: "Comfy-Org/SCAIL-2",
      revision: "3bb6077b807b1a0e80ba35a091042ec2b39dc20e",
      remotePath: "diffusion_models/wan2.1_14B_SCAIL_2_nvfp4_mxpf8_mix.safetensors",
      targetPath: "/workspace/ComfyUI/models/diffusion_models/wan2.1_14B_SCAIL_2_nvfp4_mxpf8_mix.safetensors",
      size: 11023570536,
      sha256: "5053562142b46a12ef368360373304609ce6e6e010b3fddd35ef1cd27e180e7d",
    },
  );
  assert.deepEqual(
    manifest.models.find((model) => model.id === "sam3_auto_mask"),
    {
      id: "sam3_auto_mask",
      repository: "Comfy-Org/sam3.1",
      revision: "5febd4769e8802cdfdb75e1f733abd8c68434a85",
      remotePath: "checkpoints/sam3.1_multiplex_fp16.safetensors",
      targetPath: "/workspace/ComfyUI/models/checkpoints/sam3.1_multiplex_fp16.safetensors",
      size: 1745546848,
      sha256: "9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03",
    },
  );
  assert.deepEqual(
    manifest.models.find((model) => model.id === "wan_animate_dwpose_detector"),
    {
      id: "wan_animate_dwpose_detector",
      repository: "yzd-v/DWPose",
      revision: "1a7144101628d69ee7a3768d1ee3a094070dc388",
      remotePath: "yolox_l.onnx",
      targetPath: "/workspace/ComfyUI/custom_nodes/comfyui_controlnet_aux/ckpts/yzd-v/DWPose/yolox_l.onnx",
      size: 216746733,
      sha256: "7860ae79de6c89a3c1eb72ae9a2756c0ccfbe04b7791bb5880afabd97855a411",
    },
  );
  assert.deepEqual(
    manifest.models.find((model) => model.id === "wan_animate_dwpose_estimator"),
    {
      id: "wan_animate_dwpose_estimator",
      repository: "hr16/DWPose-TorchScript-BatchSize5",
      revision: "359d662a9b33b73f6d0f21732baf8845f17bb4be",
      remotePath: "dw-ll_ucoco_384_bs5.torchscript.pt",
      targetPath: "/workspace/ComfyUI/custom_nodes/comfyui_controlnet_aux/ckpts/hr16/DWPose-TorchScript-BatchSize5/dw-ll_ucoco_384_bs5.torchscript.pt",
      size: 135059124,
      sha256: "d86a0b2b59fddc0901a7076e9f59c9f8602602133ed72511c693fd11eea23d91",
    },
  );
  for (const id of [
    "fl2va_nvfp4",
    "ref2va_nvfp4",
    "qwen3vl_h3_nvfp4_awq",
    "h3_video_vae",
    "h3_audio_vae",
    "h3_latent_upscaler_2x",
    "h3_realism_people_lora",
    "wan22_animate_diffusion",
    "wan_animate_text_encoder",
    "wan_animate_video_vae",
    "wan_animate_clip_vision",
    "wan_animate_lightx2v_lora",
    "wan_animate_relight_lora",
    "sam2_hiera_base_plus",
    "scail2_nvfp4",
    "sam3_auto_mask",
    "wan_animate_dwpose_detector",
    "wan_animate_dwpose_estimator",
  ]) {
    assert.ok(manifest.models.some((model) => model.id === id), `missing H3 runtime artifact: ${id}`);
  }
  assert.equal(new Set(manifest.customNodes.map((node) => node.name)).size, manifest.customNodes.length);
  assert.deepEqual(
    manifest.customNodes.find((node) => node.name === "ComfyUI-H3-Latent-Upscaler-Mamad8"),
    {
      name: "ComfyUI-H3-Latent-Upscaler-Mamad8",
      repository: "https://github.com/mamad8c/ComfyUI-H3-Latent-Upscaler-Mamad8.git",
      revision: "e98237773011523528353a8beb4863e65b099a38",
      path: "/workspace/ComfyUI/custom_nodes/ComfyUI-H3-Latent-Upscaler-Mamad8",
      requirements: "",
    },
  );
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
