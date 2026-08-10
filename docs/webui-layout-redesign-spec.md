# H3 Studio WebUI 改版執行計畫

> 狀態：D1–D7 已確認，可開始實作。此改版只重整 WebUI 資訊架構、頁面責任、驗證、responsive/a11y 與視覺 tokens；不改模型、API payload、polling、檔案格式、long draft schema 或本機服務拓撲。

## 1. 改版目標與邊界

以工作流重排資訊：Create 完成來源 → prompt → 設定 → review，再進入可恢復的 Job detail。

保持不變：

- `/app` base path 與既有 middleware 行為。
- `local-bridge.mjs` API contract、payload 與 polling 流程。
- ComfyUI / Ollama / Codex / Vast runtime 拓撲。
- long draft hydration 與既有資料格式。
- 既有生成、資源管理、升頻、I2I、長片能力。

## 2. 現況證據

- 單一 `Home` 同時持有生成、長片、Library、Jobs、Upscale、I2I、runtime 等大量 state/ref：`app/page.tsx:692–810`。
- sidebar 仍是頁內 section navigation，Single/Long 仍是 top bar toggle：`app/page.tsx:2569–2655`。
- Prompt/設定在頁面下半部；Upscale/I2I 與 Long workflow 也混在相同 DOM。
- `startRender()` 已有送出後驗證，但 Generate CTA 並未以相同規則預先 gate：`app/page.tsx:1975+`。
- mobile 既有 navigation 會水平溢出，資源卡 action target 小於預期。

## 3. 最終資訊架構與 routes

```text
H3 Studio
├─ Create
│  ├─ Single
│  └─ Long
├─ Jobs
├─ Library
├─ Tools
│  ├─ Upscale
│  └─ Image to Image
└─ Settings
```

Routes：

- `/app/create`
- `/app/create/single`
- `/app/create/long`
- `/app/jobs`
- `/app/jobs/[id]`
- `/app/library`
- `/app/tools/upscale`
- `/app/tools/image-to-image`
- `/app/settings`

`/app` 保留作為相容入口，導向 `/app/create`。

## 4. 頁面責任

### Create landing

只提供 Single、Long、最近工作與「從資源開始」。首屏不放完整 Library、Upscale 或 I2I。

### Create / Single

欄位全顯示，以 fieldset/section 分組：

1. Source / mode
2. Prompt / negative prompt
3. Render settings
4. Review

不採 stepper、不使用 Advanced 折疊。

Desktop 使用左表單 + 右 sticky summary。右側只出現一次主要 Generate CTA，並同步呈現 validation reason。

### Create / Long

分區：

1. Story / source
2. Continuity / references
3. Planner / timeline
4. Segment review
5. Render setup / review

保留 auto/manual、draft hydration、segment 狀態與續作能力。

### Jobs / Job detail

Top bar 只保留近期 Job badge/drawer。完整歷史、篩選、五種狀態、取消、重試、詳情、輸出與恢復集中到 Jobs。

統一 UI 狀態：`queued | running | complete | error | cancelled`。若後端名稱不同，由 adapter 正規化，不改後端 contract。

### Library

Library 管理 input/output、搜尋、預覽、下載、刪除、批次操作。

Create 只使用精簡 picker；picker 回傳用途角色：`source | reference | lastFrame`。

### Tools

- `/app/tools/upscale`：影片升頻。
- `/app/tools/image-to-image`：完整 I2I。

兩者提供進度、取消/重試與結果，輸出回 Library；Create 不再放 I2I 快捷表單。

### Settings

集中 runtime、prompt provider、模型預設、服務狀態與相關說明，不承擔生成表單。

## 5. Shell 與導覽

### Desktop

- Persistent sidebar：Create / Jobs / Library / Tools / Settings。
- Top bar：page title、runtime/service status popover、近期 Job drawer。
- Create 使用 two-pane；右側 summary sticky。

### Mobile（D6 已確認）

採 **bottom navigation**，原因：五個主要區域固定、使用頻率高，且可避免既有 horizontal nav overflow。

- `<= 768px`：sidebar 隱藏，底部固定 nav。
- 五個 primary item：Create、Jobs、Library、Tools、Settings。
- Tools 子頁在 Tools route 內切換，不增加第六個 bottom item。
- 保留 safe-area inset；主內容需預留 bottom nav 高度。
- Create 使用單欄 + sticky Generate CTA；asset picker 用 bottom sheet/dialog。

## 6. 視覺策略（D7 已確認）

採 **全面 semantic token 刷新**，但不重做品牌識別、不改功能行為。

先建立 semantic tokens，再逐頁套用：

