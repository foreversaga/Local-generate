# H3 Studio

- [WebUI feature guide](docs/webui-functions.md)
- [Traditional Chinese](README.zh-TW.md)

H3 Studio is a local MiniMax H3 video control interface. The web service coordinates Ollama, ComfyUI, media assets, and video generation through the `/app` entry point.

The public `/app` entry opens the Create landing. Single, Long, Jobs, Library, Tools, and Settings are provided by the same Studio shell, and all flows share the existing `/app/api/...` bridge contract.

## Languages

The Studio interface supports Traditional Chinese (`zh-TW`, the default) and English (`en`). Use the language selector in the top bar to switch languages. The choice is saved in browser `localStorage` under `h3-studio.locale`, restored on later visits, and applied to the document `lang` attribute. Locale changes affect presentation only: API routes, persisted job states, source identifiers, and bridge payloads remain unchanged.

UI translations live in [`app/i18n/dictionaries.ts`](app/i18n/dictionaries.ts). Add the same key to both dictionaries when introducing user-facing shell or workflow copy, and use `useI18n()` in client components. Shared backend status/source labels accept an optional locale through [`app/lib/ui-copy.mjs`](app/lib/ui-copy.mjs).

## Local configuration

Run these commands from the project root:

```powershell
Copy-Item .env.example .env.local
```

If `.env.local` already exists, merge the missing variable names into it instead of overwriting local paths or secrets.

Edit `.env.local` with the paths and service endpoints for the current machine. Keep `.env.local` out of version control. The committed `.env.example` contains only empty values, loopback defaults, and safe placeholders.

The important path settings are:

- `MINIMAX_H3_ROOT` is required by `scripts/vast/start-local-runtime.ps1` and must point to the local `minimax-h3-local` checkout.
- `MINIMAX_H3_PYTHON` is required by `scripts/vast/start-vast-remote.ps1` and must point to a usable Python executable, or to a command available on `PATH`.
- `COMFYUI_ROOT` and `MINIMAX_H3_ROOT` can override the bridge defaults when ComfyUI and the local H3 project are not adjacent to this repository.
- `MINIMAX_H3_AI_TOOLKIT_ROOT`, `MINIMAX_H3_AI_TOOLKIT_PYTHON`, `MINIMAX_H3_AI_TOOLKIT_FFMPEG_BIN`, and the `MINIMAX_H3_Z_IMAGE_*` settings are required only when the Z-Image / AI Toolkit training workflow is used.
- `FFMPEG_PATH` and `FFPROBE_PATH` are required for long-video media processing when the executables are not already on `PATH`.

The existing AI Toolkit variables in an older `.env.local` configure only the Z-Image training backend; they do not replace `MINIMAX_H3_ROOT` or `MINIMAX_H3_PYTHON`.

Do not put credentials, API keys, SSH keys, model tokens, or provider secrets in `.env.example`. Keep real secrets in local ignored files or the deployment provider's secret store. The real Vast connection file is also local-only: copy `scripts/vast/vast-runtime.config.example.json` to `scripts/vast/vast-runtime.config.json`, then set the instance host, SSH port, user, and tunnel ports. The real file is ignored by Git.

## Vast RTX 5090 remote mode

The Vast runtime is reached only through loopback SSH forwards. ComfyUI and Ollama are not exposed directly to the internet. Instance-specific host, SSH port, tunnel ports, and optional persistent-volume settings live in the ignored runtime config; the reproducible software inventory is versioned in [`scripts/vast/runtime-manifest.json`](scripts/vast/runtime-manifest.json).

### New instance / replacement procedure

1. Provision a Vast instance with the required GPU. If persistent storage is available, mount it at `/workspace` (the manifest also reserves `/workspace/.h3-runtime-cache` for a model cache); without it, bootstrap rebuilds from the pinned sources.
2. Copy the bootstrap bundle and manifest to the instance, then run the one-shot bootstrap command:

   ```powershell
   $VastHost = '<VAST_HOST>'
   $SshPort = [int]'<SSH_PORT>'
   $Remote = "root@$VastHost"
   $Files = @(
     'scripts/vast/h3-bootstrap.sh',
     'scripts/vast/runtime-manifest.json',
     'scripts/vast/runtime-status.sh',
     'scripts/vast/ollama.sh',
     'scripts/vast/ollama.conf'
   )
   scp.exe -P $SshPort @Files ("{0}:/workspace/" -f $Remote)
   ssh.exe -p $SshPort $Remote 'chmod 0755 /workspace/h3-bootstrap.sh /workspace/runtime-status.sh && /workspace/h3-bootstrap.sh'
   ```

   Bootstrap is idempotent: verified models and pinned Git checkouts are reused, while missing or mismatched artifacts are quarantined and restored from persistent cache or staging before an atomic install. It writes `/workspace/.h3-runtime-state.json` only after the health check succeeds.
3. Create the local connection file once and update only that file when Vast replaces the instance:

   ```powershell
   Copy-Item scripts/vast/vast-runtime.config.example.json scripts/vast/vast-runtime.config.json
   # Set instance.host, instance.sshPort, instance.user, and tunnel ports in the copied file.
   ```

   The file may live elsewhere by setting `VAST_RUNTIME_CONFIG` in `.env.local` or by passing `-ConfigPath`.
