# UI 缺漏分析與改善進度

更新日期:2026-08-25(主代理持續更新中)
狀態:**Step 2 程式碼級審查接近完成**;實作(Step 5)尚未開始

## 任務來源

- 用戶指示(2026-08-25):「分析目前 ui 還缺漏或是可以改善的地方,需要改善的話由主代理規劃計畫並驗證,子代理實作。」
- 分工:**主代理規劃+驗證,子代理實作**。
- 用戶偏好:一律正體中文;探索優先用內建工具(read_file/search_files/browser_exec);計畫/文檔若已標記「完成」不要當依據,以實際狀態(跑起來的 UI、程式碼、測試輸出)為準。

## 目前環境狀態(實測)

| 項目 | 狀態 | 證據 |
|---|---|---|
| Git | `main`,clean tree,領先 `origin/main`(`c8183b6`)4 個 commits | `git status` |
| 最新 commit | `d62194a` 移除 FLUX.2 Dev + H3 latent upscale,收斂到 Klein 9B + SeedVR2(08-24 22:44) | `git log` |
| 8787 production-web | 存活(PID 1156446,啟動 08-24 21:49);**build 比 HEAD 舊**(dist/ 08-24 21:49 < commit 08-24 22:44) | curl health 200、process 啟動時間 |
| ComfyUI 8188 | 200 | curl |
| Ollama 11434 | offline | curl |
| SGLang | online(`http://100.82.76.80:8003/v1`,Qwen3.8-27B-Unleashed-UD-IQ3_XXS.gguf);容器 `local-ornith15-35b-a3b-nvfp4-sglang` Up healthy | curl + docker ps |
| 測試 | **520/520 passing**(2026-08-25 執行) | `node --import ./tests/test-isolation.mjs --test --test-concurrency=1 tests/*.test.mjs` |

注意:8787 跑的 build 比最新 commit 舊 → 瀏覽器看到的可能不是最新 UI;實作後必須重新 build + 重啟 8787(重啟只有主代理可做)。

## 任務清單

1. ✅ 探索專案結構(routes、components、docs、tests)
2. 🔄 找出 UI 缺漏/可改善點(程式碼級審查完成;瀏覽器實機檢視被 Chrome remote-debugging 手動批准擋住,多次 retry 未過)
3. ⏳ 彙整缺漏清單 + 優先級排序(主代理)
4. ⏳ 主代理規劃改善計畫
5. ⏳ 子代理實作
6. ⏳ 主代理驗證(health check + browser 驗收)

## 已確認的 UI 缺漏(全部有程式碼證據)

### A. i18n 缺口(最大問題)

1. **PoseToImageWorkspace.tsx 完全沒有 i18n**(`app/components/tools/PoseToImageWorkspace.tsx`,0 個 `useI18n`/`t()` 呼叫,全檔硬編碼中文)
2. **pose-to-image 路由頁硬編碼**(`app/(studio)/tools/pose-to-image/page.tsx`):`eyebrowText="工具 / OpenPose"`、`titleText="OpenPose 骨架生圖"`、`descriptionText="上傳人物圖片自動擷取 DWPose 骨架…"` 全部直寫字串,其他 4 個 tools 卡片都用 i18n keys
3. **tools 索引頁 pose 卡片硬編碼**(`app/(studio)/tools/page.tsx` line 34-35):`titleText="OpenPose 骨架生圖"`、`descriptionText=...` 直寫;其他卡片(01/UPSCALE、02/TEXT TO IMAGE、03/IMAGE TO IMAGE、05/LORA TRAINER)都用 `tools.upscale.title` 等 i18n keys
4. **全域硬編碼中文**:常用中文字詞搜尋(請|請選擇|請輸入|無法|失敗|成功|載入|新增|刪除|儲存|設定)在 `app/**/*.tsx` 有 **80 matches**(grep 的 Unicode range 不支援,改用逐詞搜尋)

