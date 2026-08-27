# 影片人物雙流程實作文件

這份文件把本功能拆成兩個 repo 的工作。`Local-generate` 負責 WebUI、API、工作記錄與安全清除；`minimax-workflow` 負責實際的 ComfyUI workflow runner。兩邊的實作均已完成。

## 使用者流程

WebUI 路徑：`/app/tools/video-character`

1. 上傳一支原始影片與一至四張參考人物圖片。
2. 選擇模式：
   - **原場景換人物**：保留原影片的背景、鏡頭、時間軸與動作，以人物 mask + reference image 替換角色。
   - **DWPose 動作生成**：從原影片擷取 body/hands/face DWPose，使用參考圖重新生成角色、服裝與場景。
3. 預設 `512x896`、`24 fps`。直式全身素材先用這個解析度驗證；若輸入是橫式，UI 仍允許改為 `896x512`。
   影片／圖片寬高、參考影片最長邊、DWPose、SeedVR2 tile、升頻倍數與 LoRA 訓練解析度等解析度相關參數，均提供可拖曳滑桿；數字欄位仍可精確輸入並與滑桿同步。影片人物頁的寬高預設鎖定等比例，任一滑桿會同步另一邊；取消勾選後才可獨立調整。
4. 工作完成後可按「清除本次中繼檔」。只會刪該工作 workspace，不會刪原素材、最終影片或其他工作。

## 已完成：Local-generate

### API

- `GET /app/api/video-character/health`
- `GET /app/api/video-character/jobs`
- `POST /app/api/video-character/jobs`
- `GET /app/api/video-character/jobs/:id`
- `POST /app/api/video-character/jobs/:id/cancel`
- `POST /app/api/video-character/jobs/:id/clear`

建立工作 payload：

```json
{
  "mode": "replace",
  "source": { "root": "input", "name": "14261.mp4" },
  "references": [{ "root": "input", "name": "reference-01.png" }],
  "prompt": "A person performs the same movement ...",
  "negativePrompt": "blurry, flicker, cropped head, cropped limbs",
  "width": 512,
  "height": 896,
  "fps": 24,
  "steps": 40,
  "seed": 12345,
  "targetPrompt": "person",
  "targetIndex": 0,
  "targetOrder": "left_to_right"
}
```

工作檔案位於 `data/video-character/workspaces/<job-id>/`，包括 `request.json`、來源影片、參考圖、runner.log、memory samples 與 runner 產生的中繼檔。最終影片複製到 `ComfyUI/output/video-character/<job-id>/final.mp4`。

runner 以 JSON Lines 回報進度；每行可使用：

```json
{"event":"progress","stage":"DWPose body/hands","progress":32,"memory":{"rssBytes":123,"vramUsedBytes":456,"vramTotalBytes":789}}
{"event":"output","path":"/absolute/path/to/workspace/final.mp4"}
```

若服務重啟，queued/running 工作會標成 `interrupted`；清除端點拒絕 active 工作，並以安全 workspace 路徑限制刪除範圍。

### 相關檔案

- `server/video-character/controller.mjs`
- `server/routes/bridge-domain-routes.mjs`
- `local-bridge.mjs`
- `app/components/tools/video-character-client.ts`
- `app/components/tools/VideoCharacterWorkspace.tsx`
- `app/components/tools/VideoCharacterWorkspace.module.css`
- `app/(studio)/tools/video-character/page.tsx`
- `app/(studio)/tools/page.tsx`
- `app/lib/webui-routes.mjs`

## 已完成：minimax-workflow

repo：`/home/barry0626/minimax-h3/minimax-workflow`

### `src/video_character.py`

實作一個統一入口：

```text
python src/video_character.py --request <workspace>/request.json
```

已實作：