4. Start the tunnel and Web/API, then inspect health and drift:

   ```powershell
   .\scripts\vast\start-vast-remote.ps1
   .\scripts\vast\status.ps1
   ```

   `status.ps1` reports loopback tunnel health, H3 Studio health, manifest version, native-node availability, missing or checksum-mismatched weights, Git revision drift, Ollama model drift, and persistent-cache/state presence. It exits with code `1` while a repair is needed.

The launcher forwards the configured local tunnel ports to remote ComfyUI/Ollama, then starts the Web/API on `http://127.0.0.1:8787/app` with the Vast runtime initially selected. The **MODEL RUNTIME** control in the WebUI can switch the live process between local services (`8188` / `11434`) and Vast. A switch is rejected while generation or upscaling is active; when safe, the bridge checks or starts the selected services and releases loaded models on the runtime being left. Inputs stay in the local media library, are uploaded for each remote workflow, and completed artifacts are downloaded back into the local output library.

Remote prompt generation defaults to `hf.co/HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP:Q4_K_M`; `huihui_ai/qwen3-vl-abliterated:32b-instruct-q4_K_M` remains selectable. Both models support text and image prompt inputs. Before Ollama inference the bridge unloads ComfyUI models; before video generation it unloads active Ollama models. Ollama requests use an 8192-token context and `keep_alive: 0`.

Prompt-generation failures and H3 validation failures that occur before a video job is admitted are appended to `logs/prompt-errors-YYYYMMDD.jsonl`. Each record includes the problematic submitted or final candidate prompt, validation/API error details, model, mode, duration, runtime, and timestamp. Attached image data is never written to this log.

The remote instance is disposable by design. A persistent `/workspace` volume is optional and accelerates recovery through `.h3-runtime-cache`; when it is unavailable, the pinned manifest and bootstrap command are the source of truth. Local Library files and job metadata remain on the local machine and are never the only provenance source on Vast.

## Long-video jobs and diagnostics

Long-video drafts and jobs are persisted under `data/jobs/<sequence-id>/`. Each job has an atomic `job.json`, segment files, and an append-only `events.jsonl` with generation, ffprobe/ffmpeg, assembly, API start, and restart-recovery events. A daily summary is written to `logs/long-video-YYYYMMDD.jsonl`; logs include command exit codes and the last stderr bytes but never tokens, base64 media, or repeated full prompts. Set `FFMPEG_PATH` and `FFPROBE_PATH` when the executables are not on `PATH`. Sequence output folders are allocated exclusively below `ComfyUI/output`; an existing folder returns `OUTPUT_FOLDER_EXISTS`.

Continuation prompt finalization has an injectable `finalizePrompt` seam in the runner. For segment 2 and later, the bridge sends the normalized previous tail image transiently to the selected vision-capable Ollama model; request, timeout, unsafe-tail, and validation failures use a deterministic continuity-preserving fallback and record provider/model/fallback provenance without persisting image bytes.

## Start the web service

After `.env.local` is configured, either reuse healthy local Ollama and ComfyUI services or use the local runtime helper:

```powershell
.\scripts\vast\start-local-runtime.ps1
```

Then start the Web/API from the project root:

```powershell
Set-Location '<PROJECT_ROOT>'
npm.cmd run dev
```

## Restart the web service

When only the H3 Studio Web/API needs to restart, use the fixed project script:

```powershell
Set-Location '<PROJECT_ROOT>'
.\scripts\restart-web.ps1
```

You can also use the npm command:

```powershell
npm.cmd run restart:web
```

The script identifies the existing H3 Studio process on port `8787`, stops it, starts `npm.cmd run dev`, and waits for `/app/api/health` to return `200`. ComfyUI on `8188` and Ollama on `11434` are reused and do not need to restart together. Startup records are written to the project `logs` directory.

## Local services

```text
Web/API: 0.0.0.0:8787
ComfyUI: 127.0.0.1:8188
Ollama: 127.0.0.1:11434
```

A phone or other client should use the host address exposed for port `8787`; ComfyUI remains on its existing loopback service.

The Web/API does not require Tailscale Serve and does not use an HMR WebSocket.

## Features

- Ollama-generated H3 prompts with manual editing
- Long-video continuity bible, full-film storyboard timing, first-segment T2VA prompts, and continuation I2VA prompts generated from the overall text; an author-locked timeline is also supported
- Text-to-video, reference-image-to-video, and video replacement
- Resolution, duration, Steps, Seed, and model-profile settings
- Upload and preview images, videos, and output MP4 files
- Generation progress, cancellation, and history

Web resources use only ComfyUI's two native paths: uploaded and reference media use `<COMFYUI_ROOT>/input`, while generated videos and output resources use `<COMFYUI_ROOT>/output`. The generator writes directly to ComfyUI output and does not create a second output copy in this project or in `minimax-h3-local`.

With the default adjacent Windows checkout, these resolve to `ComfyUI\input` and `ComfyUI\output`.

## CI and hosted configuration

The GitHub workflow runs dependency installation, lint, build, unit tests, and WebUI route smoke checks. It is a quality gate, not a deployment command. Hosted project metadata is kept in `.openai/hosting.json`; credentials belong in the hosting provider's secret configuration and must not be added to this repository.

## License

This project is distributed under the MIT License. See [LICENSE](LICENSE).
