# H3 Studio WebUI 最終實作計畫

> 狀態：2026-08-10 已取得實作授權。決策來源為 `docs/webui-layout-redesign-spec.md` 的 D1–D7。

## 0. 目前實作進度（2026-08-10）

正式工作分支：`agent/document-webui-redesign-plan`。

- **Phase 1 — Contracts / validation / route foundation：完成**
  - `/app` 相容與 nested route contract 已建立並有測試。
  - Single render 使用 shared `validateSingleRender()`；legacy CTA 與 submit defensive validation 共用規則。
  - generate / prompt request payload 以 pure contract 鎖定，bridge API semantics 未改。
- **Phase 2 — App shell / Create：完成**
  - AppShell、desktop sidebar、top bar、mobile bottom navigation 已建立。
  - `/app/create` landing 已完成。
  - `/app/create/single` 已完成：六種模式、素材、Prompt Assistant、sticky summary/CTA、draft autosave、route render/a11y tests。
  - `/app/create/long` 已完成：story/source、references、planner/timeline、segment review、render setup，保留既有 sequence/draft contract。
- **Phase 3 — Jobs：完成**
  - 五狀態 adapter、recent jobs drawer、`/app/jobs`、`/app/jobs/[id]` 已完成。
  - cancel / retry / pause / resume / output 行為由既有 backend API 提供，不改 API semantics。
- **Phase 4 — Library / Tools：進行中**
  - `/app/library` 完整管理頁與 Create Asset Picker 已完成。
  - Create landing 可從 Library input 素材開始，透過既有 Single draft contract 做 image→I2V、video→Ref2V role mapping。
  - **尚未完成：`/app/tools/upscale` 與 `/app/tools/image-to-image` 的完整 migration。**
- **Phase 5 — Responsive / a11y：部分完成**
  - Shell、Single、Long、Jobs、Library/Picker 已套用 44px target、focus/keyboard、dialog focus trap、reduced motion 等規則。
  - **尚未完成：375 / 768 / 1024 / 1440 全域驗收與 horizontal-overflow sweep。**
- **Phase 6 — Moderate visual refresh / cleanup：尚未最終收尾**
  - 新 route 已使用一致 dark/lime 視覺與 semantic states。
  - **尚未完成：Tools / Settings 完成後的全域視覺一致化與 legacy placeholder/cleanup。**

最新已驗證功能 checkpoint：`8bf1631f8beb8d9ebcb749d409d219f38b740514`；GitHub Actions `WebUI CI` run `31378491826` = **success**。交接細節以根目錄 `CONTINUATION_STATUS.md` 為準。

### 下一個新對話直接開始

1. 完成 `/app/tools/upscale`。
2. 完成 `/app/tools/image-to-image`。
3. 完成 `/app/settings`：runtime/provider/model defaults/service status；不可把生成表單塞進 Settings。
4. 跑 Phase 5 四斷點 responsive/a11y 驗收。
5. 完成 Phase 6 visual/legacy cleanup，確認 parity 前不要刪 legacy 能力。

## 1. 不可破壞邊界

- 保持 `/app` base path。
- 不改 `local-bridge.mjs` 既有 API URL、payload、polling semantics。
- 不改 ComfyUI / Ollama / Codex / Vast runtime 拓撲。
- 不改 long-video draft persisted shape 與 hydration semantics。
- 新 UI 必須逐步取代 legacy `app/page.tsx`，不可在 parity 前刪除既有能力。

## 2. 實作順序

### Phase 1 — Contracts / validation / route foundation

1. 新增可由 Node `node:test` 直接測試的 route contract。
2. 新增 Single render pure validation contract，與現有 `startRender()` 規則一致。
3. 先補 contract tests，再補實作。
4. 讓 legacy Generate CTA 使用 shared validation 做 pre-submit gating；submit handler 仍保留 defensive validation。
5. 建立 route skeleton 前先驗證 Vinext `/app` basePath 與 nested App Router route 不衝突。

驗收：

- `/app` 相容入口仍可使用。
- validation test 覆蓋 prompt、素材、尺寸、steps、seed、影片數量。
- UI gating 與 submit validation 不出現兩套不同規則。
- bridge API zero diff。

