# H3 Studio

- [WebUI 功能說明](docs/webui-functions.md)

## Vast RTX 5090 remote mode

The current Vast instance is reached only through loopback SSH forwards. ComfyUI and Ollama are not exposed directly to the internet.

```powershell
cd C:\Users\forev\minimax-h3-video-studio
.\scripts\vast\start-vast-remote.ps1
.\scripts\vast\status.ps1
```

The launcher forwards local `127.0.0.1:18188` to remote ComfyUI and local `127.0.0.1:11435` to remote Ollama, then starts the Web/API on `http://127.0.0.1:8787/app` with the Vast runtime initially selected. The **MODEL RUNTIME** control in the WebUI can switch the live process between **本機** (`8188` / `11434`) and **Vast 5090** (`18188` / `11435`). A switch is rejected while generation or upscaling is active; when safe, the bridge checks or starts the selected services and releases loaded models on the runtime being left. Inputs stay in the local media library, are uploaded for each remote workflow, and completed artifacts are downloaded back into the local output library.

Remote prompt generation defaults to `hf.co/HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP:Q4_K_M`; `huihui_ai/qwen3-vl-abliterated:32b-instruct-q4_K_M` remains selectable. Both models support text and image prompt inputs. Before Ollama inference the bridge unloads ComfyUI models; before video generation it unloads active Ollama models. Ollama requests use an 8192-token context and `keep_alive: 0`.

Prompt-generation failures and H3 validation failures that occur before a video job is admitted are appended to `logs/prompt-errors-YYYYMMDD.jsonl`. Each record includes the problematic submitted or final candidate prompt, validation/API error details, model, mode, duration, runtime, and timestamp. Attached image data is never written to this log.

The rented instance does not have a persistent Vast volume. Stopping and restarting the same instance preserves `/workspace`, but recycling or destroying it removes Ollama, H3 weights, and configuration. Update the host and SSH port parameters in `scripts/vast/start-tunnel.ps1` after renting a replacement instance.

## Long-video jobs and diagnostics

Long-video drafts and jobs are persisted under `data/jobs/<sequence-id>/`. Each job has an atomic `job.json`, segment files, and an append-only `events.jsonl` with generation, ffprobe/ffmpeg, assembly, API start, and restart-recovery events. A daily summary is written to `logs/long-video-YYYYMMDD.jsonl`; logs include command exit codes and the last stderr bytes but never tokens, base64 media, or repeated full prompts. Set `FFMPEG_PATH` and `FFPROBE_PATH` when the executables are not on `PATH`. Sequence output folders are allocated exclusively below `ComfyUI/output`; an existing folder returns `OUTPUT_FOLDER_EXISTS`.

Continuation prompt finalization has an injectable `finalizePrompt` seam in the runner. For segment 2 and later, the bridge sends the normalized previous tail image transiently to the selected vision-capable Ollama model; request, timeout, unsafe-tail, and validation failures use a deterministic continuity-preserving fallback and record provider/model/fallback provenance without persisting image bytes.

本機 MiniMax H3 影片控制介面。網頁服務同時處理 Ollama、ComfyUI、檔案資源與影片生成，直接使用已開放的 `8787` port。

公開入口 `/app` 直接顯示新版 Create landing，Single、Long、Jobs、Library、Tools 與 Settings 由同一個 Studio shell 提供；所有流程共用既有 `/app/api/...` bridge contract。

## 啟動

先確認 Ollama 與 ComfyUI 已在本機執行，再啟動網頁：

```powershell
cd C:\Users\forev\minimax-h3-video-studio
npm.cmd run dev
```

## 重啟網頁服務

只需要重啟 H3 Studio Web/API 時，使用專案內的固定腳本：

```powershell
cd C:\Users\forev\minimax-h3-video-studio
.\scripts\restart-web.ps1
```

也可以使用 npm 指令：

```powershell
npm.cmd run restart:web
```

腳本會辨識 `8787` 的現有 H3 Studio process、停止後重新執行 `npm.cmd run dev`，並等待 `/app/api/health` 回傳 `200`。ComfyUI `8188` 與 Ollama `11434` 會沿用現有服務，不需要一併重啟；啟動紀錄會寫入專案的 `logs` 資料夾。

網頁與本機 API 共用 `8787`：

```text
http://<主機 IP 或主機名稱>:8787/app
```

不再需要透過 Tailscale Serve 轉送網頁，也不使用 HMR WebSocket。

## 本機服務

```text
網頁：0.0.0.0:8787
ComfyUI：127.0.0.1:8188
Ollama：127.0.0.1:11434
```

手機請使用主機在網路上已開放的 `8787` 位址；ComfyUI 仍使用既有的 `8188` 服務。

## 功能

- Ollama 產生並可手動修改 H3 提示詞
- 長影片可由 Ollama 從整體文字產生 continuity bible、無縫全片分鏡時間、首段 T2VA 與續段 I2VA 提示詞；亦可切換為作者鎖定時間軸
- 文字生片、參考圖生片、影片替換
- 解析度、秒數、Steps、Seed、模型 profile 設定
- 上傳與預覽圖片、影片、輸出 MP4
- 生成進度、取消工作與歷史紀錄

網頁資源只使用 ComfyUI 的兩個原生路徑：上傳與參考素材使用 `C:\Users\forev\ComfyUI\input`，生成影片與輸出資源使用 `C:\Users\forev\ComfyUI\output`。生成器直接寫入 ComfyUI output，不在本專案或 `minimax-h3-local` 建立輸出副本。
