# LoRA Trainer WebUI 實作規劃

## 1. 文件目的與交付原則

- 在既有 Video Studio 的 Tools 區新增可本機操作的 LoRA Trainer WebUI。<br>MVP 先支援 SDXL 與 Illustrious 訓練、註冊、安裝與既有 consumer 選用。
- 文件必須先以獨立 commit 提交；任何實作 commit 都不得混入本文件 commit。<br>實作期間允許依 ownership 平行修改，但各子代理不自行跑 test/build。
- 所有平行修改合流後，統一執行集中式 happy-path 驗證。<br>若驗證失敗，由主代理依失敗模組分派原 owner 修正，避免多人搶修造成 dirty overlap。

## 2. Goals

- 提供 `/app/tools/lora-trainer` 五階段流程：Dataset → Captions → Config/Preflight → Progress → Artifact。<br>支援多選既有圖片與上傳圖片，複製進獨立 job dataset，避免依賴易變來源。
- 透過本機 Ollama Gemma4 產生結構化 captions，可逐張 review、edit、retry；`captionReviewMode` 預設為 `auto`，另提供 `manual`。<br>Dataset 頁可一鍵「開始訓練」：server 依序 captioning → schema validation → preflight → FIFO enqueue；auto 成功即繼續，錯誤則停在可修復頁。
- 同一時間僅允許一個訓練 job 取得 GPU lease，並提供 progress、cancel、重啟 recovery。<br>成功輸出 `.safetensors` 後，驗證檔案並原子安裝至 `ComfyUI/models/loras/trained`。
- 以 registry 提供 ID、family、base profile、provenance、hash、trigger words。<br>所有既有 LoRA consumer 都從一致且可依 family filter 的 `/api/loras` 取得資料。
- 保留每次 job、retry 與最終 LoRA 的完整 provenance，可追查資料集、設定與來源 job。<br>所有 runtime、下載、job、scheduler、log、output、registry/cache 集中於可設定的 `LORA_TRAINING_ROOT`，預設 `data/lora-training/`。

## 3. Non-goals

- MVP 不支援 SD1.5、Z-Image、Wan LoRA 訓練；列入 phase 2。<br>MVP 不提供雲端 GPU、分散式訓練、多 GPU 並行或遠端 worker。
- MVP 不提供任意 shell command、任意 Python module、任意 trainer arguments。<br>MVP 不允許使用者指定任意輸出路徑或覆寫 ComfyUI 既有 LoRA。
- MVP 不做 checkpoint 合併、LoRA merge、量化、模型發布或外部 hub 上傳。<br>MVP 不把大型 artifact、caption 原圖或完整 log 內嵌到一般 jobs API response。
- 不在實作子代理階段加入大量低價值單元測試或 snapshot 測試。

## 4. 現況整合依據

- Tools 卡片與新入口沿用 `app/(studio)/tools/page.tsx:10-25` 的頁面結構。<br>route 定義與導覽整合參照 `app/lib/webui-routes.mjs:48-57`。
- 圖片來源選擇沿用 `app/components/library/AssetPickerButton.tsx:7-15,92-115` 的 AssetPicker 行為。<br>進度呈現參照 `app/components/jobs/JobsWorkspace.tsx:16-84`，但訓練狀態使用獨立 schema。
- base profile 與 graph 關聯參照 `server/image-generation/img2img.mjs:33-80,326-440`。<br>LoRA discovery 與 bridge API 現況參照 `local-bridge.mjs:1397-1467,2653-2660`。
- Wan CLI 與 workflow 只作 phase 2 邊界參考：`src/animate_video.py:45-73`、`src/comfyui/workflow.py:644-850`。

## 5. 架構總覽

```text
Browser /app/tools/lora-trainer
  ├─ Dataset picker/upload
  ├─ Caption review editor
  ├─ Config + preflight
  ├─ Progress / cancel
  └─ Artifact details / download
             │ JSON + multipart
             ▼
Video Studio API routes
  ├─ input validation + allowlists
  ├─ job state service (atomic JSON)
  ├─ caption adapter ───────► Ollama /api/generate (Gemma4)
  ├─ FIFO scheduler ────────► single GPU lease
  ├─ trainer process adapter► pinned sd-scripts + root/runtime/.venv
  └─ artifact installer ────► hash/validate/atomic rename
             │
             ├─ LORA_TRAINING_ROOT/{runtime,jobs,cache}
             ├─ LORA_TRAINING_ROOT/{scheduler.json,registry.json}
             └─ ComfyUI/models/loras/trained/*.safetensors
                                      │
                                      ▼
                    /api/loras?family=... → all LoRA consumers
```

