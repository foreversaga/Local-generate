# Local Generate UI/UX Pro Max 改版計畫

日期：2026-08-28  
基準：`main` @ `db92ba1013934e49a79244afb5074ff26abd96a7`  
實作分支：`agent/ui-ux-pro-max-2026-08-28`

## 1. 目標

本次不是重新做品牌，而是把目前已具備大量功能的 Local Generate / H3 Studio，從「功能都有，但使用者需要理解太多技術細節」提升為「主要任務清楚、進階能力可發現、錯誤可恢復、跨工具體驗一致」的專業工作台。

核心原則：

1. **Task first**：先讓使用者完成「生成 / 繼續工作 / 使用素材」；模型、runtime、技術參數退到第二層。
2. **Progressive disclosure**：常用設定先顯示，專業設定仍可快速到達，但不在第一眼造成負擔。
3. **Recognition over recall**：用任務名稱、品質/速度標籤、素材預覽與狀態提示取代需要記住 profile 名稱與後端規則。
4. **One primary action per context**：每個頁面/區塊只保留一個主要 CTA，避免工具入口、生成入口與設定入口競爭。
5. **Recoverable workflow**：Job、草稿、錯誤、runtime readiness 都必須告訴使用者「現在在哪裡、下一步能做什麼」。
6. **Consistent system**：Create、Jobs、Library、Tools、Settings 共用相同表單、卡片、通知、狀態、空畫面與互動規格。
7. **Accessibility by default**：鍵盤、focus、44px touch target、ARIA、reduced motion、safe area 與無水平溢出視為必要品質，不是後補。

---

## 2. 現況判斷

### 已完成且應保留

目前新版架構已經落實舊版 WebUI 規格的大部分核心決策：

- Desktop 固定 sidebar。
- Mobile 固定五入口 Bottom Navigation。
- `Create / Jobs / Library / Tools / Settings` 已拆 route。
- Single / Long 已分流。
- Jobs 已提供 queued/running/complete/error/cancelled/partial、progress、elapsed、ETA 與 polling。
- Library 已支援 `input` / `output` root、搜尋、資料夾、預覽、批次選取、刪除與上傳。
- Asset picker 已保留 root contract。
- Single Create 已具備 validation、draft、runtime/capability readiness 與提交後導向 Job detail。
- 全域已有明確 focus ring、dark theme semantic color、reduced-motion 部分支援。

因此本次不重做 navigation topology，也不更換 UI framework。

### UI/UX Pro Max 評分（程式碼級審查）

| 面向 | 現況 | 主要問題 |
|---|---:|---|
| 資訊架構 | 7.5/10 | 主導覽已正確，但 Create landing 又把 Tools 拉回主要生成入口，產生 IA 回歸。 |
| 視覺層級 | 7/10 | 品牌與色彩一致，但不同 workspace 自建 CSS，密度、card hierarchy、helper text 規則逐漸分裂。 |
| 任務流程 | 6/10 | Create 功能完整，但模式、profile、LoRA、加速、AI prompt provider 等技術決策太早暴露。 |
| 表單可用性 | 5.5/10 | Single form 約 98 KB；progressive shell 以外部 CSS selector / `:has()` 隱藏內部 DOM，耦合高且難維護。 |
| 狀態與回饋 | 8/10 | Jobs progress/ETA 很完整；Create runtime readiness 仍混在 model 欄位 helper 中，資訊噪音偏高。 |
| 素材體驗 | 7.5/10 | input/output contract 與 preview/focus trap 良好；Library toolbar 與 selection/upload 狀態仍偏操作密集。 |
| Mobile | 7.5/10 | Bottom Nav 與 safe-area 已有；大型工具/設定頁仍需逐頁確認密度與 sticky action。 |
| Accessibility | 6.5/10 | focus ring、dialog focus trap、progressbar 已有；缺 skip link，部分硬編碼 label / aria 文案、disabled 全域視為 wait。 |
| i18n / copy | 5/10 | 新增功能持續出現硬編碼中文；Pose、Video Character、Single Progressive、Library、Settings 等一致性不足。 |
| 前端可維護性 | 4.5/10 | `globals.css` 約 72 KB 且仍保留舊 `.studio-shell` 等樣式；多個 workspace 20–90 KB，視覺與交互規則重複。 |

