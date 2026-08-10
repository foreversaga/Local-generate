# H3 Studio WebUI 改版計畫（決策完成）

> 狀態：D1–D7 已全部確認。決策階段完成；下一步為產出最終實作計畫。尚未授權開始改版實作。

## 1. 改版目標與邊界

以工作流重排資訊；Create 完成來源→prompt→設定→review 後進可恢復 Job。非目標：改模型、API、格式、拓撲或 long draft。

## 2. 現況證據

- 單一 `Home` 約 80 個 state/ref：`app/page.tsx:692–781`；sidebar／模式／服務狀態在 `2569–2655`。
- Prompt/設定：`app/page.tsx:3316–3445,3448–3718`；升頻/I2I 先佔 `2699–3048`，DOM desktop Prompt y≈1754、Generate y≈2530。
- mobile body≈7088px；截圖失敗但 DOM/幾何已驗證：nav `app/globals.css:3037–3055` scrollWidth≈534>viewport≈317，資源卡按鈕 `2437–2470,2484–2494` 約 8–9px。
- Generate `app/page.tsx:3706–3710` 只看 `renderBusy`，空 prompt 仍可按；檢查在 `1975–1982`。
- Long 區 `app/page.tsx:3050–3314`；資源預覽 `3932–4351`；單片隱藏 `app/globals.css:3461–3472`。`/app`/API：`vite.config.ts:14–33,126–192`、`local-bridge.mjs:2498–2710`。

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

建議 route（細節待最終實作計畫）：

`/app/create`、`/app/create/single`、`/app/create/long`、`/app/jobs`、`/app/jobs/[id]`、`/app/library`、`/app/tools/upscale`、`/app/tools/image-to-image`、`/app/settings`。

D1/D2 已確認獨立頁／入口，桌面用 sidebar；手機主導覽依 D6 採固定底部導覽。系統狀態收進 top bar popover。

## 4. 頁面規格

### Create landing

提供 Single／Long、最近工作、從資源開始；首屏不放 Tools/Library。

### Create / Single

欄位全顯示，以 fieldset／section、required/helper 分組：來源／模式、Prompt、negative、model／尺寸／時長／Steps／Seed／批次。選配降權但不折疊、不採 stepper/Advanced 隱藏。左表單＋右 sticky summary／validation／Generate；右 gating 後到 `/app/jobs/[id]`。

### Create / Long

欄位全顯示分區：故事／來源、continuity／references、planner／timeline、segment review、render setup／review；保留 auto/manual、草稿、分段狀態，右 summary 驗證後提交。

### Jobs／Job detail

Top bar 只放近期 badge/drawer；Jobs 頁提供歷史、篩選、五狀態、取消、重試、詳情、輸出與恢復。

### Library

Library 管理 input/output、搜尋、預覽、下載、刪除、批次；Create picker 只搜尋／最近／預覽／選取並回傳角色。

### Tools

Tools 提供升頻、完整 I2I、進度、取消／重試，結果回 Library。I2I 僅 `/app/tools/image-to-image`、升頻 `/app/tools/upscale`；不做 Create I2I。

### Settings

集中 runtime、provider、模型預設、服務狀態；不承擔生成表單。

## 5. Desktop wireframe

Desktop shell：sidebar + topbar + two-pane；左 fieldsets 全展開，右 sticky summary／preview／validation／Generate；topbar 展開 Job drawer。

```text
[Sidebar: Create | Jobs | Library | Tools | Settings]
[Topbar: status | Job drawer]
┌──────────── Left fieldsets ────────────┐ ┌── Right sticky ──┐
│ Source + mode │ Prompt │ Render settings       │ │ Preview/assets   │
│ Review（全顯示）                                │ │ validation + CTA │
└───────────────────────────────────────────────┘ └──────────────────┘
```

這是欄位分區，不是 stepper；Advanced 不折疊，主 CTA 只在右 summary。

## 6. Mobile 設計（D6 已確認）

375／768px 採單欄、安全 padding、section anchor、sticky CTA；fieldset 仍可見。Picker 用 bottom sheet/dialog，禁止水平溢出。

主導覽採 **固定底部 Bottom Navigation**，使用已確認的視覺稿：