- `--color-bg-*`
- `--color-surface-*`
- `--color-text-*`
- `--color-border-*`
- `--color-accent-*`
- `--color-status-*`
- `--space-*`
- `--radius-*`
- `--shadow-*`
- `--focus-ring`
- typography scale

禁止頁面元件新增無語意的散落 hard-coded 顏色/間距；既有品牌綠可映射為 accent token。

## 7. 驗證與 a11y

Create CTA 必須在送出前以與 handler 相同的規則 gate：

- prompt 空白
- H3 prompt 超長
- mode 缺必要素材
- width/height 不合法
- steps/seed/render count 不合法
- mode 與素材不相容

欄位旁與 summary 同步顯示原因；handler 仍保留防禦式 validation。

A11y：

- touch target `>= 44px`
- 對比 `>= 4.5:1`
- 可見 2px focus ring
- 正確 heading / label
- `aria-live` / `aria-busy`
- dialog focus trap
- 鍵盤可操作
- reduced motion
- 375 / 768 / 1024 / 1440 無 horizontal overflow

## 8. State / contract 原則

詳細 mapping 見 `docs/webui-route-state-contract.md`。

核心原則：

- page 不直接擁有所有 domain state。
- shared data 由 typed hook/service 提供。
- API adapter 是唯一知道 bridge payload 的 UI 層邊界。
- route component 只組裝 domain section，不複製 fetch/polling 實作。
- validation 使用 pure function，UI gating 與 submit handler 共用。
- long draft hydration 在拆頁後必須保持可恢復。

## 9. 實作階段

### Phase 1 — Contracts / routes / state boundaries

交付：

- route/state contract。
- shared validation contract。
- app shell / navigation route skeleton。
- API adapter 邊界清單。

驗收：

- 不改 bridge API。
- `/app` 相容入口保留。
- long draft schema/hydration 不變。
- legacy Home 尚可在遷移期間運作。

### Phase 2 — Create

交付：Create landing、Single、Long、summary/gating、asset picker integration。

驗收：桌面首屏可抵達 Prompt 與 CTA；空 prompt/缺素材不可提交；Single/Long 不再靠同頁 toggle 隱藏另一條流程。

### Phase 3 — Jobs

交付：badge/drawer、Jobs list、detail、cancel/retry/resume。

驗收：五種 UI 狀態可讀；歷史不回塞 Create；detail 可恢復工作。

### Phase 4 — Library / Tools

交付：Library、picker、Upscale、I2I。

驗收：picker 可安全帶回資源角色；Tools output 可在 Library 找到。

### Phase 5 — Responsive / a11y

交付：mobile bottom nav、sticky CTA、bottom-sheet picker、四斷點與 keyboard/ARIA 修正。

驗收：無水平溢出、touch target >=44px、主要流程可純鍵盤完成。

### Phase 6 — Visual token rollout / cleanup

交付：semantic token 套用、legacy CSS 清除、重複 UI 樣式合併。

驗收：頁面不新增散落 hard-coded theme 值；狀態色與 focus 行為一致。

## 10. 測試策略

遵循 Red → Green → Refactor：

1. 先為 validation / adapter / route behavior 補失敗測試。
2. 實作最小變更讓測試通過。
3. 綠燈後再拆 component / hook 與清理 CSS。

最低測試覆蓋：

- Create validation matrix。
- mode required assets。
- adapter status normalization。
- `/app` → `/app/create` compatibility。
- long draft hydration regression。
- Jobs cancel/retry state transition。
- Library picker role mapping。

## 11. 決策紀錄

| ID | 決策 | 狀態 |
|---|---|---|
| D1 | 五區獨立 page/route | 已確認 |
| D2 | Single、Long 獨立入口/流程 | 已確認 |
| D3 | 欄位常駐、fieldset/helper、左表單 + 右 summary/CTA | 已確認 |
| D4 | top Job badge/drawer + 完整 Jobs 頁 | 已確認 |
| D5 | Create picker、Library 獨立、Tools 含 Upscale + I2I | 已確認 |
| D6 | Mobile 使用 bottom navigation | 已確認 |
| D7 | 全面 semantic tokens 刷新，保留品牌與功能行為 | 已確認 |

## 12. 完成條件

- Create、Jobs、Library、Tools、Settings 都有獨立 route。
- Single / Long 不再靠同頁 toggle 作為主要資訊架構。
- 桌面 Create 使用 form + sticky summary；mobile 使用單欄 + sticky CTA。
- 空 prompt/缺素材/無效參數在提交前就被 gate。
- Jobs 可取消、重試、查看 detail、恢復長片/批次工作。
- Library picker 與完整 Library 職責分離。
- mobile bottom nav 無 horizontal overflow。
- controls >=44px，鍵盤/a11y 達標。
- API payload/polling、long draft schema、本機 runtime 拓撲零破壞變更。