## 6. Runtime 與依賴隔離

- `LORA_TRAINING_ROOT` 是唯一可設定資料根，預設 `data/lora-training/`；runtime、下載 cache 與所有可變訓練資料不得散落 repository 其他位置。<br>使用 `$LORA_TRAINING_ROOT/runtime/.venv` 隔離 Python，sd-scripts checkout 固定在 `$LORA_TRAINING_ROOT/runtime/sd-scripts`。
- `sd-scripts` 必須 pin 至明確 commit SHA；不得追蹤浮動 branch 或未鎖定 tag。<br>tracked code/presets/bootstrap 放在 `server/lora-training/` 與 `scripts/`，依賴 lock 與 CUDA/PyTorch 相容矩陣納入 repository 管理。
- API 僅能選擇預先定義 preset，不能直接傳遞任意 sd-scripts 參數。<br>啟動時不自動安裝依賴；health/preflight 僅檢查並回報修復指令。

## 7. 檔案與目錄配置

```text
server/lora-training/            # tracked service code、schemas、presets
scripts/                         # tracked bootstrap/maintenance entrypoints
data/lora-training/              # default LORA_TRAINING_ROOT；可由設定替換
  runtime/
    .venv/                       # isolated Python environment
    sd-scripts/                  # pinned checkout
  jobs/<uuid>/
    dataset/{images,captions,manifest.json}
    config/{requested.json,resolved.json,command.json}
    logs/{events.jsonl,trainer.log}
    output/{staging,final}
    state.json
  scheduler.json                 # durable queue/lease snapshot
  registry.json                  # trained LoRA metadata/provenance
  cache/                         # downloads、validated reusable inputs
ComfyUI/models/loras/trained/<registry-id>.safetensors
```

- 所有 job 中間檔、dataset、config、log、output 都必須留在 `$LORA_TRAINING_ROOT/jobs/<uuid>` 內；job API 不接受檔案系統路徑。<br>最終驗證成品複製到 ComfyUI `trained` 是唯一允許的 root 外副本；runtime、checkout、下載與 registry 不得另設外部位置。

## 8. Job 狀態 schema

```ts
type LoraJobState = {
  schemaVersion: 1;
  id: string;                    // UUID v4
  revision: number;              // 每次原子寫入遞增
  status:
    | "draft" | "captioning" | "caption_review" | "caption_failed"
    | "preflight_failed" | "queued" | "training"
    | "cancelling" | "cancelled" | "installing"
    | "completed" | "failed" | "interrupted";
  createdAt: string;
  updatedAt: string;
  dataset: { imageCount: number; manifestPath: string };
  captionReviewMode: "auto" | "manual";
  captions: { total: number; confirmed: number; failed: number };
  training: {
    family: "sdxl" | "illustrious";
    presetId: string;
    baseProfile: string;
    attempt: number;
    pid?: number;
    startedAt?: string;
    endedAt?: string;
    step?: number;
    totalSteps?: number;
    epoch?: number;
    loss?: number;
    etaSeconds?: number;
  };
  artifact?: { registryId: string; sha256: string; sizeBytes: number };
  error?: ApiError;
  provenance: { sourceJobId?: string; retryOf?: string; sourceAssets: string[] };
};
```

- `state.json` 是單一 job 的 durable source of truth。<br>`revision` 支援 optimistic concurrency；caption/config 更新需帶入預期 revision。
- retry 建立新 job UUID，不覆寫原 job，並記錄 `retryOf` 與來源 artifact/job。

## 9. Caption schema

```ts
type CaptionRecord = {
  imageId: string;
  imageFile: string;
  status: "pending" | "generating" | "ready" | "edited" | "failed";
  caption: string;
  rawResponse?: string;
  model: string;
  promptVersion: string;
  attempts: number;
  updatedAt: string;
  error?: ApiError;
};
```

- Caption manifest 以 array 或 keyed object 儲存在 job dataset 內並採原子寫入。<br>送往 Ollama 的 request 使用 `POST /api/generate`、`images[]` 與 `format: "json"`。
- server 將圖片轉成 Ollama 接受的 base64，瀏覽器不直接呼叫 Ollama。<br>JSON response 必須經 schema validation；不合法 JSON 視為可 retry 的 caption error。
- `auto` 在所有 captions 通過 schema validation 後寫入同名 `.txt` 並自動 preflight/enqueue；`manual` 才停在 `caption_review` 等候確認。<br>任一 caption 或 preflight 失敗都停止自動推進，保留可修復狀態且絕不把錯誤/未驗證 caption 帶入訓練。

