# H3 Studio WebUI 改版計畫（決策進行中）

> 文件狀態：目前改版方向與階段草案，尚非最終實作計畫。D1–D5 已確認；D6（手機主導覽）與 D7（視覺刷新範圍）未決。全部決策確認後才產出最終實作計畫與執行；現在不實作。

## 1. 改版目標與邊界

以工作流重排資訊，不刪除既有生成、資源與工具能力。目標是讓使用者在 Create 完成來源、prompt、設定、review，再到可恢復的 Job detail。非目標：改變模型、API payload／輪詢、檔案格式、服務拓撲或長片 draft 資料。

## 2. 現況證據（保留必要來源）

- `app/page.tsx:692–781` 的單一 `Home` 集中約 80 個 state/ref；sidebar、模式切換與服務狀態仍在 `2569–2655`。
- Prompt 與生成設定分別在 `app/page.tsx:3316–3445`、`3448–3718`；升頻/I2I 先佔 `2699–3048`。DOM/幾何盤點量得 desktop Prompt y≈1754、Generate y≈2530。
- mobile body 約 7088px；截圖擷取失敗，但 DOM/幾何已驗證：`app/globals.css:3037–3055` 的 nav scrollWidth≈534、viewport≈317；資源卡按鈕在 `2437–2470,2484–2494` 約 8–9px。
- `app/page.tsx:3706–3710` 的 Generate 只 disabled `renderBusy`，空 prompt 仍可按；必填檢查延後至 `1975–1982`。
- 長片規劃、timeline、分鏡、渲染、進度集中 `app/page.tsx:3050–3314`，資源預覽與套用集中 `3932–4351`；目前只用 `app/globals.css:3461–3472` 隱藏單片區。
- `/app` base/middleware 由 `vite.config.ts:14–33,126–192` 維持，API route 群組在 `local-bridge.mjs:2498–2710`。

## 3. 已確認資訊架構與建議 routes

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

建議 route（實際 route 細節留待最終實作計畫確認）：

`/app/create`、`/app/create/single`、`/app/create/long`、`/app/jobs`、`/app/jobs/[id]`、`/app/library`、`/app/tools/upscale`、`/app/tools/image-to-image`、`/app/settings`。

D1、D2 已確認為獨立頁／入口；桌面使用 sidebar。D6 尚未決定底部 nav、漢堡或頂部橫向 nav，不能提前視為定案。系統狀態（Ollama、Codex、ComfyUI、runtime）收進 top bar popover。

## 4. 各頁功能規格

### Create landing

提供 Single／Long 入口、最近工作與「從資源開始」；首屏不放升頻、I2I 或完整 Library。

### Create / Single

欄位全顯示，以 fieldset／section 分組、標題、required/helper：來源／模式、Prompt（AI 或手改）、negative、model／尺寸／時長／Steps／Seed／批次。選配欄位降權但不折疊、不採 stepper 或 Advanced 隱藏。左表單＋右 sticky summary／preview／validation／Generate；右側 gating 控制，提交到 `/app/jobs/[id]`，表單不嵌完整 queue。

### Create / Long

欄位全顯示並分區：故事／來源、continuity／references、planner／timeline、segment review（描述、H3 prompt、negative、ending state）、render setup／review。保留 auto/manual、草稿與分段狀態；右 summary 驗證後到 Job detail。

### Jobs 與 Job detail

Top bar 只放近期 badge/drawer；完整歷史在 Jobs 頁。Jobs 頁支援篩選、排序、五種狀態、取消、重試、詳情、輸出與批次／長片恢復；歷史不回塞 Create。

### Library

完整 Library 管理 input/output、搜尋、預覽、下載、刪除、批次。Create 只用精簡 picker（搜尋／最近／預覽／選取），不做批次管理；回傳 source／reference／last frame 角色。

### Tools

Tools 同時提供影片升頻、完整 I2I 表單、進度、取消／重試與結果，輸出回 Library。I2I 只在 `/app/tools/image-to-image`，不做 Create 快速入口；升頻在 `/app/tools/upscale`。

### Settings

集中 runtime、prompt provider、模型預設、服務狀態與安全說明；狀態由 top bar popover 進入，不承擔生成表單。

## 5. Desktop 版面與 wireframe

