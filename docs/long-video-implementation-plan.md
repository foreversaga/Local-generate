# 長影片分段續拍功能實作計畫

## 1. 目標

在 H3 Studio 新增「長影片」模式。使用者完成設定後，可以從下列任一來源建立長影片：

- 純文字分鏡腳本。
- 一張首幀、角色或場景參考圖片。
- 一支要繼續延長或作為視覺參考的影片。

系統將分鏡按時間拆成短片段，透過 Ollama 產生符合 MiniMax H3 格式的提示詞，依序生成影片，將每段尾幀作為下一段 I2VA 的首幀，最後標準化並合併所有片段。

第一版完成標準：使用者不必手動擷取尾幀、重新上傳圖片或執行 FFmpeg；頁面關閉或 Web 服務重啟後，工作仍可從已完成階段恢復。

## 2. 範圍與非目標

### 2.1 第一版範圍

- 解析帶時間碼或每段秒數的文字分鏡。
- 建立全片 continuity bible 與分段計畫。
- 支援文字、圖片、影片三種起點。
- 產生可編輯的各段 H3 提示詞草稿。
- 逐段生成、標準化、擷取尾幀及續拍。
- Job、Segment、Attempt 持久化。
- 頁面可設定 `ComfyUI/output` 下的專屬資料夾名稱。
- 暫停、恢復、取消及從失敗段落重試。
- 合併影片並使用 ffprobe 驗證。

### 2.2 第一版非目標

- 不同 GPU 或不同主機間的分散式生成。
- 同一個長影片的多段平行生成；後續段落依賴前段尾幀，必須循序執行。
- 自動保證跨多段的角色身分完全不漂移。
- 自動刪除 Job 所屬的全部輸出。
- 未經使用者允許自動下載模型或執行正式影片 smoke test。

## 3. 三種輸入模式

### 3.1 純文字

```text
文字分鏡
→ Segment 1：T2VA
→ 擷取 Segment 1 尾幀
→ Segment 2..N：I2VA
→ 合併所有生成片段
```

第一段的最終提示詞使用 T2VA 三欄格式：

```text
integrated_multimodal_description
overall_soundscape
non_diegetic_music
```

### 3.2 圖片

圖片用途由使用者選擇：

- `first_frame`：圖片就是長片第 0.00 秒的實際首幀。
- `visual_reference`：圖片只提供角色、場景或風格參考。

`first_frame` 第一版必須支援，流程為：

```text
首幀圖片＋文字分鏡
→ Segment 1：I2VA
→ 擷取 Segment 1 尾幀
→ Segment 2..N：I2VA
→ 合併所有生成片段
```

`visual_reference` 可使用 Ref2VA 生成第一段；若本機沒有 Ref2VA diffusion model，頁面應清楚標示不可用，不能靜默改用其他模式。後續段落仍以前段尾幀執行 I2VA，並將參考圖片解析出的穩定視覺屬性保存在 continuity bible。

### 3.3 影片

影片必須讓使用者選擇用途，避免「延長影片」與「參考影片風格」語意混淆：

- `continue_source`：原影片是成片前段，系統從其尾幀開始續拍，最後把原片放在最前面一起合併。
- `visual_reference`：影片只提供人物、場景、動作、運鏡、剪輯節奏或風格參考，不直接放入最終影片。

`continue_source` 流程：

```text
來源影片
→ 媒體檢查與標準化
→ 擷取來源影片尾幀
→ Segment 1..N：I2VA
→ 合併「標準化來源影片＋所有生成片段」
```

`visual_reference` 流程：

```text
參考影片＋文字分鏡
→ Segment 1：Ref2VA
→ 擷取 Segment 1 尾幀
→ Segment 2..N：I2VA＋continuity bible
→ 合併生成片段，不包含參考影片本身
```

Ref2VA 提示詞必須依序包含：

```text
subject_definitions
summary
retention_analysis
detailed_description
overall_soundscape
non_diegetic_music
```

## 4. 使用者流程

### 4.1 建立工作

頁面新增「長影片」模式，設定區包含：

1. 工作標題。
2. 輸入類型：文字、圖片或影片。
3. 圖片／影片用途。
4. 整體提示詞／故事描述（輸入給 Ollama）。
5. 負面提示詞／限制；空白時由 Ollama 產生基準值。
6. 分鏡時間模式：`auto` 由 Ollama 產生，或 `manual` 由作者鎖定。
7. 自動模式的目標總長與目標單段長度，或手動模式的時間軸腳本。
8. output 資料夾名稱與提示詞模型。
9. H3 模型 profile、解析度、步數、FPS 與 seed 策略。
10. 接縫策略。