## 10. Registry schema

```ts
type LoraRegistryEntry = {
  schemaVersion: 1;
  id: string;
  fileName: string;
  relativePath: string;
  family: "sdxl" | "illustrious" | "sd15" | "z-image" | "wan";
  baseProfile: string;
  displayName: string;
  triggerWords: string[];
  sha256: string;
  sizeBytes: number;
  installedAt: string;
  provenance: {
    jobId: string;
    attempt: number;
    presetId: string;
    sdScriptsCommit: string;
    datasetManifestHash: string;
    configHash: string;
  };
};
```

- `$LORA_TRAINING_ROOT/registry.json` 包含 `schemaVersion`、`revision` 與 `entries`。<br>registry ID 穩定且不由 display name 推導；建議 `trained:<uuid>`。
- 檔名必須由 server 生成並通過 allowlist，避免 path traversal 與名稱碰撞。<br>registry 不取代 filesystem discovery；它補充已訓練 LoRA 的 metadata 與 provenance。

## 11. API 設計

### 11.1 建立與讀取 job

- `POST /api/lora-training/jobs`<br>Request：`{ sourceAssetIds?: string[], uploadTokens?: string[], captionReviewMode?: "auto" | "manual", config?: { family, baseProfile, presetId, outputName, triggerWords, overrides? } }`；mode 預設 `auto`。
- Response `201`：`{ job: LoraJobState }`<br>`GET /api/lora-training/jobs/:id`
- Response `200`：`{ job, captionsSummary, links }`<br>`GET /api/lora-training/jobs?status=&cursor=&limit=` 提供有界分頁，預設不含 log/artifact bytes。

### 11.2 Dataset 上傳與管理

- `POST /api/lora-training/jobs/:id/images`，使用 multipart，上限由 server 設定。<br>`POST /api/lora-training/jobs/:id/images/import`，request 為 `{ assetIds: string[], revision }`。
- `DELETE /api/lora-training/jobs/:id/images/:imageId?revision=`，僅限 draft/caption_review。<br>Response 回傳更新後 revision、image metadata 與 validation warnings。

### 11.3 Caption 操作

- `POST /api/lora-training/jobs/:id/captions/generate`<br>Request：`{ imageIds?: string[], revision: number }`；省略 imageIds 表示 pending/failed。
- `GET /api/lora-training/jobs/:id/captions?cursor=&limit=` 提供 caption pagination。<br>`PATCH /api/lora-training/jobs/:id/captions/:imageId`
- Request：`{ caption: string, revision: number }`。<br>`POST /api/lora-training/jobs/:id/captions/:imageId/retry`
- `POST /api/lora-training/jobs/:id/captions/confirm`<br>Confirm request：`{ revision: number }`；成功後 captions immutable，進入設定/排隊流程。

### 11.4 設定、preflight 與排程

- `PUT /api/lora-training/jobs/:id/config`<br>Request 僅包含 allowlisted fields：`family`、`baseProfile`、`presetId`、`outputName`、`triggerWords` 與有限 overrides。
- `POST /api/lora-training/jobs/:id/preflight` 回傳 checks、warnings、resolved config。<br>`POST /api/lora-training/jobs/:id/enqueue`
- Request：`{ revision: number, preflightToken: string }`。<br>preflight token 綁定 config hash、dataset hash、過期時間，避免檢查後設定被替換。
- `POST /api/lora-training/jobs/:id/start` 是一鍵 orchestration endpoint；request 為 `{ revision, captionReviewMode, config }`，idempotency key 綁定 job/revision。<br>server 依序 captioning → schema validation → preflight → enqueue；manual 在 caption review 暫停，auto 僅於全部成功時入列。

### 11.5 控制、事件與 retry

- `POST /api/lora-training/jobs/:id/cancel`，idempotent；已終止 job 回傳目前狀態。<br>`POST /api/lora-training/jobs/:id/retry`，建立新 job 並回傳 `201` 與新 ID。
- `GET /api/lora-training/jobs/:id/events?after=` 可用 SSE 或輪詢取得節流進度。<br>前端對 aria-live 的進度公告節流，不能每個 trainer log line 都朗讀。

### 11.6 Artifact 與 LoRA discovery

- `GET /api/lora-training/jobs/:id/artifact` 只回 metadata、provenance 與 download link。<br>`GET /api/lora-training/jobs/:id/artifact/download` 串流單一已驗證檔案。
- download response 設定固定 content type、safe filename、no-sniff 與存取檢查。<br>`GET /api/loras?family=sdxl&baseProfile=...` 回傳結構化且向後相容資料。
- 舊 consumer 所需欄位繼續保留；新增 `id/family/baseProfile/provenance/hash/triggerWords`。