> 本評分以目前 `main` 原始碼與既有測試/規格為依據。最終視覺驗收仍需在本機 production build 重啟 8787 後實際 Browser 操作。

---

## 3. 已確認的主要問題

### P0-1 — Create landing 資訊架構回歸

目前順序：

`Single / Long → Tools → 從素材開始 → Recent Jobs`

這會讓「生成影片」首頁同時承擔 Tool discovery，增加第一層選擇數，而且與已確認的舊規格「Create 首屏不放 Tools/Library」衝突。

**改為：**

`Single / Long → 最近工作 → 從素材開始`

Tools 保留在 sidebar / mobile nav 的獨立入口，不在 Create 重複曝光。

### P0-2 — Single Create 的 progressive disclosure 實作方式太脆弱

`SingleCreateProgressiveShell.module.css` 目前透過：

- `:global(...)`
- DOM sibling / `nth-of-type`
- `:has(...)`
- 特定 `aria-label` / section id

從外層控制 `SingleCreateForm` 內部顯示。

問題不是 progressive disclosure 本身，而是 **presentation state 與內部 DOM 結構耦合**：只要 form 增加欄位或移動 section，就可能錯藏欄位而沒有 TypeScript 錯誤。

**目標：** disclosure ownership 回到 Single Create domain/component；由 props / section component 明確控制，而不是 CSS 猜 DOM。

### P0-3 — 技術概念太早暴露

Single Create 第一個主要區塊直接提供 7 種 mode；Setup 又暴露：

- NVFP4 / INT8 ConvRot / Ref2VA profile
- ALPHA-T1
- H3 Realism People LoRA
- steps / seed / resolution / batch
- runtime readiness

專業使用者需要這些能力，但一般生成工作不應先理解底層模型架構。

**方向：**

- 第一層以任務分組：`從文字創作`、`從圖片創作`、`參考一致性`、`依動作生成`、`編輯既有影片`。
- 第二層才顯示具體 mode。
- 模型先用 `快速 / 品質 / 參考一致性` 顯示，raw profile name 放 detail/helper。
- Advanced 保留完整技術控制，不刪功能。

### P0-4 — UI 系統逐漸分裂

已有 `AppShell.module.css` / `RoutePage.module.css`，但 `globals.css` 仍保留舊 sidebar/nav/card/form 系統；各 workspace 又自行建立 panel、button、status、field。

後果：

- hover/focus/disabled/loading 規則不一致。
- 新功能容易複製舊 CSS 而不是復用元件。
- 視覺修正需要多檔同步。

**方向：** 不做全面 framework 重寫，先建立有限 shared primitives 與 semantic tokens。

### P1-1 — i18n 與產品文案不一致

8/25 的審查已發現 PoseToImage、Create recent 等缺口；8/27 新增 Video Character / ALPHA-T1 後又增加硬編碼中文。

本次要把 i18n 視為 UI contract，而不是最後翻譯。

### P1-2 — runtime / service 資訊位置不理想

Create 中每個 model/profile 會帶大量技術 helper，Settings 又有完整 service status，topbar 也有 status link。

**目標：**

- Create 只顯示「可生成 / 缺少依賴 / 服務離線」與可行下一步。
- 詳細 node/model/service 診斷集中 Settings / status detail。
- 正常狀態不要占據主要視覺高度；異常才升級。

### P1-3 — Jobs 很完整，但缺「下一步」層級

Jobs 已有 progress/ETA，是目前體驗最成熟的區域。後續應補：

- 完成工作直接突出 Preview / Open output。
- 錯誤工作突出 Retry / 修正來源。
- Running 工作突出 Cancel / ETA。
- metadata、source、id 降為次要資訊。

