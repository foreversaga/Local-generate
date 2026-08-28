# UI/UX Pro Max 改版實作報告

日期：2026-08-28  
分支：`agent/ui-ux-pro-max-2026-08-28`  
基準：`main` @ `db92ba1013934e49a79244afb5074ff26abd96a7`

## 結論

本分支已完成本輪 UI/UX Pro Max 規劃中的前端改版範圍，維持既有主要導覽、生成 API、Job API、素材 root contract 與 workflow runner 行為。

本輪沒有需要 `minimax-workflow` 新增 API 的需求，因此沒有建立無消費者的 workflow API 或額外 workflow 分支。

## 已完成

### Create landing

- 移除 Create 首頁重複的 Tools teaser。
- 主流程改為 `Single / Long → Recent Jobs → Start from Asset`。
- Recent Jobs 不再重複同一標題。
- 保留 `input` / `output` 兩種素材 root。
- 新增 IA regression test。

### Single Create

- 將原本多個選填/技術開關收斂成單一 `專業設定` switch。
- 基礎模式優先保留素材、描述、H3 prompt、片段長度、validation 與 Generate CTA。
- 模型 profile、ALPHA-T1、LoRA、解析度、steps、seed、batch、輸出檔名、prompt provider/model、camera planning、reference-video preprocessing、draft/runtime controls 與完整技術摘要移到專業層。
- 草稿包含非預設專業值時自動展開專業設定。
- 隱藏的專業欄位發生 validation error 時，自動展開以避免錯誤不可見。
- 新增的 Basic / Professional 說明支援中英文 locale。
- 保留所有既有 mode、profile 與生成 request contract。
- 更新 progressive disclosure tests。

> 目前 Single Create 主表單仍是大型既有元件。這次先把 UX 狀態收斂到單一專業層，沒有為了改版而重寫生成 domain。CSS selector 已縮小到有穩定 section/id/ARIA anchor 的範圍；下一次若拆分 `SingleCreateForm` domain component，可再把 disclosure 完全移入欄位元件 props。

### App Shell / Accessibility

- 新增 skip-to-content。
- 建立穩定 `#main-content` focus target。
- disabled control 不再以 `wait` cursor 誤表示 loading。
- 保留 desktop sidebar、mobile bottom nav 與 reduced-motion 行為。
- Tools card 支援正確 h2/h3 heading hierarchy。

### Tools

依使用意圖分成：

1. Create Images：Text-to-Image、Pose-to-Image。
2. Edit / Enhance：Image-to-Image、Upscale、Video Character。
3. Train：LoRA Trainer。

- 所有原 route 保留。
- Pose / Video Character 首頁文案補上英文顯示路徑。
- 不增加 primary navigation 層級。

### Jobs

Job list 的主要動作改為 status-aware：

- `complete` → 開啟結果。
- `partial` → 檢查可用結果。
- `error` → 檢查錯誤。
- `queued / running` → 查看進度。
- 其他 → 查看詳情。

原有 progress、elapsed、ETA、filter 與 polling 不變。

### Library

- 大型素材集合下，desktop/tablet toolbar 改為 sticky，瀏覽時保留 media root、搜尋、上傳與 selection actions。
- selection state 提升視覺辨識度。
- 主要 toolbar / breadcrumb control touch target 提升至 44px 級別。
- 手機版取消 sticky，避免 toolbar 與 bottom navigation 競爭可視高度。
- 上傳位置與既有 `input` destination 行為不變。

### Settings

第一層只保留：

- runtime 選擇。
- 服務是否可用。
- prompt provider/model defaults。

技術資訊集中到 `技術詳情` disclosure：

- ComfyUI / Ollama endpoint。
- Qwen model。
- Codex version / skill state。
- active operations。
- GPU / VRAM diagnostics。

因此正常狀態不再讓 URL、port 與 VRAM 佔據主要資訊層級。

### Regression contracts

新增 `tests/ui-ux-pro-max-contract.test.mjs`，鎖定：

- shell skip navigation。
- Tools 分組與 route 完整性。
- Jobs status-aware action。
- Settings technical disclosure。
- Library sticky toolbar / touch target。
- Single Create professional disclosure 與 asset root contract。

## 明確未改動

- `/app/api/generate` request payload。
- Bridge generation API。
- workflow runner。
- ComfyUI workflow graph。
- `input` / `output` asset root contract。
- `minimax-workflow` repository。
- primary navigation routes。

## Workflow repo 判斷

本次不需要 workflow API。

現有前端已能取得：

- mode / profile / acceleration readiness。
- Job progress / elapsed / ETA。
- input / output asset contract。
- runtime/service health。

只有未來要把 profile catalog、quality tier、speed tier、recommended width/height/steps 等資料改成完全由 workflow backend 自我描述時，才需要在 `minimax-workflow` 開能力目錄分支並新增 capability metadata API。

## 驗收狀態

### 已完成

- GitHub source-level implementation。
- branch vs main diff review。
- static regression/contract tests 已加入 repository。
- diff 限定於 UI、CSS、docs、tests；沒有 backend/workflow API 變更。

### 仍必須在實際 Local Generate 主機執行

依 repository `AGENTS.md`，完整 runtime 驗收仍必須在能啟動本機服務的環境執行：

1. `npm run test`
2. `npm run lint`
3. production build（本 parent task 僅一次）
4. restart WebUI 8787
5. health check
6. Browser 實際操作驗收 Create / Jobs / Library / Tools / Settings
7. viewport 驗收：320 / 375 / 768 / 1024 / 1440

目前這個 ChatGPT 執行環境只有 GitHub connector，無法連到使用者本機 8787 / 8188，因此不把 Browser/runtime 驗收標記為已通過。
