# Sol-H3-Spark 整合 WebUI 實作規畫

狀態：實作前規畫與驗收合約  
目標分支：ai-persona-video  
產生方式：由獨立、未繼承主對話上下文的 sol xhigh 子代理完成初稿，再由主代理依本機現況核對。

## 1. 目標

在 H3 Studio WebUI 中加入 NVIDIA Sana 專案的 Sol-H3-Spark 官方推論能力，並保留目前以 ComfyUI 為後端的既有影片功能。Sol-H3 是獨立的兩階段、多 runtime pipeline，不應被包裝成既有 ComfyUI profile。

本規畫涵蓋：

- 官方 Sol-H3 權重與固定 revision 的安裝、驗證與 readiness。
- t2va、fl2va、ref2va 三種模式。
- 獨立工具頁、API、durable job、worker protocol、GPU/UMA 互斥。
- 輸入素材安全驗證與 comfyui-input/comfyui-output root staging。
- MP4、121 frames、24 FPS、AAC 音軌的結果驗收。
- Browser、既有流程 regression、回滾與 Git 提交驗收。

本文件是實作合約；任何未經官方程式或實機確認的能力都保持關閉，不以同名 ComfyUI node 或模型檔名推測相容性。

## 2. 官方依據

- [Sol-H3-Spark 原始碼](https://github.com/NVlabs/Sana/tree/sol-engine/models/minimax_h3/Sol-H3-Spark)
- [官方 setup 文件](https://github.com/NVlabs/Sana/blob/sol-engine/models/minimax_h3/Sol-H3-Spark/docs/setup.md)
- [官方 checkpoint manifest](https://github.com/NVlabs/Sana/blob/sol-engine/models/minimax_h3/Sol-H3-Spark/configs/checkpoints.json)
- [固定 revision 的 MiniMax-H3 snapshot](https://huggingface.co/MiniMaxAI/MiniMax-H3/tree/9bfb6693f2cf6de171db46d1aa586f67d773a1da)

官方 pipeline 的責任分層為：

~~~
Qwen prompt processing
    -> H3 Stage 1
    -> H3 latent upscaler
    -> H3-to-LTX latent adapter
    -> LTX-2.5 Stage 2
    -> video/audio decode and mux
~~~

官方預設輸出為 1344×768、121 frames、24 FPS、影片加原生 H3 音訊。官方 infer.py 可作 smoke test；正式 WebUI 服務應以官方 Pipeline/worker 的薄 wrapper 管理可重用 session，不重寫官方推論數學。

## 3. 本機現況與保護邊界

### 3.1 WebUI repository

- 路徑：/home/barry0626/minimax-h3/Local-generate
- remote：https://github.com/foreversaga/Local-generate.git
- branch：ai-persona-video
- 本機 HEAD 比 origin/ai-persona-video ahead 4。
- 目前未提交且必須保留的檔案：
  - server/video-generation/readiness.mjs
  - tests/video-generation-readiness.test.mjs

不得 reset、checkout、覆寫、repo-wide format 或提交上述 dirty work。Sol-H3 改動須使用獨立檔案；若必須共用 lifecycle 或 coordinator，只做最小且可審查的增量。

### 3.2 現有服務

| 服務 | Port | 角色 |
| --- | ---: | --- |
| H3 Studio Web/API | 8787 | UI、local bridge、job 管理 |
| ComfyUI | 8188 | 既有圖片／影片 workflow 執行端 |
| 大型 Qwen vLLM | 現場狀態 | 目前占用大量 GB10 UMA，與 Sol-H3 可能衝突 |

目前既有單片影片路徑：

~~~
SingleCreateForm
  -> single-render-request / single-render-validation
  -> local-bridge
  -> gpu-resource-coordinator
  -> ComfyUI :8188
~~~

Sol-H3 必須使用獨立路徑：

~~~
Sol-H3 tool page
  -> Sol-H3 validation
  -> durable job manager
  -> exclusive accelerator lease
  -> Qwen / H3 Stage 1 / LTX Stage 2 workers
  -> job-scoped output validation
~~~

Sol-H3 不經過 ComfyUI，不加入既有 model/profile 下拉選單，也不改變 t2v、i2v、fl2v、l2v、ref2v、replace 語意。

### 3.3 官方程式與權重安裝根

- Sana source：/home/barry0626/minimax-h3/Sana
- Sana branch：sol-engine
- checkpoints：/home/barry0626/minimax-h3/sol-h3-runtime/checkpoints
- jobs：/home/barry0626/minimax-h3/sol-h3-runtime/jobs
- H3 pinned revision：9bfb6693f2cf6de171db46d1aa586f67d773a1da
- Sana branch 的實際 commit SHA 必須另記錄於 runtime manifest。

已確認官方 CPU contract tests 為 65/65；這只證明介面與設定合約，不代表 GPU import、模型載入或端到端生成成功。

## 4. 模式合約

| mode | 功能 | Stage 1 組件 | 輸入 |
| --- | --- | --- | --- |
| t2va | 文字到影片＋音訊 | transformer；不載入 input VAE；FastH3 VSA DataFree | 無媒體 |
| fl2va | 首幀＋尾幀到影片＋音訊 | transformer＋原生 H3 VAE＋VSA | 恰好一張首幀、一張尾幀 |
| ref2va | 參考素材到影片＋音訊 | transformer_ref＋原生 H3 VAE＋Ref2VA LoRA | backend 保留一個圖片／影片／音訊 locator；目前 WebUI picker 暴露圖片或影片 |

MVP 固定輸出：

- 1344×768
- 121 frames
- 24 FPS
- MP4
- audio.generate = true

MVP 不接受 client 覆寫解析度、FPS、frame count 或任意模型組合。ref2va 的多參考、混合媒體、獨立 audio prompt、任意輸入 codec 必須等官方程式和 GPU 實測確認後才可擴充。

### 4.1 Request schema

共用欄位：

~~~
{
  "schemaVersion": 1,
  "mode": "t2va",
  "prompt": "同時描述畫面、動作與聲音",
  "seed": 123456789,
  "audio": { "generate": true },
  "inputs": {}
}
~~~

規則：

- schemaVersion 必須是 server 支援版本。
- mode 僅允許 t2va、fl2va、ref2va。
- prompt 必填，產品上限暫定 4,000 Unicode code points；保留原始 Unicode 與換行。
- seed 可選，必須是官方 pipeline 接受的整數。
- 只拒絕不安全控制字元；不得把 prompt 插入 shell command。
- 在官方支援前，audio.prompt 等未知欄位回傳 422，不得偷偷串接到主 prompt。

fl2va：

~~~
{
  "schemaVersion": 1,
  "mode": "fl2va",
  "prompt": "由首幀自然過渡至尾幀，包含環境聲。",
  "audio": { "generate": true },
  "inputs": {
    "firstFrame": { "root": "comfyui-input", "relativePath": "start.png" },
    "lastFrame": { "root": "comfyui-output", "relativePath": "end.png" }
  }
}
~~~

ref2va：

~~~
{
  "schemaVersion": 1,
  "mode": "ref2va",
  "prompt": "保留參考素材中的人物特徵與聲音氣質。",
  "audio": { "generate": true },
  "inputs": {
    "references": [
      { "root": "comfyui-output", "relativePath": "references/source.mp4" }
    ]
  }
}
~~~

### 4.2 Media locator

瀏覽器只能送受信任的 root ID 與相對路徑：

~~~
{
  "root": "comfyui-input",
  "relativePath": "references/first-frame.png",
  "fingerprint": { "size": 1234567, "mtimeMs": 1780000000000 }
}
~~~

允許 root：

- comfyui-input
- comfyui-output

server 必須將 root ID 對應到設定中的實際目錄，拒絕絕對路徑、..、NUL、symlink escape、非 regular file，以及 realpath 不在 root 內的檔案。副檔名、magic bytes/MIME 和實際解碼結果必須一致。圖片需 decode；影片和音訊需由 ffprobe 驗證 stream、duration、codec、container。

提交後把素材複製到：

~~~
/home/barry0626/minimax-h3/sol-h3-runtime/jobs/<job-id>/inputs/
~~~

staging 前後比較 size/mtime；來源改變即拒絕。正式 job 不使用可被外部修改的 symlink。

## 5. 權重、revision 與 cache

所有下載必須由官方 download_checkpoints.py 和 configs/checkpoints.json 決定路徑、revision、task filter。不可因完整 Hugging Face repo 約 499 GB 而下載未使用的檔案；task-filtered H3 all-mode 約 144 GB，另外還要計入 LTX、LoRA、adapter、offline cache、暫存與 jobs 的 headroom。

### 5.1 必要組件

| logical component | upstream / revision | 相對檔案 | 已知 bytes |
| --- | --- | --- | ---: |
| H3 Stage 1 | MiniMaxAI/MiniMax-H3 / 9bfb6693f2cf6de171db46d1aa586f67d773a1da | MiniMax-H3/transformer/* | 約 66.3 GB |
| H3 Ref Stage 1 | 同上 | MiniMax-H3/transformer_ref/* | 約 66.3 GB |
| H3 native VAE | 同上 | MiniMax-H3/vae/* | 約 10.4 GB |
| H3 common | 同上 | modular_model_index.json、audio_scheduler/*、audio_vae/*、processor/*、scheduler/*、tokenizer/text encoder config | 含 common |
| FastH3 VSA | FastVideo/FastVideo-FastH3-4-step-Preview-v1-LoRA / f509e629374cac104e7f62daecce6d1488a3041d | FastH3-VSA/vsa-datafree/adapter_model.safetensors | 5,339,117,712 |
| Ref2VA LoRA | lightx2v/Minimax-h3-Turbo / 2f015e66b37c585cea9dc4ae6f1850ea8788e742 | Minimax-h3-Turbo/minimax_h3_ref2v_turbo_4step_v0.1_bf16.safetensors | 1,383,677,768 |
| Qwen NVFP4 AWQ | Comfy-Org/MiniMax-H3 / 0543966fbdce5ba05709a8f2031c94bdba629b4a | Comfy-MiniMax-H3/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors | 15,687,142,551 |
| LTX Stage 2 | Lightricks/LTX-2.5 / 5e6e71018ee1756ed329b697a7b4aedc934dfce9 | diffusion_models/ltx-2.5-22b-dev-transformer-bf16.safetensors | 42,018,190,584 |
| LTX distilled LoRA | 同上 | loras/ltx-2.5-22b-distilled-lora-450-bf16.safetensors | 8,899,889,568 |
| LTX video VAE | 同上 | vae/ltx-2.5-video-vae-conv-bf16.safetensors | 1,452,269,922 |
| LTX audio VAE | 同上 | vae/ltx-2.5-audio-vae-bf16.safetensors | 364,866,540 |
| H3 latent upscaler | LBH-123-AI/Minimax_h3_latent_Upscaler / 13ccf95d85d120bdbc92c05b1247a6e147bf54bf | H3-upscaler/minimax_h3_latent_upscaler_3d_bf16.safetensors | 690,592,992 |
| H3-to-LTX adapter | Efficient-Large-Model/H3-to-LTX-Latent-Adapter / cfcd8a7cc36c135142287584728f7fe362df0867 | config.json、model.safetensors | 389,541,112 |

官方 task filter：

- t2va：H3 transformer/*，不下載 native input VAE；加 common、VSA、Qwen、LTX、upscaler、adapter。
- fl2va：H3 transformer/*＋H3 vae/*；共用 VSA、Qwen、LTX、upscaler、adapter。
- ref2va：H3 transformer_ref/*＋H3 vae/*＋Ref2VA LoRA；共用其餘組件。

### 5.2 Offline cache

include-offline 另下載一次性 prompt-cache 所需：

| component | 相對檔案 | bytes |
| --- | --- | ---: |
| INT8 Gemma | text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors | 15,372,969,374 |
| INT8 connector | diffusion_models/ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors | 21,504,034,224 |

若已有相同 revision、dtype、connector 的有效 prompt cache，可不下載 offline-only 組件；第一次安裝先保留，cache 完成後才可評估是否刪除。cache 必須在獨立 provisioning 步驟生成，不能在第一個 Web request 中下載或生成。

### 5.3 Hash lock

runtime manifest 必須記錄 logical component、相對路徑、upstream revision、size、SHA-256、驗證時間、適用 mode、Sana commit。已知 SHA-256：

~~~
VSA       42dc502a2078f166c396a1fa75f29728d1844363652d345d5ef3e2b444ed6470
Ref2VA    9e642fc8749c74f8da5e2382877ab5c7aa37b9a73b7fd0d6d457bd1b3cb1ae99
Qwen      35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6
LTX       792a2bad501ca03262c0bc2ce7a2949e85b142ce18e30894aad5bc849c8e7584
LTX LoRA  86370bbf79a9eb4edaa158907e2b48a5188fe4c5dc8ce30c7eb8f2f131a9bbf5
LTX VAE   685b06ee3d9b2039647698fc4ea33175112462fc374e2777312c907897dfce8d
LTX AVAE  c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5
Upscaler  4f57821f5837f32f7142b67d815606dbd7550f194e5c769f7d6c3f83b146a5e6
Adapter   170199a390c40ac97f5895bc9c8cc29817e74fb9193c858a85d8c0f1f30724ac
~~~

上表的 LTX video VAE hash 需在主代理實際驗證時再次核對官方 manifest；任何 hash 不一致都保持 not-ready。已有 ComfyUI 目錄中的同名 Qwen/upscaler 不可直接視為 Sol-H3 相容檔案。

## 6. Runtime 設定

建議由明確環境變數提供：

~~~
SOL_H3_ENABLED
SOL_H3_SANA_ROOT
SOL_H3_CHECKPOINT_ROOT
SOL_H3_JOB_ROOT
SOL_H3_QWEN_PYTHON
SOL_H3_STAGE1_PYTHON
SOL_H3_STAGE2_PYTHON
SOL_H3_H3_REVISION
SOL_H3_RUNTIME_MANIFEST
SOL_H3_PATHS_FILE
SOL_H3_T2VA_PATHS_FILE
SOL_H3_FL2VA_PATHS_FILE
SOL_H3_REF2VA_PATHS_FILE
SOL_H3_PROMPT_CACHE
~~~

官方 observed dependency 需要分開管理 Qwen、H3 Stage 1、LTX Stage 2 runtime。不得直接把下載用的 ComfyUI venv 當成已驗證的完整推論環境；須先記錄 Python、PyTorch、CUDA、Transformers、Diffusers、FlashAttention/FastVideo 等版本，再逐一 probe。

三個 task 使用分開的官方 `prepare.py` path manifest：t2va 與 fl2va 各自包含 VSA 路徑，ref2va 包含 Ref2VA LoRA 路徑；共用的 H3、Qwen、LTX、upscaler、adapter 與 prompt cache 路徑。WebUI 可以用 `SOL_H3_PATHS_FILE` 覆寫單一 manifest，也可以用三個 task-specific 變數並行保留相容路徑。

worker 以 argv array 啟動，不使用 shell 字串。正式服務由 Node supervisor 管理 process group；每個 worker 的 stdout 只能是 JSONL，Python logging、warning、CUDA 訊息全部到 stderr。

JSONL 最小事件：

~~~
{"v":1,"type":"hello","worker":"stage1","pid":1234}
{"v":1,"type":"ready","sessionId":"stage1-t2va-abc"}
{"v":1,"type":"progress","requestId":"req-123","stage":"stage1","current":4,"total":20}
{"v":1,"type":"result","requestId":"req-123","status":"ok"}
~~~

session key 至少包含 runtime、mode、Sana commit、checkpoint manifest digest、dtype/runtime flags、adapter/LoRA digest。模式切換時必須重新確認實際 loaded components，不得沿用不相容的 transformer、VAE 或 LoRA。

GB10 是 UMA。admission 只依據實際 MemAvailable、NVIDIA residency/process、kernel OOM/error、衝突服務與上一階段是否釋放；不可把 GPU accounting、RSS、MemAvailable 當三個可相加的記憶體池。預設採序列 residency，三個 runtime 是否可同時常駐必須靠實機測量。

## 7. Job、API 與 recovery

### 7.1 API

| method | route | 目的 |
| --- | --- | --- |
| GET | /api/sol-h3/capabilities | schema、模式、輸入限制、固定輸出 |
| GET | /api/sol-h3/readiness | code、runtime、checkpoint、cache、GPU conflict |
| POST | /api/sol-h3/jobs | 驗證並建立 job |
| GET | /api/sol-h3/jobs | job 列表 |
| GET | /api/sol-h3/jobs/:id | 狀態、事件摘要、結果 |
| GET | /api/sol-h3/jobs/:id/events | SSE；另提供 polling fallback |
| POST | /api/sol-h3/jobs/:id/cancel | 冪等取消 |
| GET | /api/sol-h3/jobs/:id/outputs/:outputId | job-scoped、安全的 output/Ranges |

狀態碼：

- 202：建立或取消已接受。
- 409：GPU、ComfyUI 或外部 Qwen 衝突。
- 422：schema、prompt 或素材不合法。
- 503：runtime、checkpoint 或 cache 未 ready。
- 404：未知 job/output。

建立 job 支援 Idempotency-Key，避免瀏覽器重送造成重複的大型工作。回應不得洩漏主機絕對路徑、完整 traceback 或環境變數。

### 7.2 Durable layout

~~~
/home/barry0626/minimax-h3/sol-h3-runtime/jobs/<job-id>/
  request.json
  state.json
  events.jsonl
  checkpoint-fingerprint.json
  inputs/
  intermediates/
  outputs/
  logs/
~~~

request.json 建立後不可修改；state.json 使用 temporary file 加 atomic rename；events.jsonl append-only。每個 artifact 附 checksum、size、producer、pipeline fingerprint。job ID 只能由 server 產生。job store 啟動時要有單一 manager lock。

狀態機：

~~~
queued
  -> waiting_gpu
  -> preparing
  -> qwen_running
  -> stage1_running
  -> upscaling
  -> adapting
  -> stage2_running
  -> validating
  -> succeeded
~~~

終止狀態是 failed、cancelled、interrupted；執行中取消先進入 cancel_requested。

Web/API 重啟時，queued/waiting job 可重載；所有 running state 一律轉 interrupted，不能假設舊 PID、CUDA context 或 session 仍有效。只有 artifact checksum、checkpoint fingerprint、Sana commit、task、adapter/LoRA 版本和官方可恢復語意全數相同，才可提供 Stage 2 resume。

### 7.3 取消

取消流程：

1. cancel_requested。
2. cooperative worker cancel。
3. 有限 grace period。
4. 對該 job process group SIGTERM。
5. 超時才 SIGKILL。
6. 確認子程序全退後釋放 lease。

保留 logs、events 和不完整 artifact，但不把暫存檔標成成功輸出。禁止 pkill python、killall 或模糊 process name。

## 8. GPU/服務互斥

擴充既有 server/runtime/gpu-resource-coordinator.mjs 時，保持既有工作語意，加入可辨識的全域排他 lease：

~~~
resource: accelerator-global
mode: exclusive
ownerType: sol-h3
ownerId: <job-id>
~~~

另使用 runtime root 的 host-level lock，防止第二個 Web/API process 繞過 in-process coordinator。

取得 lease 前：

1. 阻止新的 ComfyUI GPU job。
2. 確認 ComfyUI queue 和 active work 為空。
3. 依已驗證的 lifecycle hook unload。
4. 若 UMA 仍不足，只能停止明確 allowlist 中的 ComfyUI service。
5. 確認 process/container 退出及記憶體回收後才載入 Sol-H3。

大型 Qwen vLLM 不由 WebUI coordinator 自動管理，初版採 reject-only：readiness/preflight 偵測實際 listener、process/container 和衝突服務，發現衝突回傳 409。未來若加入自動停機，必須是明確 allowlist、記錄本次停止的服務、完成後只恢復本次停止者；不得依 container 名稱猜 port ownership。

## 9. UI 整合

建議新增獨立路由 /app/create/sol-h3 或等價的 tools route，並在 SOL_H3_ENABLED 開啟時才顯示入口。不得把 Sol-H3 profile 加進 SingleCreateForm.tsx。

頁面最少包含：

1. t2va、fl2va、ref2va 模式選擇。
2. prompt（明確提示同時描述畫面、動作、聲音）。
3. 模式對應的素材欄位。
4. 固定輸出摘要 1344×768 / 121 / 24 FPS / native audio。
5. readiness：code、三個 runtime、各模式 checkpoints、cache、GPU conflict。
6. 排他 GPU/UMA 警告。
7. stage timeline、取消、reload 後 job 恢復。
8. 影片播放器、音訊存在提示、下載、manifest/error 摘要。

未 ready 模式禁用提交，且明確顯示 missing component。ref2va 音訊參考必須說明它是條件素材，不是直接替換最終音軌。

媒體選擇器可重用既有 UI，但必須保留 root、name、kind，同時支援 ComfyUI input 和 output root；瀏覽器不接收任意絕對路徑。成功後只顯示該 job 的 output，不用共用目錄中的最新檔案猜結果。

## 10. 建議檔案變更

### 10.1 新增

~~~
app/create/sol-h3/page.tsx
app/components/create/SolH3CreateForm.tsx
app/components/create/SolH3JobPanel.tsx
app/components/create/SolH3MediaSelector.tsx

app/lib/sol-h3-request.mjs
app/lib/sol-h3-validation.mjs
app/lib/sol-h3-client.mjs

server/sol-h3/api.mjs
server/sol-h3/capabilities.mjs
server/sol-h3/readiness.mjs
server/sol-h3/job-manager.mjs
server/sol-h3/job-store.mjs
server/sol-h3/state-machine.mjs
server/sol-h3/media-validation.mjs
server/sol-h3/gpu-admission.mjs
server/sol-h3/runner-client.mjs
server/sol-h3/output-validation.mjs
server/sol-h3/runtime-config.mjs
server/sol-h3/workers/protocol.py
server/sol-h3/workers/qwen_worker.py
server/sol-h3/workers/stage1_worker.py
server/sol-h3/workers/stage2_worker.py

tests/sol-h3-request.test.mjs
tests/sol-h3-media-validation.test.mjs
tests/sol-h3-job-state.test.mjs
tests/sol-h3-runner-protocol.test.mjs
tests/sol-h3-output-validation.test.mjs
tests/sol-h3-gpu-exclusion.test.mjs
~~~

### 10.2 最小修改

- local-bridge.mjs：只註冊 /api/sol-h3/* 與 shutdown lifecycle。
- server/runtime/gpu-resource-coordinator.mjs：向後相容地支援 Sol-H3 exclusive lease。
- 共用導覽：feature flag 開啟時加入入口。
- package/config：加入設定、測試與 provisioning 指令，但不在 Web request 中自動下載或啟動大模型。

下列檔案和行為保持不變：

- server/video-generation/readiness.mjs
- tests/video-generation-readiness.test.mjs
- 既有 SingleCreate request/validation 和 ComfyUI profile mapping。
- 既有 input/output root、歷史 jobs、生成輸出與服務資料。
- 官方 Sana 推論演算法。

### 10.3 本次 WebUI adapter 的落地範圍

第一版 WebUI adapter 已採用 job-scoped staging、獨立 job state、全域 GPU coordinator lease、host lock 與官方 infer.py argv 執行器。它不會在 HTTP request 中下載權重，也不會繞過 readiness gate。這個 one-shot runner 是為了先固定 WebUI/API 與官方 CLI 的資料契約；只有完成 GPU smoke test、取消和 restart recovery 的實測後，才可升級為可重用的三個 persistent worker session。

因此目前的成功條件是：

- SOL_H3_RUNTIME_READY=1 只在三個 runtime 的 import/load probe 通過後設定。
- SOL_H3_CHECKPOINTS_VERIFIED=1 只在官方 manifest 的 size/hash lock 完成後設定。
- prompt cache 完整且 offline 可讀。
- 官方 runner 產生的檔案通過 MP4、AAC、1344×768、121 frames、24 FPS 驗證。

未滿足上述條件時，工具頁仍可顯示模式與缺口，但 submit 必須被禁用；這不是把未驗證環境宣稱為可生成。

## 11. Readiness

readiness 必須區分：

- installed：檔案存在且 layout 正確。
- verified：revision、size、hash 通過。
- runtimeReady：import/probe 通過。
- modeReady：該 task 的 transformer/VAE/LoRA 實際可載入。
- cacheReady：offline cache 完整。
- gpuBusy：目前資源是否可取得。

建議回應：

~~~
{
  "enabled": true,
  "code": { "sanaCommit": "...", "cpuContractTests": "passed" },
  "runtimes": {
    "qwen": { "ready": true },
    "stage1": { "ready": true },
    "stage2": { "ready": true }
  },
  "modes": {
    "t2va": { "ready": true, "missing": [] },
    "fl2va": { "ready": false, "missing": ["native_h3_vae"] },
    "ref2va": { "ready": false, "missing": ["ref2va_lora"] }
  },
  "gpu": { "busy": true, "conflicts": ["configured-qwen-vllm"] }
}
~~~

GPU busy 不等於 checkpoint not ready，兩者不可合併成模糊的 available=false。hash/layout/runtime load 未通過前，UI 不得顯示 ready。

## 12. 分階段交付

### Phase 0：provisioning 與 gate

- 完成 task-filtered checkpoints、hash lock、runtime manifest。
- 固定 Sana commit 和三個 runtime 設定。
- 以官方 infer.py 對三種 mode 做 smoke test。
- 確認實際 loaded transformer/VAE/LoRA、輸入 codec、參考上限、輸出 codec。
- 建立 fake worker protocol tests。
- gate 未通過前不開放 WebUI submit。

### Phase 1：t2va

- durable job store、狀態機、取消和 recovery。
- global GPU lease、ComfyUI/vLLM conflict gate。
- worker protocol 和 t2va UI/API。
- 一次完整實機輸出，證明無 input VAE，驗證 MP4/AAC。

### Phase 2：fl2va

- 首幀／尾幀具名 selector。
- 兩個 ComfyUI media roots 的安全 staging。
- native H3 VAE session assertion。
- 一次完整實機輸出與 frames/FPS/audio 驗收。

### Phase 3：ref2va

- 圖片、影片、音訊各一個單參考 E2E。
- 證明 transformer_ref、native VAE、Ref2VA LoRA 實際載入。
- 官方多參考能力確認後才提高上限。

### Phase 4：hardening

- restart recovery、各階段取消、worker crash/invalid JSONL。
- artifact fingerprint、Stage 2 resume gate。
- ComfyUI/vLLM 衝突與恢復。
- Browser 本機與需要時的 Tailscale 驗收。
- 既有 single video regression。

## 13. 測試與驗收

### 13.1 Contract

- t2va 無媒體接受；帶媒體 422。
- fl2va 缺首幀或尾幀 422；首尾各一張接受。
- ref2va backend 的單圖片、單影片、單音訊 locator 各接受；零個或兩個參考在 MVP 422。現有素材庫只索引圖片／影片，因此 WebUI 第一版不顯示音訊 picker。
- 絕對路徑、..、NUL、symlink escape、MIME 不符拒絕。
- input/output root 都能正確 staging。
- 超過 size、duration、pixel cap 拒絕。

### 13.2 Worker/job

- 正常 JSONL、partial line、stdout 混入 log、worker crash、EOF、heartbeat timeout。
- 每個 active state restart recovery。
- queued job 可重載；running job 變 interrupted。
- 同 mode session 可安全重用；模式切換不沿用錯誤組件。
- artifact fingerprint 不符不得 resume。
- queued、active、worker crash 取消都不殘留 lease。

### 13.3 GPU

- ComfyUI queue 非空時 Sol-H3 不啟動。
- Sol-H3 lease 持有時新的 ComfyUI GPU job 得到明確拒絕或排隊。
- 大型 Qwen vLLM 存在時 preflight 409。
- 未知 NVIDIA process 或實測記憶體不足時拒絕載入。
- worker 全退後才釋放 lease。

### 13.4 端到端

每個成功輸出都必須以 job-scoped manifest 和 ffprobe/完整 decode 驗證：

- video stream 恰好符合預期。
- 1344×768。
- 121 frames，而不是只用 duration 推估。
- 24 FPS。
- 至少一條 audio stream，最終 codec 為 AAC。
- A/V duration 在實測容許範圍。
- 檔案是 regular file、非零、可完整解碼。

CPU contract 65/65 不能取代 GPU E2E。

### 13.5 Browser

build 和重啟前先等既有 queue 清空。主代理執行正式 build，只重啟 H3 Studio 8787；UI 變更後用 Browser 實際：

- 進入 Sol-H3 頁面、切換三種 mode。
- readiness 未完成時不能 submit。
- input/output root 選材和 root 顯示。
- submit、stage timeline、reload 恢復、cancel。
- 成功播放、音訊存在、下載與 manifest 相符。
- 既有 single video 仍送到 ComfyUI。
- Sol-H3 期間既有 ComfyUI flow 顯示排他狀態。

## 14. 回滾

1. 設定 SOL_H3_ENABLED=false。
2. 停止 Sol-H3 worker，確認 process group 全部退出。
3. 釋放 in-process 和 host-level lease。
4. 只恢復本次由 Sol-H3 明確停止的 allowlisted service。
5. 保留 checkpoints、jobs、logs、outputs，除非另有明確刪除要求。
6. 驗證 8787 health、8188、既有 single video request、profile 和 media roots。

回滾不得 reset/checkout ahead 4 commits，不得刪除目前 dirty work、下載中的權重或使用者生成內容。

## 15. 目前尚待主代理現場核實

- Sana sol-engine 實際 commit SHA。
- 官方 manifest 全部相對路徑、LFS OID、SHA-256 和完成大小。
- Qwen/upscaler 是否與官方權重完全相同；同名檔案不算證明。
- 三個 runtime 的 import/load、CUDA/PyTorch 版本與套件相容性。
- upscaler、adapter 的實際 runtime 歸屬。
- ref2va 參考數、混合媒體、audio prompt 和輸入 codec 上限。
- fl2va 是否嚴格要求首尾兩張圖。
- 三種 mode 的 peak UMA、載入／卸載時間和最低安全 MemAvailable。
- 現在 vLLM listener、process/container 的實際 owner 和安全 lifecycle。
- ComfyUI drain/unload/stop/restart hook。
- LTX 原始輸出 codec、AAC mux 是否額外需要 ffmpeg。
- offline cache 在禁止網路環境的完整性。
- 下載後剩餘 SSD 是否仍保有安全 headroom。

在上述條件完成前，任何 UI/API readiness 必須如實標示 partial/not-ready，不得以 listener、檔案存在或 CPU tests 通過宣稱可生成。