### P1-4 — Tools 首頁需要按使用意圖分組

目前 6 張卡片平鋪：Upscale、Text to Image、Image to Image、Pose to Image、LoRA Trainer、Video Character。

建議分成：

- **Create Images**：Text to Image、Pose to Image。
- **Edit / Enhance**：Image to Image、Upscale、Video Character。
- **Train**：LoRA Trainer。

保留 route，不改 API。

### P2 — Library / Settings 專業工作台化

Library：

- toolbar action 隨狀態切換時應 sticky / predictable。
- breadcrumbs、selection、upload destination 應更清晰。
- scripts 與 media 可維持同頁，但 hierarchy 需更明確。

Settings：

- 預設只顯示 runtime choice、核心服務狀態、prompt provider。
- URL、VRAM、model diagnostics 收在 Technical details。
- 不把 health dashboard 當一般使用者第一層內容。

---

## 4. 目標資訊架構

```text
H3 Studio
├─ Create
│  ├─ Single
│  └─ Long
├─ Jobs
├─ Library
├─ Tools
│  ├─ Create Images
│  │  ├─ Text to Image
│  │  └─ Pose to Image
│  ├─ Edit / Enhance
│  │  ├─ Image to Image
│  │  ├─ Upscale
│  │  └─ Video Character
│  └─ Train
│     └─ LoRA Trainer
└─ Settings
```

Primary nav **不變**。Tools 的分組只存在 Tools landing，避免增加 primary navigation 層級。

---

## 5. Single Create 目標操作流程

### 基礎流程

1. **選擇目的**：文字、圖片、參考一致性、動作參考、影片編輯。
2. **放入素材**：只顯示該目的需要的 asset slots。
3. **描述想要的結果**：brief → AI prompt assistant / manual prompt。
4. **快速品質設定**：`快速 / 平衡 / 品質`；duration。
5. **Review & Generate**：只顯示 blocking 問題與最重要 summary。

### 專業設定

由單一 `專業設定` 入口展開：

- raw model profile
- acceleration
- LoRA
- resolution
- steps
- seed
- batch
- prompt provider/model/reasoning
- reference preprocessing

進階值只要與預設不同，重新進頁時自動保持展開。

### 禁止事項

- 不刪除現有 mode / profile / LoRA 功能。
- 不改 API payload。
- 不在 CSS 外層用 DOM 結構 selector 控制 form domain state。
- 不把失敗 validation 藏在 collapsed section。

---

## 6. 視覺系統改進

新增有限 semantic layer，不全面重寫品牌：

### Tokens

- spacing: `--space-1 ... --space-8`
- radius: `--radius-sm / md / lg`
- status: success / info / warning / danger
- control heights: 36 / 44 / 52
- surface: base / raised / interactive / selected

### Shared primitives

優先抽出：

- `WorkspaceHeader`
- `SectionCard`
- `FieldGroup`
- `SegmentedControl`
- `StatusBadge`
- `InlineNotice`
- `EmptyState`
- `Disclosure`
- `ActionBar`

原則：只有兩個以上 workspace 真正重複使用時才抽共用元件，避免為 design system 而 design system。

---

## 7. Accessibility / interaction acceptance

- 加入 skip-to-content。
- 主內容有穩定 `main` target。
- 所有 interactive target ≥ 44px（例外：純 inline link）。
- `disabled` 不等於 loading；只有執行中狀態顯示 wait/progress semantics。
- 鍵盤可到達所有主要 action。
- dialog / bottom sheet focus trap 與 return focus。
- field error 用 `aria-describedby`；error summary 可 focus 並能跳到欄位。
- loading 使用 skeleton / status，而不是 layout jump。
- `prefers-reduced-motion` 無必要 transition。
- 320 / 375 / 768 / 1024 / 1440 無 horizontal overflow。

---

## 8. 實作階段

### Phase 0 — 入口與共用殼層（本分支第一批）

高影響、低風險，不改 API：