### B. 死 i18n keys(FLUX.2 Dev 已移除但 keys 未清)

- `dictionaries.ts` 仍有 `model.dev` 相關 **5 處**(`text2img.model.dev.name`/`.note`/`.license`/`.warning`)
- `app/**/*.tsx` 中 `model.dev` = **0 matches** → 全是 dead keys
- 背景:最新 commit `d62194a` 已把 FLUX.2 Dev 從 TSX 移除,但 dictionaries 未同步清理

### C. i18n key 誤用

- `CreateLanding.tsx` line 81:`<span>{t("create.recent")}</span><h2>{t("create.recent")}</h2>` — eyebrow 與標題用同一個 key,應分成兩個不同的 key

### D. hardcoded model 字串

- `nature-camera` 在 app 中 **3 處** hardcode(其中 `TextToImageWorkspace.tsx` line 421 `<small>{promptModel} · nature-camera</small>`);`text2img.assistant.ready` 的字典值也直接內嵌「nature-camera」(zh: "nature-camera 已就緒",en: "nature-camera ready")
- 若 prompt model 名稱未來改變(例如換模型),這些字串要手動同步

### E. 其他小問題

- **console.log**:app/ 下 0 個 ✅(乾淨)
- **TODO/FIXME/HACK 標記**:app/ 下 39 個(多數是 status text,非真正未完成)
- **LanguageSwitcher**:選項已確認 = `zh-TW`(繁中)+ `en`(EN),2 個選項,行為正常
- **i18n 測試守衛**:`tests/i18n-navigation.test.mjs` 只測 locale persistence,**沒有** key 覆蓋/parity 測試 → 死 keys 與 pose 漏 i18n 都沒被測試抓到

### F. 環境/流程缺漏

- 8787 跑的 build 舊於 HEAD → 需要 build+重啟流程(實作後一起做)
- Ollama offline → prompt assistant 的 Ollama 路徑無法實測(SGLang 路徑可測)

## 檔案清單(與缺漏相關)

| 檔案 | 角色 |
|---|---|
| `app/components/tools/PoseToImageWorkspace.tsx` | pose-to-image 主組件,**無 i18n** |
| `app/(studio)/tools/pose-to-image/page.tsx` | pose 路由頁,hardcoded 字串 |
| `app/(studio)/tools/page.tsx` | tools 索引,pose 卡片 hardcoded |
| `app/components/create/CreateLanding.tsx` | create landing,`create.recent` key 誤用 |
| `app/components/tools/TextToImageWorkspace.tsx` | text2img 主組件,nature-camera hardcoded |
| `app/i18n/dictionaries.ts` | i18n 字典,5 個 dead `model.dev` keys |
| `app/i18n/I18nProvider.tsx` | i18n provider(cookie persistence) |
| `tests/i18n-navigation.test.mjs` | i18n 測試(僅測 persistence) |
| `app/components/shell/LanguageSwitcher.tsx` | 語言切換(zh-TW/en,OK) |

## 下一步(待用戶確認優先級)

1. **P0**:PoseToImageWorkspace i18n 化 + pose 路由/卡片頁 i18n keys(3 檔)
2. **P1**:清 dictionaries 死 keys(5 個)+ `create.recent` 拆 key + nature-camera 字串集中化
3. **P2**:全域硬編碼中文 i18n 化(80 matches,工作量大,可分批)
4. **P3**:補 i18n 測試守衛(key parity 檢查,防再漏)
5. 最後:build + 重啟 8787 + browser 驗收 + 完整測試

## 阻塞點

- **Chrome remote-debugging 手動批准**:browser_exec 多次 retry 都要手動在 Chrome popup 點「允許」;程式碼級審查可先做,最終 browser 驗收需要用戶協助批准(或改用 headless)
- **grep Unicode**:`[\u4e00-\u9fff]` 與 `\p{Han}` 在系統 grep 不支援,用逐詞搜尋替代