- 五個固定入口：`Create`、`Jobs`、`Library`、`Tools`、`Settings`。
- 每個入口使用 icon + label，保持清楚可辨識，不使用只顯示 icon 的模式。
- active item 使用 accent 色文字與淡色背景區塊；inactive item 使用次要文字色。
- 導覽列固定在內容底部，主內容需預留 bottom nav 空間與 safe-area inset。
- 各 item touch target 至少 44px，視覺稿以約 56px 高度為基準。
- `Tools` 的 Upscale / Image to Image 為 Tools 內部子頁，不新增第六個底部入口。
- 進入子頁時仍保持對應 primary item active，例如 `/app/tools/upscale` 仍高亮 `Tools`。
- Bottom Navigation 只負責 primary navigation；頁面內 action、Generate CTA、Job action 不放入此導覽列。
- 頂部保留頁名與 service/runtime status，不重複放 primary navigation。

## 7. 視覺刷新（D7 已確認）

採 **中度視覺刷新**。保留目前 H3 Studio 的品牌辨識與主要視覺語言，不重新設計整套品牌，也不要求全面 design-token 重寫。

本次統一與改善：

- 卡片層級、border、radius、surface 表現。
- input/select/textarea、label、helper、error 狀態。
- primary／secondary／destructive button 規格與互動狀態。
- 頁面、section、field group 的間距與密度。
- heading、body、helper、metadata 的字級與層級。
- queued／running／complete／error／cancelled 的狀態色與 badge。
- sidebar、top bar、Bottom Navigation 的 active/inactive 視覺一致性。
- focus、hover、disabled、loading 等互動狀態。

保持現有品牌 accent 與整體基調；只有在統一上述元件所需時才新增有限的 semantic tokens，不以全面 design-system 重建為本次目標。

## 8. 驗證與 a11y

空 prompt、缺素材、尺寸無效或不相容 mode 不可提交，欄位與右 gating 說明。Job 統一 queued／running／complete／error／cancelled，顯示進度／ETA、Cancel、Retry，不能只 spinner。表單/draft autosave，離開確認未存。互動 ≥44px、8px、對比 ≥4.5:1、2px focus；heading/label、ARIA、focus trap、鍵盤、reduced motion、無 horizontal scroll。

## 9. 分階段草案（非最終計畫）

D1–D7 已全部確認。下列階段可作為最終實作計畫的基礎，但正式實作前仍需另產最終執行計畫。

1. **Contracts／routes／state**：盤點 API、polling、adapter、domain；交付 mapping，驗收拓撲／draft 不變。
2. **Create**：landing、Single、Long、summary/gating；驗收骨架與必填。
3. **Jobs**：badge/drawer、歷史、detail、取消／重試／恢復；驗收五狀態。
4. **Library／Tools**：picker、Library、Upscale、I2I、回寫；驗收角色化選取。
5. **Responsive／a11y**：四斷點、鍵盤、ARIA、reduced motion、Bottom Navigation；驗收無溢出／44px。
6. **Moderate visual refresh**：在既有品牌基礎上統一卡片、表單、按鈕、間距、字級、狀態與互動視覺；不做全面品牌或 design-system 重製。

## 10. 決策

| ID | 決策／目前選擇 | 替代項 | 狀態 |
|---|---|---|---|
| D1 路由 | 五區獨立 page/route | 單頁錨點 | 已確認 |
| D2 分流 | Single、Long 獨立入口／流程 | 同頁 toggle | 已確認 |
| D3 密度 | 欄位常駐、fieldset/helper、左表單＋右 summary/CTA | stepper／折疊 | 已確認 |
| D4 Jobs | top badge/drawer＋Jobs 頁 | 只留其一 | 已確認 |
| D5 工具/資源 | Create picker、Library 獨立、Tools 含 Upscale＋I2I（不進 Create） | 全塞工作台 | 已確認 |
| D6 mobile nav | 固定 Bottom Navigation；Create / Jobs / Library / Tools / Settings；icon + label；active accent 淡底 | 漢堡／頂部橫向 | 已確認 |
| D7 visual | 中度視覺刷新；保留品牌，統一卡片／表單／按鈕／間距／字級／狀態 | 只改 IA／全面 tokens | 已確認 |

## 11. 成功指標／保持不變

桌面首屏可達 Prompt/右 CTA；mobile Bottom Navigation 無水平溢出、控件 ≥44px；一主 CTA；空 prompt／缺素材不可提交；Jobs 可恢復；picker 回傳 input/output；Tools 輸出在 Library。視覺上保留 H3 Studio 品牌基調，但主要元件與狀態需一致。保持 `/app`、API payload／polling、long draft hydration（`app/page.tsx:1144–1200`）與本機拓撲。下一步為另產最終實作計畫，再取得執行授權。