創作設定與執行設定必須分離：Ollama 可產生 continuity bible、分鏡切點、逐段 H3 內容、聲音、音樂及負面提示詞；H3 profile、解析度、Steps、Seed、FPS 與接縫由使用者或伺服器控制，模型不得自行覆寫本機運算參數。

### 4.2 規劃

使用者按下「用 Ollama 產生分鏡時間與 H3 提示詞」後：

1. 驗證故事描述、Ollama 狀態與所選模型。
2. `manual` 模式先以確定性解析器驗證作者時間碼；`auto` 模式把總長與單段長度提示送給 Ollama。
3. Ollama 一次產生全片負面提示詞、continuity bible、分鏡時間及逐段 H3 結構化內容。
4. 後端驗證 JSON、全片時間算術與每段長度；時間有 gap、overlap 或總長不符時整次規劃失敗，不靜默修補。
5. 後端把模型內容包裝為正確的 T2VA／I2VA 欄位順序並再次驗證。
6. 頁面顯示模型、產出時間、時間來源、段數、全片秒數、continuity bible、分鏡時間、逐段描述、段尾狀態、提示詞及分段負面提示詞。
7. 使用者可修改輸出；若修改規劃輸入，UI 標記舊結果失效並要求重新規劃。

此階段不建立 output 資料夾，也不啟動 ComfyUI 生成。

### 4.3 啟動

使用者按下「開始全部生成」後：

1. 驗證所有必要設定。
2. 驗證 output 資料夾名稱。
3. 以排他方式建立 `ComfyUI/output/<folderName>`。
4. 寫入 `.h3-sequence.json` 所有權標記。
5. 保存 Job 狀態。
6. 準備第一段的最終提示詞。
7. 提交第一個生成工作。

資料夾已存在時回傳 `OUTPUT_FOLDER_EXISTS`，不覆寫、不混用，也不自動開始生成。

## 5. 分鏡時間模式與輸入格式

### 5.1 Ollama 自動分鏡

預設模式只要求整體故事描述、目標總長與目標單段長度。Ollama 必須產生至少兩段全域時間範圍，並依情節與動作選擇切點。模型負責提出時間，伺服器負責算術驗證；驗證失敗時回傳 `OLLAMA_TIMELINE_INVALID`，不得退回固定兩段或用假資料填入 UI。

### 5.2 手動鎖定時間

手動模式的作者時間是權威資料。Ollama 只能補充語意與提示詞，伺服器忽略模型嘗試變更的 `start`／`end`。支援下列兩種文字格式。

#### 起訖時間

```text
[00:00.000 - 00:05.000]
紅衣女子在雨夜街道奔跑。

[00:05.000 - 00:10.000]
女子跳過積水並繼續向前。
```

#### 每段秒數

```text
5秒：紅衣女子在雨夜街道奔跑。
5秒：女子跳過積水並繼續向前。
```

無論時間來自 Ollama 或作者，後端都必須驗證：

- 段落編號連續。
- 起訖時間嚴格遞增。
- 不重疊。
- 未明示的空白時間不被自行填補。
- `end - start = duration`。
- 每段時間落在生成器允許範圍。
- 全片秒數等於最後一段結束時間。

## 6. 提示詞產生策略

提示詞分成「規劃草稿」與「執行時最終版本」。

### 6.1 規劃草稿

規劃時一次產生全部草稿，讓使用者在影片模型運算前檢查故事、動作與鏡頭安排。Ollama JSON 契約如下；`start`／`end` 是全片時間，而 `integratedMultimodalDescription` 內的 Shot 時間以該 Segment 的 0 秒重新起算。

```json
{
  "negativePrompt": "...",
  "continuityBible": {
    "visualStyle": "...",
    "characters": [],
    "environment": "...",
    "lighting": "...",
    "camera": "...",
    "motionDirection": "...",
    "keyObjects": [],
    "sound": "...",
    "nonDiegeticMusic": "...",
    "mustPreserve": [],
    "mustAvoid": []
  },
  "segments": [
    {
      "start": 0,
      "end": 5,
      "description": "...",
      "integratedMultimodalDescription": "[Shot 1] ...",
      "overallSoundscape": "...",
      "nonDiegeticMusic": "...",
      "continuityNote": "...",
      "endingState": "...",
      "negativePrompt": ""
    }
  ]
}
```