1. Create landing 移除 Tools teaser。
2. Recent Jobs 移到 From Asset 前，恢復「主要任務 → 繼續工作 → 替代入口」。
3. recent eyebrow/title 分離。
4. AppShell 加 skip link / main anchor。
5. 修正全域 disabled cursor semantics。
6. 新增最基本 UI regression tests。

### Phase 1 — Single Create 認知負荷

1. 把 mode 做任務分組。
2. 將五個 optional switches 收斂成明確的 Basic / Pro disclosure。
3. disclosure state 移進 form/section API，移除 fragile `:has()` / `nth-of-type` 控制。
4. runtime readiness 改成 compact status notice。
5. model profile 顯示人類可理解的速度/品質標籤。
6. 保留所有既有 request contract。

### Phase 2 — Shared UI primitives + i18n

1. 建立最小 primitives。
2. Create / Jobs / Tools 先遷移。
3. Pose / Video Character / Settings / Library 補 i18n。
4. 加 key parity / hardcoded UI text guard。

### Phase 3 — Jobs / Tools / Library / Settings

1. Job state-specific primary action。
2. Tools intention grouping。
3. Library sticky selection/action state。
4. Settings normal vs technical details。

### Phase 4 — Responsive / a11y / polish

Browser matrix、keyboard、screen-reader labels、reduced motion、empty/loading/error state、copy review。

---

## 9. 測試與驗收

### Static / unit

- route/navigation tests
- create landing content ordering
- Single Create disclosure state
- validation auto-reveal
- i18n key parity
- asset root contract (`input` / `output`)
- no request payload regression

### Browser

Desktop: 1440 / 1024  
Tablet: 768  
Mobile: 375 / 320

Scenario：

1. T2V 新工作。
2. I2V 從 input 圖片。
3. I2V 從 output 圖片。
4. Ref2V 多圖。
5. Motion reference。
6. Video replace。
7. validation error → focus → recovery。
8. job running → complete / error。
9. library preview / selection / upload。
10. keyboard-only navigation。

依專案規則，程式碼改動完成後最終驗收需要：production build → 重啟 8787 → health check → Browser 實際操作。

---

## 10. `minimax-workflow` 依賴判斷

### 本輪結論：**目前不需要新增 workflow API，因此不建立 workflow 分支。**

理由：

- Job 已有 progress / elapsed / ETA。
- Single Create 已有 mode/profile/acceleration capability readiness。
- Library 已有 input/output asset contract。
- 現有生成 request 已能表達所有本輪 UX 所需操作。
- 本輪重點是資訊層級、component ownership、copy、layout 與 accessibility，不需要改模型 runner。

### 何時才需要開 workflow 分支

若後續決定把以下資料從前端 hardcode 改為 workflow 自我描述，才建立：

`agent/ui-ux-capability-catalog-<date>`

候選 contract：

```json
{
  "workflows": [
    {
      "id": "i2v",
      "profiles": [
        {
          "id": "nvfp4_blackwell",
          "label": "Fast",
          "qualityTier": "balanced",
          "speedTier": "fast",
          "recommended": {
            "width": 736,
            "height": 416,
            "steps": 20
          }
        }
      ]
    }
  ]
}
```

只有當 UI 確定要依 runtime/workflow 動態渲染 profile catalogue 時再做，避免為 UI 改版建立沒有消費者的 API。

---

## 11. Definition of Done

- Create 第一層沒有 Tools 重複入口。
- 使用者不需要知道 NVFP4 / ConvRot 才能完成一次生成。
- Pro 使用者仍能到達所有原本參數。
- Single disclosure 不依賴外層 CSS 猜內部 DOM。
- 正常 runtime state 不占用大量表單空間；異常有明確修復方向。
- Create / Jobs / Tools / Library / Settings 的卡片、field、status、action hierarchy 一致。
- 主要流程支援繁中 / 英文，不再新增硬編碼 UI copy。
- 320–1440px 無水平溢出。
- keyboard / focus / error recovery 通過。
- 現有 API payload、asset root contract、job lifecycle 不回歸。