主 shell 為 sidebar + topbar + two-pane；左側 fieldsets 全展開，右側 sticky summary／preview／validation／Generate；Job drawer 從 top bar 展開。

```text
[Sidebar: Create | Jobs | Library | Tools | Settings]
[Topbar: status | Job badge/drawer]
┌──────────── Left form / fieldsets ────────────┐ ┌── Right sticky ──┐
│ Source + mode │ Prompt │ Render settings       │ │ Preview/assets   │
│ Review（欄位全顯示）                           │ │ validation + CTA │
└───────────────────────────────────────────────┘ └──────────────────┘
```

這是欄位分區，不是 stepper；Advanced 不折疊，主 CTA 只在右 summary 出現一次。

## 6. Mobile 共同底線（D6 未決）

375／768px 優先單欄，保留安全區 padding、section anchor 與 sticky CTA；所有 fieldset 可依 section anchor 快速定位，但內容仍可見。Asset picker 用 bottom sheet／dialog。不得水平溢出；主導覽採底部 nav、漢堡或頂部橫向仍待 D6 選擇。

## 7. 狀態、驗證與 a11y

空 prompt、缺素材、尺寸無效或 mode 不相容時不可提交，欄位旁顯示原因並讓右側 gating 同步。Job 統一 queued／running／complete／error／cancelled，顯示階段、進度／ETA、Cancel、Retry，不能只 spinner。表單與長片 draft autosave；離開有未儲存確認。互動目標 ≥44px、8px spacing、對比 ≥4.5:1、2px focus；正確 heading／label、`aria-live`、`aria-busy`、dialog focus trap、鍵盤可操作；支援 reduced motion、無 horizontal scroll。

## 8. 分階段草案（非最終實作計畫）

1. **Contracts／routes／state 邊界**：列出既有 API payload、polling、route adapter 與 domain state；交付 route/state mapping，驗收是不改服務拓撲且可保留 draft hydration。
2. **Create 頁**：Create landing、Single、Long 與左右欄 summary/gating；交付兩條流程的可用 DOM 骨架與必填驗證。
3. **Jobs**：Job badge/drawer、Jobs 歷史、detail、取消／重試／恢復；驗收各五種狀態可讀且不回塞 Create。
4. **Library／Tools**：picker、完整 Library、Upscale、I2I 與輸出回寫；驗收角色化選取及 output 可回 Library。
5. **Responsive／a11y**：375/768/1024/1440 幾何、鍵盤、ARIA、reduced motion；驗收無溢出與 44px 觸控。
6. **Visual tokens**：僅在 D7 確認後定義色彩、字體、間距與狀態 tokens；D6/D7 未決前不得據此開始實作。

## 9. 決策紀錄

| ID | 決策／目前選擇 | 替代或未決項 | 狀態 |
|---|---|---|---|
| D1 路由 | Create、Jobs、Library、Tools、Settings 各自獨立頁／route | 維持單頁錨點 | 已確認 |
| D2 分流 | Create 內 Single、Long 兩個獨立入口與專屬流程 | 同頁 toggle | 已確認 |
| D3 密度 | 所有欄位常駐；fieldset/section、helper；左表單＋右 sticky summary/CTA | stepper 或 Advanced 折疊 | 已確認 |
| D4 Jobs | top bar badge/drawer（近期）＋完整 Jobs 頁（歷史、篩選、取消、重試、詳情） | 只留其一 | 已確認 |
| D5 工具/資源 | Create 精簡 picker；完整 Library 獨立；Tools 含 Upscale＋I2I，I2I 不進 Create | 工具全塞工作台 | 已確認 |
| D6 mobile nav | 底部 nav／漢堡／頂部橫向待選 | — | 待確認 |
| D7 visual | 刷新範圍待定；視覺稿任務已取消 | 只改 IA 或全面 tokens | 待確認 |

## 10. 成功指標與保持不變

桌面首屏能抵達 Prompt 與右側主 CTA；mobile 無水平溢出、控件 ≥44px；每頁一個主要提交 CTA；空 prompt／缺素材不可提交；Jobs drawer 與完整頁可恢復工作；picker 能安全帶回 input/output；Tools 輸出可在 Library 找到。保持 `/app` base、API payload／polling、長片 draft hydration（`app/page.tsx:1144–1200`）與本機服務拓撲不變。D1–D7 全部確認後，才另產最終實作計畫與執行授權。