## 12. 統一錯誤格式

```ts
type ApiError = {
  code: string;
  message: string;
  retryable: boolean;
  field?: string;
  details?: Record<string, unknown>;
  requestId?: string;
};
```

- HTTP `400` schema/field invalid；`404` job/image/artifact 不存在。<br>HTTP `409` revision conflict、狀態不允許、名稱或 registry 衝突。
- HTTP `413` 圖片/批次超限；`415` 不支援的 MIME/實際檔案型別。<br>HTTP `422` caption/config/preflight 語意錯誤；`423` job 已被 scheduler 鎖定。
- HTTP `429` caption/Ollama concurrency 達上限；`503` trainer/Ollama/GPU 不可用。<br>錯誤訊息對使用者說明可行動解法，不回傳本機絕對路徑、argv 或 stack trace。

## 13. Trainer preset 與 allowlist

- MVP preset 僅允許 `sdxl`、`illustrious`，並明確綁定 base checkpoint/profile。<br>allowlist overrides 建議限於 rank、alpha、learning rate、epochs/steps、batch size、resolution、seed。
- 每個數值有 server-side min/max；UI 限制只作輔助，不是安全邊界。<br>optimizer、precision、network module、cache 策略由 preset 決定。
- resolved config 記錄預設值、override、環境版本與最終 argv。<br>執行 child process 時使用 argv array 且 `shell: false`，禁止字串拼接 shell command。

## 14. Health 與 Preflight

- `GET /api/lora-training/health` 檢查功能可用性但不觸發下載或安裝。<br>檢查 pinned sd-scripts commit、`$LORA_TRAINING_ROOT/runtime/.venv` Python、必要 package 與 entrypoint。
- 檢查 Ollama endpoint、Gemma4 model 可用性與最小 JSON caption probe。<br>檢查 base checkpoint/profile、ComfyUI LoRA 安裝目錄與可寫入性。
- 檢查 dataset 圖片數、解析度、格式、caption 完整性與可用磁碟空間。<br>檢查 GPU/CUDA、VRAM 估計、現存 lease 與可能的外部 GPU 使用。
- preflight 回傳 `pass | warning | fail`；只有 fail 阻止 enqueue。<br>warning 必須由 UI 顯示並保留在 resolved config，不使用隱藏式忽略。

## 15. FIFO、GPU mutex 與程序生命週期

- scheduler 採 durable FIFO，排序鍵為 `queuedAt`，相同時間以 job ID 穩定排序。<br>使用單一 process-level coordinator 加 filesystem lease，避免多 server process 同時訓練。
- lease 包含 job ID、owner instance ID、PID、acquiredAt、heartbeatAt 與 lease generation。<br>取得 lease 必須是原子 create/compare-and-swap；不可僅依記憶體 boolean。
- scheduler 先 durable 寫入 `training` 與 PID，再啟動 trainer，降低 orphan window。<br>progress parser 將 trainer stdout/stderr 轉成有界 events，原始 log 仍寫 job logs。
- state update 節流並原子持久化，避免每個 step 寫磁碟。<br>cancel 先將狀態改為 `cancelling`，送 graceful termination，逾時後才依平台安全終止子程序。
- cancel 完成保留 partial output 與 logs，但不安裝、不登錄 registry。

## 16. Recovery

- server 啟動時掃描 scheduler snapshot 與非終止 job state。<br>`queued` job 重新依原 queuedAt 入列，不自動改變順序。
- `training/installing/cancelling` 若 PID 與 process identity 無法確認，標記 `interrupted`。<br>不自動將 interrupted job 視為 completed，即使 output 目錄中存在 safetensors。
- 可由使用者 retry；retry 新建 job 並保存 `retryOf` provenance。<br>若確認同一 trainer process 尚存活，恢復 heartbeat/progress 監看但不重複啟動。
- stale lease 只有在 owner/PID/heartbeat 三項判定安全後才可回收。

## 17. 原子 persistence 與 artifact install

- JSON 更新採同目錄 temp file → flush/fsync → atomic rename；Windows rename failure 不得刪舊檔重試。<br>registry 更新使用 process mutex + filesystem lock + revision check。
- 訓練結果先留在 job `output/staging`，完成後驗證 safetensors header、大小與可讀性。<br>計算 SHA-256、產生 metadata，再複製到 `trained/.<id>.<nonce>.tmp`。
- 對 temp artifact flush/fsync 後，以不覆寫既有檔案的原子 rename 安裝正式檔名。<br>artifact 安裝成功後才原子更新 registry；registry 成功後 job 才標記 completed。
- 若檔案已安裝但 registry 寫入失敗，job 留在 installing，recovery 以 hash 進行冪等補登錄。<br>若 registry 已有相同 ID 但 hash 不同，視為衝突，禁止覆寫。