第一個純文字 Segment 組成 T2VA；圖片首幀或第二段以後組成 I2VA。若模型直接回傳的完整 prompt 不符合 H3 欄位順序，伺服器使用同一份模型結構化內容重新包裝，不使用與故事無關的預設 prompt。

### 6.2 執行時最終版本

後續段落不能只使用預先產生的草稿。每當前一段完成後，將下列內容送給 Ollama：

- 實際尾幀圖片。
- 當前 Segment 分鏡。
- 全片 continuity bible。
- 前一段 `endingState`。
- 前一段最終提示詞摘要。
- 當前段落秒數。
- 全片負面約束。

模型根據實際尾幀完成 I2VA 提示詞，並固定使用：

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: ...

overall_soundscape: ...

non_diegetic_music: ...
```

提示詞驗證器需要檢查欄位名稱、順序、參考標籤、時間碼、對話格式與影片長度。驗證失敗時可要求 Ollama 修正一次；再次失敗則停止在 `prompt_failed`，允許使用者手動編輯。

## 7. Continuity Bible

每個父 Job 必須保存：

```ts
type ContinuityBible = {
  visualStyle: string;
  characters: Array<{
    id: string;
    appearance: string;
    clothing: string;
    voice?: string;
  }>;
  environment: string;
  lighting: string;
  camera: string;
  motionDirection: string;
  keyObjects: string[];
  sound: string;
  nonDiegeticMusic: string;
  mustPreserve: string[];
  mustAvoid: string[];
};
```

圖片或影片輸入時，由具備視覺能力的提示詞模型分析可見屬性；無視覺模型時，要求使用者補充文字描述，不得假裝已檢視媒體內容。

## 8. 持久化與資料夾

工作狀態保存在專案：

```text
data/jobs/<job-id>/
├─ job.json
├─ events.jsonl
├─ segments/
│  └─ 001/
│     ├─ segment.json
│     └─ attempts/001.json
└─ assembly/
   ├─ concat.txt
   └─ assembly.json
```

媒體輸出保存在：

```text
C:\Users\forev\ComfyUI\output\<使用者設定名稱>\
├─ segment-001-attempt-001-raw.mp4
├─ segment-001-attempt-001.mp4
├─ segment-001-attempt-001-tail.png
├─ segment-002-attempt-001-raw.mp4
├─ segment-002-attempt-001.mp4
├─ segment-002-attempt-001-tail.png
├─ final-r001.mp4
└─ .h3-sequence.json
```

JSON 保存相對資產引用，不保存絕對路徑、動態 URL、Base64 媒體或 token。

`job.json`、`segment.json`、Attempt 與 `assembly.json` 的欄位定義依照本功能的 Job 資料規格實作。所有 JSON 先寫同資料夾的暫存檔，再原子取代正式檔案；每次更新增加 `revision`。

## 9. 建議程式模組

避免繼續把所有功能加入 `local-bridge.mjs`，新增：

```text
server/long-video/
├─ schema.mjs
├─ paths.mjs
├─ store.mjs
├─ timeline-parser.mjs
├─ planner.mjs
├─ prompt-builder.mjs
├─ prompt-validator.mjs
├─ runner.mjs
├─ media.mjs
├─ assembler.mjs
└─ recovery.mjs
```

職責：

- `schema.mjs`：狀態、欄位及資料驗證。
- `paths.mjs`：Job ID、output 資料夾名稱與安全路徑。
- `store.mjs`：原子 JSON 寫入、讀取、列出工作及 revision。
- `timeline-parser.mjs`：確定性解析秒數與時間碼。
- `planner.mjs`：呼叫 Ollama 產生 continuity bible 與分段語意。
- `prompt-builder.mjs`：依 T2VA、I2VA、Ref2VA 組合系統提示。
- `prompt-validator.mjs`：檢查 H3 提示詞結構及時間。
- `runner.mjs`：Sequence 狀態機與現有 generation queue 的協調。
- `media.mjs`：ffprobe、標準化、裁切及擷取尾幀。
- `assembler.mjs`：concat 清單、合併及最終驗證。
- `recovery.mjs`：服務重啟後辨識中斷狀態並恢復。

`local-bridge.mjs` 只保留 HTTP 路由、既有單片工作與上述模組的入口整合。

## 10. API 設計

```text
POST   /api/sequences/plan
POST   /api/sequences
GET    /api/sequences
GET    /api/sequences/:id
PATCH  /api/sequences/:id

