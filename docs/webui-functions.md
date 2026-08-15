# MiniMax H3 Studio WebUI 功能說明

本頁依目前 `/app` WebUI 的可操作流程整理。WebUI 與本機 API 共用同一個程序；畫面上的服務狀態、工作進度及輸出連結以實際執行結果為準。

## 1. 開始使用

在瀏覽器開啟 `http://127.0.0.1:8787/app`（遠端裝置使用主機可連線的位址加上 `/app`）。需要的服務如下：

| 服務 | 作用 | 預設位址 |
| --- | --- | --- |
| H3 Studio Web/API | 提供頁面、工作佇列、媒體與本機 bridge API | `8787` |
| ComfyUI | 執行 H3、放大、Image-to-Image 等影像/影片工作流 | `127.0.0.1:8188` |
| Ollama | Prompt Assistant 與長片規劃的文字/視覺提示詞整理 | `127.0.0.1:11434` |

頂端的服務狀態入口會顯示 Bridge、ComfyUI、Ollama（以及可用時的 Codex）狀態；建立工作前先確認相應服務為可用。Settings 的 **MODEL RUNTIME** 可在本機 GPU 與 Vast RTX 5090 間切換，遠端模式須先建立專案既有的 SSH loopback 轉送。進行生成、放大、Image-to-Image 或長片工作時不能切換 runtime。

`/app/create` 是入口頁：可選擇建立單支影片或長片、從媒體庫挑選素材開始，並查看最近工作；Image-to-Image 與 Upscale 位於 Tools。

## 2. 建立單支影片

路徑：`/app/create/single`。表單會先檢查素材、數值與服務狀態，再送出工作；每個 Render count 會建立一筆影片工作，送出後自動前往 Jobs 詳情。

### 模式與輸入

| 模式 | 必要輸入 | 用途 |
| --- | --- | --- |
| T2V | 文字提示詞 | 由文字生成影片 |
| I2V | 一張圖片 | 以圖片作為起始畫面 |
| FL2V | 首幀與尾幀圖片 | 約束影片兩端畫面 |
| L2V | 尾幀圖片 | 由尾幀反推影片 |
| Ref2V | 最多 9 張參考圖片，可再選來源影片 | 以多張參考素材生成 |
| Replace | 來源影片與參考圖片 | Wan Animate 類替換流程；可選角色 LoRA |

素材可從 Library 選取或上傳；目前上傳篩選為 PNG/JPG/WEBP 圖片及 MP4/MOV/WEBM 影片。Ref2V 有 9 張參考圖上限。

### 提示詞與設定

- 可直接輸入 H3 prompt（一般模式最多 7000 字元）及負面提示詞。
- **Prompt Assistant** 可選 Ollama 或 Codex CLI，並設定 Ollama 模型、Codex 模型與 reasoning；提供圖片或影片時會以視覺輸入協助整理。服務不可用時仍可手動編輯提示詞。
- 可選模型 profile（NVFP4、INT4、Official INT8、Ref2VA、Wan Animate 等，實際選項依模式而定）、寬高、時長、步數、種子、輸出名稱及 Render count。
- 一般模式寬高範圍為 32–2048 且以 32 為步進；Replace 使用 16 步進。時長 2–60 秒（既有流程預設 5 秒）、步數 1–80、種子 0–2147483647、Render count 1–20；角色 LoRA strength 為 0–2。

畫面會回報 Bridge/ComfyUI readiness、驗證錯誤及草稿自動儲存狀態。若素材或數值不符合模式需求，Generate 會被停用並顯示原因。

## 3. 長片／分鏡工作流

路徑：`/app/create/long`。先輸入標題、故事文字與必填的輸出資料夾；可再提供首幀圖片，並選擇 continuity 或 multi-reference（最多 8 張參考圖）。

1. 選擇 planner（Ollama 或 Codex）與模型，設定自動或手動 timeline，按 **Plan** 產生分鏡草案。
2. 在分鏡編輯器調整每段的描述、ending state、H3 prompt 與負面提示詞；手動 timeline 至少要有 2 段。
3. 設定總時長（1–3600 秒）、段落時長提示（0.5–60 秒）、寬高、步數、種子與模型 profile。
4. **Save draft/plan** 會保存版本；**Start** 會建立或啟動 sequence，之後在 Jobs 詳情追蹤。

長片的輸出資料夾必須位於 ComfyUI output 範圍且不可與既有資料夾衝突。畫面中的 `drop_next_first_frame` 接續選項目前標示為不支援；實際尾幀圖片送給 Ollama 以完成 continuation prompt 的流程也尚未接線。

## 4. Jobs 與工作狀態

路徑：`/app/jobs`。這裡統一列出單支影片、長片、Upscale、Image-to-Image 及 LoRA Trainer 工作，支援依 `all / queued / running / complete / partial / error / cancelled` 篩選，並可按標題、工作 ID 或來源搜尋。列表與詳情會定期更新，顯示狀態、進度、ETA、錯誤及輸出。