## 18. 安全限制

- 驗證 MIME、magic bytes、解碼能力、像素上限、檔案大小、批次總量與圖片數量。<br>重新命名匯入圖片，拒絕 `..`、絕對路徑、ADS、symlink、junction 與保留裝置名稱。
- server 解析後的所有路徑必須位於 job root 或固定 trained root 內。<br>上傳暫存檔不得跨 filesystem 依賴 rename；需在受控 root 內建立。
- caption 與 trigger words 設長度、字元與陣列數量限制。<br>不將圖片內容、caption、log 或絕對路徑送往 Ollama 以外的外部服務。
- log 移除環境變數、token、完整 base64、使用者路徑與可能的敏感 metadata。<br>artifact download 只能接受 job ID/registry ID，不接受 path query。

## 19. `/api/loras` discovery 合併策略

- 保留現有 bridge filesystem discovery，整合 LoraLoader 與 LoraLoaderModelOnly 可見結果。<br>先收集兩類 node 的可選檔案，正規化相對路徑，再以 canonical key 去重。
- 以 registry 的 `relativePath` 或 hash 補充 trained metadata。<br>未登錄的既有 LoRA 仍回傳 legacy-compatible item，`provenance` 可為 null。
- `family` 未知的 legacy item 標示 `unknown`，僅在 consumer 明確允許時顯示。<br>query `family` 必須由 server 執行，不只靠 UI filter。
- 回應增加 `schemaVersion` 與 `capabilities`，舊 flat list contract 維持相容期。

## 20. Consumer mapping

| Consumer | family filter | 預期行為 |
| --- | --- | --- |
| SDXL img2img / image generation | `sdxl` | 顯示 SDXL 與相容 legacy；以 baseProfile 再縮小 |
| Illustrious image flow | `illustrious` | 僅顯示 Illustrious 或明確相容項目 |
| LoraLoader | workflow family | 使用統一 structured item 的 relativePath |
| LoraLoaderModelOnly | workflow family | 與 LoraLoader 合併 discovery，不重複顯示 |
| Wan animation | `wan` | MVP 僅能選既有 Wan LoRA，不提供訓練 |
| Jobs retry / rerun | 原 job family | 保存 registry ID、hash、baseProfile 與 provenance |

- consumer 保存 registry ID 與 hash；執行時再解析 current path，避免只保存易變檔名。<br>舊 job 若只有檔名仍可執行；新 job 必須額外保存結構化 LoRA provenance。

## 21. UI 資訊架構

- Tools 頁新增「LoRA Trainer」卡片，說明本機訓練、GPU 排隊與目前支援 family。<br>路由固定為 `/app/tools/lora-trainer`。
- 支援 query deep link：`?step=captions&job=<uuid>`。<br>支援 run deep link：從既有 job/provenance 導回 `?job=<uuid>&step=progress` 或 artifact。
- deep link 必須以 server state 校正；五階段是狀態/修復/深連結模型，auto 模式可跳過等待確認但不可跳過 server validation。<br>每個可見階段只提供一個視覺主 CTA，其他操作使用次要或文字按鈕。

## 22. 五階段 UI

### Stage 1 — Dataset

- 使用 AssetPicker 多選既有圖片，另提供 native file input 上傳；顯示縮圖、尺寸、驗證狀態與移除操作。<br>同頁提供必要簡化設定：family、base preset/profile、output name、trigger words；rank/alpha/learning rate 等放入收合的 advanced `<details>`。
- `captionReviewMode` 預設 auto，可切換 manual；主 CTA 為「開始訓練」。按下後顯示 captioning/preflight/queue 狀態，輸入未達最低條件時 disabled 並顯示原因。

### Stage 2 — Captions

- 使用分頁清單而非一次渲染全部圖片；每張顯示圖片、caption textarea、狀態、retry 與修改痕跡。<br>manual 模式正常停留供 review；auto 僅在 caption/schema 錯誤時進入此修復頁，成功時不要求額外確認。
- 失敗項目可單獨 retry；manual 主 CTA 為「確認 captions」，auto 修復後主 CTA 為「繼續訓練」。兩者都必須重新 schema validation，不能略過錯誤項目。

### Stage 3 — Config / Preflight

