# MiniMax H3 Video Studio 交接進度

更新日期：2026-08-10

## 新對話從這裡開始

Repository：`foreversaga/Local-generate`

正式 WebUI 改版分支：`agent/document-webui-redesign-plan`

**不要從暫存 branch 接續。** 新對話先讀：

1. `CONTINUATION_STATUS.md`
2. `docs/webui-implementation-plan.md`
3. `docs/webui-layout-redesign-spec.md`

目前 WebUI 改版已完成到 **Phase 6 的靜態收尾**：Tools、Settings、defaults integration、responsive/a11y 靜態規則與 cleanup 均已完成；不要重新規劃前面 Phase。

## 最新已驗證 checkpoint

- 功能 commit：`8bf1631f8beb8d9ebcb749d409d219f38b740514` — `feat: complete Library and Create asset picker`。
- 正式 GitHub Actions：`WebUI CI` run `31378491826` = **success**。
- Library temp verification：run `31378420595` = **success**。
- 此 checkpoint 已包含先前已驗證的 Long Create 與 Jobs。

## 2026-08-10 WebUI 改版完成狀態

### 已完成

- Phase 1：route / validation / request contracts。
- Phase 2：AppShell、Create landing、Single Create、Long Create。
- Phase 3：Jobs adapter、recent jobs drawer、Jobs list、Job detail、cancel/retry/pause/resume/output。
- Phase 4 前半：Library 完整管理頁、Create Asset Picker、Create landing 從 input 素材開始。
- Phase 4 後半：`/app/tools/upscale` 與 `/app/tools/image-to-image` 已掛載實際 workspace，保留既有 API contract。
- Settings：`/app/settings` 已提供 runtime local/Vast、provider/model defaults、service status；defaults 已接入 Single Prompt Assistant 與 Long Create 並依 health reconcile。
- Phase 5 靜態：44px targets、focus/keyboard、dialog focus trap、ARIA、reduced motion、mobile bottom navigation、safe-area spacing 已覆蓋主要 routes。
- Phase 6 靜態：已移除未引用 `MigrationPanel` export 與 route-only styles；新版 routes 已完成統一收尾。

### Single Create

- `/app/create/single`
- T2V / I2V / FL2V / L2V / Ref2V / Replace。
- Prompt Assistant：Ollama / Codex CLI。
- shared `validateSingleRender()`，各新 route 共用同一套規則。
- request payload contract 保持既有 `/app/api/generate` semantics。
- draft local autosave / hydration / successful-submit cleanup。
- sticky summary / validation / desktop CTA、mobile sticky CTA。
- field-level ARIA、keyboard file upload、reduced motion。
- production Vinext worker route render test。

### Long Create

- `/app/create/long`
- Story / Source、references、planner / timeline、segment review、render setup / review。
- 使用既有 `/app/api/sequences*`、planner payload 與 persisted sequence/draft shape。
- auto/manual timeline contract 與 hydration 行為保留。
- Create 只負責規劃/提交；queue/progress/recovery 由 Jobs 承接。

### Jobs

- `/app/jobs`
- `/app/jobs/[id]`
- backend 狀態 normalize 為 queued / running / complete / error / cancelled。
- topbar recent jobs drawer。
- cancel / retry / pause / resume / output 保留既有 backend API 行為。
- complete job 不顯示 Retry；drawer active count 計算完整 job set。

### Library / Create Asset Picker

- `/app/library` 已取代 migration placeholder。
- 管理 input/output：搜尋、預覽、download、delete、batch delete、upload。
- Preview dialog 與 picker dialog 有 Escape、focus trap、focus restore。
- Create Asset Picker 限定 input 素材，避免 output 被選入 Single 後無效。
- Create landing 的「從素材開始」使用既有 Single draft contract：
  - input image → Single I2V reference。
  - input video → Single Ref2V source video。
  - 既有 prompt 等 draft 狀態保留。

## 尚未執行／已知風險

1. 尚未執行 375 / 768 / 1024 / 1440 瀏覽器 viewport 與 horizontal-overflow sweep；CSS 已有 mobile nav、safe-area 與 reduced-motion 規則，但不可把靜態檢查當成實機驗收。
2. 尚未啟動 ComfyUI/Ollama、執行 runtime health、模型載入或真實影片/圖片生成 smoke；本交接文件不宣稱這些項目已完成。
3. Upscale 與 Image to Image 既有 API 不提供 cancellation；UI 明確提示限制，不偽造取消能力。

## GitHub / CI 工作規則

- 正式來源：`agent/document-webui-redesign-plan`。
- 每個 checkpoint 先在暫存 branch 跑 `npm ci && npm test`，成功後才建立 clean commit fast-forward 正式 branch。
- `npm test` = `vinext build` + `node --test tests/*.test.mjs`。
- commit 前使用 `compare_commits` 驗證 diff。
- **不要再使用 `.tmp` 壓縮檔、base64 staging、CI 解壓或 CI 套 patch 來傳輸程式碼。**
- 多檔更新可使用 Git 原生 blob/tree/commit；blob SHA 可用本地 `git hash-object` 比對完整性。
- 驗證用 workflow 不要帶進正式功能 commit。

## 不可破壞邊界

- 保持 `/app` base path。
- 不改 `local-bridge.mjs` 既有 API URL、payload、polling semantics。
- 不改 ComfyUI / Ollama / Codex / Vast runtime 拓撲。
- 不改 long-video draft persisted shape 與 hydration semantics。
- 不修改使用者的 Tailscale Serve 設定。
- 不把 ComfyUI 或 Ollama 改成對外監聽所有介面。

## 本機 / 網路環境（沿用）

- 網頁：`0.0.0.0:8787/app`
- ComfyUI：`127.0.0.1:8188`
- Ollama：`127.0.0.1:11434`
- 前端 API：同源 `/app/api/...`
- media：`/app/media/...`
- `next.config.ts` 不要直接重新加入 `basePath: "/app"`；目前 `/app` 由既有 Vite/Vinext middleware contract 處理。

## 重要檔案

- `docs/webui-implementation-plan.md`：正式實作順序與進度。
- `docs/webui-layout-redesign-spec.md`：D1–D7 已確認設計決策。
- `app/lib/webui-routes.mjs`：primary route contract。
- `app/lib/single-render-validation.mjs`：Single shared validation。
- `app/components/create/SingleCreateForm.tsx`：Single route 主表單。
- `app/components/create/LongCreateForm.tsx`：Long route 主表單。
- `app/lib/job-adapter.mjs`：Jobs normalized domain adapter。
- `app/components/library/LibraryWorkspace.tsx`：Library 管理頁。
- `app/components/library/AssetPickerButton.tsx`：Create 精簡 picker。
- `app/page.tsx`：新版 root Create landing。