- 影片工作可 **cancel**；長片另有 **pause/resume/retry**。
- LoRA 工作可 **cancel/retry**；Upscale 與 Image-to-Image 可 **retry**。
- Upscale、Image-to-Image 目前沒有 cancel API，詳情頁只會提示此限制。
- Shell 的 Recent Jobs 抽屜顯示活動數與最近 5 筆工作，**View all** 可回到完整列表。

## 5. Library（媒體庫）

路徑：`/app/library`。可在 `all`、`input`、`output` 根目錄間切換、搜尋、上傳圖片/影片、預覽、下載或刪除單筆/多選項目。建立影片、長片、Upscale、Image-to-Image 及 LoRA 時都可開啟 Asset Picker；LoRA Trainer 另會從 `training` 素材來源取用圖片，可按資料夾瀏覽、搜尋並限制選取數量。

完成的影片、放大結果、Image-to-Image 批次圖片及 LoRA artifact 會提供開啟/下載連結；刪除 Library 項目會移除該檔案，請先確認不再需要。

## 6. Settings（設定）

路徑：`/app/settings`。

- **Runtime**：選擇 Local GPU 或 Vast RTX 5090，查看 Bridge、ComfyUI、Ollama、Codex 狀態，以及 ComfyUI 裝置/VRAM 資訊。
- **Prompt defaults**：設定預設 provider（Ollama/Codex）、Ollama model、Codex model 與 reasoning；設定會自動保存於本機瀏覽器。
- **Runtime details**：查看目前選用 runtime 的 API 位址與健康檢查結果。

切換 runtime 時會先檢查是否有活動工作；有工作執行中會拒絕切換，避免中斷生成。

## 7. Tools

### Upscale

路徑：`/app/tools/upscale`。選擇或上傳影片，先通過 SeedVR2/ComfyUI readiness 檢查，再提交放大工作；可在畫面追蹤進度、取消、重試、預覽、開啟或下載輸出。現行工具固定使用 SeedVR2 7B Sharp NVFP4 **2×**，搭配 native auto chunk、latent overlap 1 與 wavelet 色彩校正，沒有自訂倍率。

### Image-to-Image

路徑：`/app/tools/image-to-image`。選擇或上傳一張來源圖片，輸入正向與負面提示詞；可用 Ollama vision 輔助產生提示詞。可選 SDXL Turbo、SD1.5；Z-Image Turbo 與 WAI Illustrious 僅在 local runtime 顯示。可設定可選 LoRA（strength 0–2）、denoise 0.01–1、steps 1–50、CFG 0–20、seed、batch 1–20 及 random ranges。

工作會顯示 ComfyUI readiness、進度與批次結果；部分批次失敗時仍可查看成功項目，輸出可下載或刪除，也可在 History 搜尋並展開查看參數。此工具目前只有 retry，沒有 cancel API。

### LoRA Trainer

路徑：`/app/tools/lora-trainer`。依序完成 Dataset、Captions、Config/Preflight、Progress、Artifact：

1. 從 training Library 選取或上傳最多 50 張圖片。
2. 產生或手動修訂 captions，再確認 captions。
3. 選擇 SDXL 或 Illustrious family/base、輸出名稱與最多 20 個 trigger words；可調整 rank、alpha、learning rate、epochs、batch、resolution、seed 等進階設定並執行 preflight。
4. Enqueue/Start 後查看 Step、Epoch、Loss、ETA；可 cancel 或 retry。
5. 完成後查看 artifact 的 SHA/registry/provenance，下載 `.safetensors`，或用 **Open in Image-to-Image** 帶入 LoRA。

## 8. 輸出、下載與已確認限制

- 工作詳情與各工具結果都提供媒體預覽、開啟或下載；影片、放大及 Image-to-Image 媒體輸出會回到本機 Library 的 output 區域，LoRA 則透過 Trainer 的 artifact download 取得。遠端 Vast 模式沒有持久磁碟，重建 instance 可能遺失 Ollama、H3 權重與設定。
- 所有頁面都依服務健康與工作狀態控制按鈕；錯誤、部分成功及取消會保留在 Jobs/History 供重試或檢查。
- Prompt Assistant/長片 planner 需可用的 Ollama 模型，或已配置的 Codex CLI；模型未就緒時不會假設自動提示詞功能可用。
- FL2V/L2V 是否能執行取決於目前 H3 generator 是否提供 `--last-frame` 支援；若未提供，bridge 會在送出前拒絕該模式。Ref2V/Replace 亦需相應模型/profile 已就緒。
- 目前沒有把 ComfyUI 或 Ollama 對外公開的 WebUI 功能；它們維持 loopback，由 H3 Studio bridge 統一調用。