1. 讀取 `mode`, `sourcePath`, `referencePaths`, `workspace`, `outputPath`, `width`, `height`, `fps`, `steps`, `seed`。
2. `replace` 模式沿用目前 `src/edit_video.py` 的 SCAIL-2 + SAM3.1 自動人物 mask；預設 `max_chunk_frames=81`、`overlap=5`，保留原影片音訊。
3. `dwpose` 模式從 driving video 以 `DWPreprocessor` 分別產生 body/hands 與 face 控制，接 `WanAnimateToVideo`，參考圖使用 CLIP Vision；分段建議 77 幀、重疊 5 幀，完成後依來源影格數 mux 原音訊。
4. 所有輸入、mask、DWPose、chunk、preview、log 與生成片段必須以 `workspace` 為唯一正式存放位置；禁止再寫入固定的 `.scail-cache` 或 `.animate-cache`。ComfyUI 節點必要的傳輸副本只能暫存在全域 input/output 的 `.video-character-staging/<job-id>/`，且成功、失敗、取消、逾時或服務重啟時都必須清除。
5. 逐階段輸出 JSONL `progress`，回報 workspace 驗證、ComfyUI 生成、封裝與 RSS 記憶體取樣；既有 edit/animate log 另記錄 ComfyUI 可取得的 VRAM 峰值。
6. 完成時輸出一行 `{"event":"output","path":"<workspace>/final.mp4"}`，退出碼 0；錯誤以 JSONL 回報並以非 0 退出。
7. 檢查解析度、FPS、來源檔與參考圖；不得接受 workspace 外的 output path。

### 修改既有檔案

- `src/edit_video.py`：抽出或加入 `--workspace`，將 `cache_dir` 指向該目錄；若保留舊 CLI，未指定時才使用既有 `.scail-cache` 相容行為。
- `src/animate_video.py`：同樣加入 `--workspace`，並讓 mask、DWPose 與生成 chunk 都落在 workspace。
- `src/video_masks.py`：確認 `prepare_*_chunks`、`mux_video_chunks` 不會在 workspace 外建立暫存；輸出 24 fps 時以明確的 PyAV stream rate／時間基準處理，避免 15 fps 輸入直接沿用。
- `src/comfyui/workflow.py`：新增 DWPose body/hands + face 的 API graph builder，並用 `/object_info` 驗證節點與輸入名稱。
- `src/domain/models.py`：新增 `VideoCharacterRequest`，固定 `fps=24` 預設與 32 倍數解析度驗證。
- `tests/`：加入 request schema、workspace isolation、JSONL progress、兩種 graph 節點與 24 fps mux 測試。
- `README.md`／`docs/video-replacement.md`：補上 `video_character.py --request` 及 workspace 清理方式。

### 模型與 runtime 驗收

確認 ComfyUI `/object_info` 存在：`DWPreprocessor`, `WanAnimateToVideo`, `WanSCAILToVideo`, `SAM3_Detect`, `SAM3_VideoTrack`, `SCAIL2ColoredMask`, `CreateVideo`, `SaveVideo`；模型使用既有 manifest 的 Wan Animate、SCAIL-2、SAM3.1、DWPose 權重。5090 使用 dynamic VRAM / CPU text-encoder offload，不要在 runner 內強制把全部模型常駐 VRAM。

驗收順序：先用 5–10 秒短片跑兩種模式，再驗證 24 fps、影格數、原音訊、workspace 內容與清除端點；最後才跑完整 14261 影片。

## 環境變數

- `MINIMAX_H3_VIDEO_CHARACTER_DATA_ROOT`：Local-generate 工作資料根目錄。
- `MINIMAX_H3_WORKFLOW_ROOT`：第二 repo 根目錄，預設為目前 repo 的 sibling `../minimax-workflow`。
- `MINIMAX_H3_VIDEO_CHARACTER_RUNNER`：自訂 runner 絕對路徑；未設定時使用 `<workflow-root>/src/video_character.py`。

runner 已加入；WebUI 會檢查檔案與 ComfyUI 可用性後才送出工作。