POST   /api/sequences/:id/start
POST   /api/sequences/:id/pause
POST   /api/sequences/:id/resume
POST   /api/sequences/:id/cancel

PATCH  /api/sequences/:id/segments/:index
POST   /api/sequences/:id/segments/:index/prompt
POST   /api/sequences/:id/segments/:index/retry

POST   /api/sequences/:id/assemble
```

`start` 回傳 `202 Accepted`，不能等待完整長影片完成才回應。前端沿用目前 Jobs 輪詢方式取得進度。

## 11. 狀態機

父 Job：

```text
draft → planning → ready → running → assembling → completed
                       ↘ paused
                       ↘ failed
                       ↘ cancelled
```

Segment：

```text
pending
→ finalizing_prompt
→ ready
→ queued
→ rendering
→ normalizing
→ extracting_tail
→ completed
```

附加狀態：`stale`、`failed`、`cancelled`。

只有 Segment N 已完成、標準化影片與尾幀均通過驗證後，Segment N+1 才能開始。重新生成 Segment N 時，N+1 之後全部標記為 `stale`。

## 12. 媒體後製

H3 使用 24 FPS 與 `17k+5` 時間格線，請求 5 秒可能生成約 5.167 秒。因此每段完成後必須：

1. 用 ffprobe 讀取影格數、FPS、解析度、codec、pixel format 及音訊格式。
2. 裁切到腳本指定時間。
3. 統一成 24 FPS、H.264、`yuv420p`。
4. 音訊統一為 48 kHz AAC stereo；沒有音訊時補靜音軌。
5. 從標準化完成的段落擷取尾幀。

尾幀不能從未裁切的 raw output 擷取，否則續拍狀態會晚於腳本接點。

第一版接縫策略固定提供：

- `keep_duplicate_frame`：保留重複首尾幀，最穩定且不需要重算時間。
- `drop_next_first_frame`：移除後段第一幀，可能使總長少 1/24 秒。

預設使用 `keep_duplicate_frame`。

## 13. Output 資料夾安全

資料夾名稱：

- 長度 1–80 字元。
- 支援中文、英文、數字、空格、`-`、`_`。
- 禁止 `<>:\"/\\|?*`、控制字元、`.`、`..`、尾端空格／句點及 Windows 保留名稱。
- 只允許 `output` 下的一層目錄。

建立時使用安全路徑驗證與排他建立；已存在就回傳 `OUTPUT_FOLDER_EXISTS`。不得覆寫既有資料夾，也不得自動建立未顯示於頁面的不同名稱。

目前資產掃描已支援遞迴子資料夾。既有單片模式維持輸出至根目錄；長影片新增獨立的 `allocateSequenceOutputPath()`，不要改變現有 `allocateOutputPath()` 行為。

## 14. 失敗與恢復

- Ollama 離線：Job 留在 `ready` 或 `prompt_failed`，允許人工輸入提示詞。
- ComfyUI 離線：不提交生成，狀態顯示可恢復的環境錯誤。
- 生成失敗：保留 Attempt，停止後續 Segment。
- 標準化失敗：保留 raw video，只重試後製。
- 尾幀失敗：保留 normalized video，只重試尾幀擷取。
- 合併失敗：不重新生成任何 Segment，只重試 assembly。
- Web 重啟：將找不到活動 process 的執行中狀態改為 `interrupted`，檢查輸出是否完整後決定恢復點。
- 暫停：讓目前已提交的 Segment 完成，再停止提交下一段。
- 取消：只取消該 Sequence 的目前工作，不影響其他單片生成工作。

## 15. 實作階段

### Phase 1：資料模型與安全路徑

- 建立 `server/long-video/schema.mjs`、`paths.mjs`、`store.mjs`。
- 實作 Job、Segment、Attempt、AssetRef、Error 與 Assembly schema。
- 實作 output 資料夾名稱驗證與排他建立。
- 更新 `.gitignore`，忽略執行時 Job 資料但保留說明文件。

完成條件：可建立、讀取、更新及列出 Job；重新啟動後資料仍存在。

### Phase 2：分鏡解析與提示詞規劃

- 實作時間碼解析器。
- 新增 `/api/sequences/plan`。
- 產生並驗證 continuity bible、Segments 及提示詞草稿。
- 實作 T2VA、I2VA、Ref2VA 提示詞驗證器。

完成條件：文字、圖片、影片三種輸入都能產出可編輯且時間有效的分段計畫，不啟動模型生成。

### Phase 3：長影片頁面