- 顯示 Dataset 已提交的簡化設定、resolved config 與 health/preflight checks；進階欄位仍置於 native `<details>`。<br>manual flow 或 preflight 錯誤才需停留；主 CTA 為「加入訓練佇列／修正後繼續」，只有 pass/warning 可用。

### Stage 4 — Progress

- 顯示 queue position、狀態、step/total、epoch、loss、ETA 與事件摘要。<br>cancel 是明確危險次要操作，需確認但不使用阻塞式 browser alert。
- 進度動態文字使用節流 `aria-live="polite"`。<br>主 CTA 依狀態為「查看產物」或失敗時「建立重試」。

### Stage 5 — Artifact

- 顯示 registry ID、family、base profile、trigger words、hash、大小與 provenance。<br>顯示已安裝至 ComfyUI trained 目錄的成功狀態，但不暴露絕對路徑。
- 主 CTA：「在生成工具中使用」；download 為次要操作。

## 23. 視覺、可及性與 responsive

- 由 ui-ux-pro-max 決定流程密度與資訊階層，由 ui-styling 落實既有元件語言。<br>沿用現有 dark/lime tokens、CSS 與 native controls，不另建平行 theme。
- 所有 input 有永久 label；placeholder 不可取代 label。<br>validation error 與 field 以 `aria-describedby` 關聯，焦點移至第一個錯誤摘要。
- 互動目標至少 44×44px，支援完整鍵盤操作與清楚 focus-visible。<br>尊重 `prefers-reduced-motion`；進度不可只靠動畫或顏色表意。
- 桌面版提供 sticky job summary；窄螢幕改為流程上方可折疊摘要。<br>375px：單欄、CTA 全寬、caption controls 換行，不橫向捲動。
- 768px：單欄主流程加雙欄部分 metadata。<br>1024px：主內容 + sticky summary 雙欄。
- 1440px：限制閱讀寬度，避免 caption textarea 過寬。

## 24. Milestones 與依賴順序

1. M0：本規劃文件單獨 commit，確認 scope、schema 與 ownership。
2. M1：job storage/schema、atomic JSON、folder lifecycle、API validation。
3. M2：dataset import/upload、caption adapter、caption review APIs。
4. M3：pinned trainer bootstrap、preset、preflight、FIFO/GPU lease、cancel/recovery。
5. M4：artifact validation/install、registry、structured `/api/loras`。
6. M5：Tools card、五階段 UI、deep links、responsive/accessibility。
7. M6：所有 consumer family filtering 與 jobs/retry provenance。
8. M7：集中 happy-path 驗證、owner 修正、rollout 文件與 restart 驗證。

- M1 是 M2/M3 的共同前置；M2 與 trainer adapter 可在 interface 固定後平行。<br>M4 依賴 M3 的穩定 output contract；M5 可用 fixtures 平行，但不得自行改 server contract。
- M6 依賴 registry 與 `/api/loras` contract 完成。

## 25. 平行 ownership

- Owner A — job domain：`LORA_TRAINING_ROOT` schema、atomic store、API validation、recovery state machine。<br>Owner B — trainer runtime：`server/lora-training`、root runtime、sd-scripts pin、presets、preflight、process parser。
- Owner C — caption/dataset：upload/import、manifest、Ollama Gemma4 adapter、caption CRUD。<br>Owner D — artifact/registry：safetensors validation、atomic install、registry 與 download API。
- Owner E — WebUI：Tools card、route、五階段頁面、query/run deep links、a11y/responsive。<br>Owner F — consumers：bridge discovery 合併、structured `/api/loras`、family filter、provenance 保存。
- 每位 owner 僅修改分配模組；共同 type/schema 由 Owner A 先落地並通知版本。<br>子代理不跑 test/build；只做局部靜態自檢並回報主代理，避免重複耗時與互相污染輸出。

## 26. Dirty overlap 協議

- 開始前主代理記錄 dirty worktree 與檔案 ownership，不清理、不 reset 使用者變更。<br>owner 發現目標檔已有未歸屬變更時先停止該檔，回報 overlap 與所需協調。
- 不以整檔覆寫方式套用變更；採最小 patch 並保留其他代理/使用者 edits。<br>shared schema/API contract 變更由單一 owner 修改，其他 owner 透過 import 使用。
- 合流衝突由主代理指定 owner 解決，不讓多個 owner 同時修同一檔。

## 27. 集中最小 Happy Paths