### Phase 2 — App shell / Create

1. 建立 shared AppShell：desktop sidebar、top bar、mobile bottom navigation。
2. 建立 `/app/create` landing。
3. 將 Single flow 移至 `/app/create/single`。
4. 將 Long flow 移至 `/app/create/long`，保留 draft hydration。
5. Create desktop 使用 form + sticky summary；mobile 單欄 + sticky CTA。

### Phase 3 — Jobs

1. 建立 job adapter，將 backend status normalize 為 UI 五狀態。
2. 建立 top-bar recent jobs drawer。
3. 建立 `/app/jobs` 與 `/app/jobs/[id]`。
4. 保留 cancel / retry / resume / output 行為。

### Phase 4 — Library / Tools

1. 建立 `/app/library` 完整管理頁。
2. 建立 Create asset picker，只負責搜尋、最近、預覽、選取與 role mapping。
3. 將 Upscale 移至 `/app/tools/upscale`。
4. 將 I2I 移至 `/app/tools/image-to-image`。

### Phase 5 — Responsive / a11y

1. `<=768px` 使用固定 Bottom Navigation：Create / Jobs / Library / Tools / Settings。
2. touch target >=44px；safe-area inset；無 horizontal overflow。
3. dialog focus trap、keyboard navigation、ARIA、reduced motion。
4. 驗證 375 / 768 / 1024 / 1440。

### Phase 6 — Moderate visual refresh / cleanup

保留 H3 Studio 品牌 accent；統一卡片、表單、按鈕、間距、字級、狀態 badge、focus/hover/disabled/loading。只新增必要 semantic tokens，不做全面 design-system 重建。

## 3. Code boundaries

推薦逐步形成以下結構：

```text
app/
├─ components/
│  ├─ shell/
│  ├─ create/
│  ├─ jobs/
│  ├─ library/
│  └─ tools/
├─ lib/
│  ├─ webui-routes.mjs
│  ├─ single-render-validation.mjs
│  └─ api/
├─ create/
│  ├─ page.tsx
│  ├─ single/page.tsx
│  └─ long/page.tsx
├─ jobs/
│  ├─ page.tsx
│  └─ [id]/page.tsx
├─ library/page.tsx
├─ tools/
│  ├─ upscale/page.tsx
│  └─ image-to-image/page.tsx
└─ settings/page.tsx
```

Pure domain rules使用可直接被 Node 測試的 `.mjs`；React route/component 仍使用 TypeScript/TSX。

## 4. TDD 規則

每個可獨立驗證的變更遵循 Red → Green → Refactor：

1. 先新增最小 failing test。
2. 只實作讓該測試通過所需的變更。
3. 綠燈後再抽 component / hook / adapter。
4. defect 先補 regression test。

目前 `npm test` 會先執行 `vinext build`，再執行 `node --test tests/*.test.mjs`；新增 pure module 測試沿用此契約。

## 5. 首批測試

- route primary-nav mapping。
- `/app` compatibility mapping。
- nested Tools route active mapping。
- empty prompt。
- H3 prompt max length。
- i2v / ref2v / fl2v / l2v / replace required assets。
- width / height 32-grid；replace 16-grid；範圍 32–2048。
- steps 1–80。
- seed 0–2147483647。
- render count 1–20。

## 6. Commit policy

Phase 1 拆成小 commit：

1. `test: define WebUI contracts`
2. `feat: add WebUI route and validation contracts`
3. `refactor: share single render validation`
4. `feat: gate single render submission`

之後每個 route/功能維持可 build、可測試、可回退的 commit 邊界。

## 7. GitHub / CI 操作注意事項

- 正式來源只看 `agent/document-webui-redesign-plan`；暫存 branch 不作為新對話續作基準。
- 每個功能 checkpoint 必須先通過 GitHub Actions `npm ci && npm test` 才能合回正式 branch。
- 多檔修改優先使用 Git 原生 `blob → tree → commit`；不要再用 `.tmp` 壓縮檔、CI 解壓/套 patch 的方式傳輸程式碼。
- 建 commit 前用 `compare_commits` 檢查 diff，不能把 `.tmp`、驗證用 workflow 或不相干 Phase 帶進正式 branch。