- 新增長影片模式與來源用途選擇。
- 新增 output 資料夾名稱欄位。
- 新增時間軸 Segment 編輯卡。
- 顯示 continuity bible、提示詞草稿與驗證錯誤。

完成條件：使用者能完成規劃、修改並保存工作。

### Phase 4：Sequence Runner

- 實作 `runner.mjs`。
- 串接現有 `/api/generate` 與 generation queue。
- 保存 `sequenceId`、`segmentId`、`attempt` 關聯。
- 支援 T2VA／I2VA 第一段與後續 I2VA。

完成條件：可以按順序生成至少兩段，不會同時啟動相依片段。

### Phase 5：尾幀與影片來源續拍

- 實作 ffprobe、標準化、裁切、尾幀擷取。
- 將尾幀保存至使用者指定 output 資料夾。
- 根據實際尾幀定稿下一段 I2VA 提示詞。
- 支援 `continue_source`，把來源影片當作 Segment 0。

完成條件：文字、首圖、來源影片三種起點都能自動完成兩段以上續拍。

### Phase 6：合併與驗證

- 產生 `concat.txt`。
- 合併標準化片段。
- 產出 `final-rNNN.mp4`。
- 保存 assembly revision 與 ffprobe 結果。

完成條件：最終影片可解碼，寬高、FPS、音訊格式與總時長落在允許誤差內。

### Phase 7：恢復與重試

- 實作 pause、resume、cancel、retry。
- 實作服務啟動恢復。
- 重生上游 Segment 時將下游標記為 `stale`。
- 保留所有 Attempt，不覆寫舊輸出。

完成條件：中斷 Web 後重新啟動，可從最後完整階段繼續。

### Phase 8：視覺參考影片

- 串接 Ref2VA 第一段生成。
- 解析參考影片的角色、場景、動作、鏡頭及節奏資訊。
- 將穩定特徵延續到後續 I2VA prompt。
- 清楚處理 Ref2VA 模型未安裝的狀態。

完成條件：參考影片不放入成片時，仍能指導第一段生成並在後續片段維持核心視覺設定。

## 16. 測試計畫

### 16.1 單元測試

- output 資料夾合法／非法名稱。
- Windows 保留名稱與路徑穿越。
- 時間碼解析、重疊、空白與無效秒數。
- Job 與 Segment 狀態轉移。
- H3 各模式提示詞欄位與順序。
- 下游 `stale` 傳播。
- 原子寫入與 revision 衝突。

### 16.2 整合測試

- 使用假的 Ollama 回應測試 plan API。
- 使用假的 generation child process 測試 runner。
- 使用小型測試影片驗證 ffprobe、裁切、尾幀與 concat。
- 模擬 Web 重啟及中斷恢復。
- 驗證資產名稱包含 output 子資料夾時可列出及讀取。

### 16.3 執行時驗證

先確認既有 `8188`、`8787` 與需要時的 `11434` 服務，不建立第二個實例。只有在使用者允許模型運算與輸出變更後，才執行正式兩段影片 smoke test。

## 17. 驗收條件

以下全部成立才算完成：

1. 純文字可自動生成至少兩段並合併。
2. 首幀圖片可作為第一段 I2VA 首幀並完成後續續拍。
3. 來源影片可被放在成片開頭，從其尾幀繼續生成。
4. 參考影片模式在 Ref2VA 可用時能生成第一段；不可用時提供明確錯誤。
5. 使用者能在頁面設定 output 資料夾名稱，且不覆寫同名資料夾。
6. 每段 prompt、設定、Attempt、輸出與尾幀都有持久化紀錄。
7. 重新整理頁面或重啟 Web 後仍能看到工作並恢復。
8. 重新生成某段會使所有依賴舊尾幀的下游段落失效。
9. 最終 MP4 通過 ffprobe 驗證並出現在資源庫。
10. 現有單片 T2V、I2V、FL2V、L2V、Ref2V 與 Replace 流程不受影響。

## 18. 建議首個可交付版本

先交付下列垂直切片：

```text
文字／首幀圖片
→ 兩段固定各 5 秒
→ Ollama 產生兩段提示詞
→ 第一段生成
→ 自動裁切與抽尾幀
→ 第二段 I2VA
→ 合併
→ 持久化與頁面恢復
```

此版本先驗證最關鍵的 Sequence Runner、尾幀依賴與輸出資料夾。完成後再擴充任意段數、來源影片續拍及 Ref2VA 視覺參考影片，可降低一次修改過多既有流程的風險。