- 預設集中路徑使用 allowlisted fake trainer fixture：建立 job/圖片後驗證 auto caption → schema validation → preflight → FIFO lease → progress → fixture safetensors header/hash → atomic install → registry → consumer discovery。<br>另驗 manual caption edit/retry/confirm，以及 auto caption/preflight error 停在可修復頁且未 enqueue。
- fixture 只能由測試/驗證設定 allowlist 啟用，production request 不得選任意 executable。<br>可選 1-step real sd-scripts smoke 僅在 runtime/CUDA ready 時由人員手動執行；不跑完整耗時訓練，也不作每次 build gate。
- Recovery：模擬 restart，驗證 queued 恢復與 stale training 轉 interrupted。<br>Retry：從 failed/interrupted 建立新 job，確認 retryOf、來源 assets、設定與 LoRA provenance。
- Consumer：至少一個 LoraLoader 與一個 LoraLoaderModelOnly path 能找到新 LoRA 且不重複。<br>靜態品質：只跑相關 ESLint、TypeScript `tsc` 與 production build。
- Browser desktop：1024 或 1440 實走五階段、keyboard/focus、deep link、錯誤呈現。<br>Browser mobile：375 實走 dataset/caption pagination/config/progress/artifact，確認無水平溢出。
- 若 Python/Node 需個別命令，只選能證明跨邊界 contract 的最小集合。<br>不新增低價值 snapshot、純 getter、框架預設或重複 schema 測試。
- 統一驗證完成後，失敗依 domain 指派原 owner；修復後只重跑受影響路徑與最終全 happy path。

## 28. Acceptance Criteria

- Tools 頁可進入 `/app/tools/lora-trainer`，deep link 可恢復正確 job/step。<br>Dataset 同頁具簡化設定、advanced 收合與「開始訓練」；auto 為預設並可切 manual。
- auto 可從圖片一路完成 caption validation、preflight 與 FIFO enqueue，無需人工確認；manual 才停在 review/confirm。<br>caption 或 preflight 錯誤必停在可修復頁且不得把錯誤資料送入 trainer。
- 同時只存在一個有效 GPU training lease；第二個 job 顯示 queue position。<br>progress、cancel、server restart recovery 均有 durable、可解釋狀態。
- 成功 artifact 經驗證/hash 後原子安裝，registry 與 job 最終狀態一致。<br>`/api/loras` 向後相容，所有 consumer 可依 family/baseProfile 過濾新 LoRA。
- LoraLoader 與 LoraLoaderModelOnly discovery 合併後不重複、既有未登錄 LoRA 不消失。<br>artifact metadata/download 使用專用 API；一般 job response 不載入大檔。
- retry 與 downstream jobs 保存 registry ID、hash、family、baseProfile、provenance。<br>375/768/1024/1440 版面可用，44px targets、keyboard、focus、labels、errors、aria-live 與 reduced motion 達標。
- allowlisted fake trainer 的集中跨層 happy path、相關 ESLint/tsc/build 與 desktop/375 browser flow 全數通過；1-step real smoke 是 runtime ready 時的可選手動證據，不是 build gate。

## 29. Rollout 與 Restart

- 以 feature flag `loraTrainer` 控制 Tools 卡片與路由入口，API 仍需 server-side authorization/validation。<br>首次 rollout 僅啟用 SDXL/Illustrious presets；phase 2 family 不出現在訓練選單。
- 部署前先完成 trainer bootstrap 與 health check，失敗時 UI 顯示 unavailable 而非隱藏錯誤。<br>更新 server 前等待 active training 完成或由使用者取消；不可直接中斷進程。
- restart 後執行 recovery，檢查 queued、interrupted、lease 與 installing reconciliation。<br>需要 ComfyUI 掃描新 LoRA 時，優先呼叫既有 refresh；只有確有必要才要求 restart ComfyUI。
- registry schema migration 必須可讀舊版並先備份；不在啟動時刪除未知 entry。<br>rollback 關閉 feature flag，不刪 job、registry 或已安裝 safetensors。

## 30. 主要風險與緩解

- CUDA/PyTorch/sd-scripts 相容性：固定 commit 與 lock，preflight 顯示精確版本差異。<br>Windows process termination/recovery：保存 PID 與 identity，採 graceful-first 且不誤殺重用 PID。
- 大型圖片與磁碟耗盡：像素/大小/數量限制、匯入前空間估算、staging cleanup policy。<br>Ollama 非結構化輸出：`format=json` 加 schema validation，保留可 retry 錯誤而不猜測內容。
- registry/filesystem 不一致：兩階段原子 install、hash reconciliation 與冪等 recovery。<br>family 誤配導致生成錯誤：registry 明確 family/baseProfile，server 與 consumer 雙層過濾。
- 多代理 dirty overlap：單檔 ownership、共享 contract 單 owner、集中驗證與定向修正。<br>進度 log 過量：原始 log 有界保存，state/event 節流，UI aria-live 再節流。

## 31. Phase 2

- SD1.5 preset、checkpoint/profile mapping 與較低 resolution 設定。<br>Z-Image 訓練 adapter、專用 family compatibility 與 consumer mapping。
- Wan LoRA 訓練；需另行釐清 video dataset、frame sampling、caption 與 workflow loader contract。<br>可評估 resume-from-checkpoint，但必須新增 immutable config/dataset hash 約束。
- 可評估多 GPU 或外部 worker；不得直接放寬 MVP 的單 GPU mutex。<br>可評估 dataset augmentation、auto-tagging、caption templates 與 artifact comparison。

## 32. Decision Log

- D1：MVP family 為 SDXL/Illustrious；SD1.5/Z-Image/Wan 延後，降低 trainer/runtime 變體風險。<br>D2：採 pinned sd-scripts + `$LORA_TRAINING_ROOT/runtime/.venv`，所有可變資料統一在單一 root。
- D3：所有 job 資料置於 `$LORA_TRAINING_ROOT/jobs/<uuid>`，以 job root 作安全與 recovery 邊界。<br>D4：`captionReviewMode` 預設 auto，一鍵通過 caption schema validation 與 preflight 後自動 enqueue；manual 才強制人工確認。
- D5：FIFO + 單 GPU durable lease，先追求可預測與可恢復，不做並行訓練。<br>D6：artifact 先驗證/hash，再原子安裝，registry 成功後才完成 job。
- D7：registry 與 filesystem discovery 合併，不破壞既有手動安裝 LoRA。<br>D8：`/api/loras` 採 structured backward-compatible response，family filter 由 server 落實。
- D9：artifact 使用專用 metadata/download API，避免 jobs API 膨脹與 path 暴露。<br>D10：文件先獨立 commit；平行實作不自行 test/build，最後集中 happy-path 驗證。
- D11：UI 沿用 dark/lime tokens、CSS/native controls，不為單一工具引入新設計系統。<br>D12：retry 建立新 job，不覆寫歷史，以完整保存 provenance 與稽核軌跡。
- D13：集中驗證預設使用 allowlisted fake trainer 走完整跨層 contract；real sd-scripts 僅提供可選 1-step smoke，不作常態 gate。

## 33. 實作前 Checklist

- [ ] 本文件已單獨 commit，working tree 與後續實作變更可清楚區分。<br>- [ ] 確認 shared job/registry/API schema owner 與版本策略。
- [ ] 確認 `LORA_TRAINING_ROOT` 設定、預設 root、runtime/cache/jobs/registry 邊界與唯一外部成品副本。<br>- [ ] 確認 sd-scripts commit、PyTorch/CUDA 矩陣、bootstrap 與 SDXL/Illustrious allowlist。
- [ ] 確認 Ollama Gemma4 model 名稱、JSON response schema 與 timeout/concurrency。<br>- [ ] 確認圖片 size/pixel/count、caption 長度、磁碟空間等 server limits。
- [ ] 確認 GPU lease、PID identity、heartbeat 與 Windows termination 策略。<br>- [ ] 確認 ComfyUI trained root、refresh 行為與檔名規則。
- [ ] 確認 `/api/loras` legacy response contract 與所有 consumer 清單。<br>- [ ] 確認 feature flag、restart/recovery、rollback 與資料保留政策。
- [ ] 記錄 dirty worktree 與 ownership，避免重疊修改。
- [ ] 排定 fake trainer 集中 happy-path 執行者、可選 real 1-step smoke 條件與失敗後 owner routing。

## 34. 完成 Checklist

- [ ] Dataset、Captions、Config/Preflight、Progress、Artifact 五階段完成。
- [ ] 多選/上傳、Dataset 簡化設定與一鍵 auto flow 正常；manual edit/retry/confirm 與 error repair 正常。
- [ ] FIFO、single GPU lease、cancel、recovery、retry 通過最小驗證。
- [ ] safetensors validation/hash/atomic install 與 registry reconciliation 正常。
- [ ] 所有 LoRA consumer 支援 family filter，legacy discovery 未回歸。
- [ ] jobs 與 retry 保存完整 LoRA provenance。
- [ ] 專用 artifact metadata/download API 通過安全檢查。
- [ ] 桌面與 375px browser happy path、keyboard/focus/a11y 通過。
- [ ] allowlisted fake trainer 跨層 path 與相關 ESLint/tsc/build 通過；未把完整訓練或 real smoke 設為常態 gate。
- [ ] rollout/restart/recovery/rollback 操作已記錄並可重現。
