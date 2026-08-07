# MiniMax H3 Video Studio 交接進度

更新日期：2026-08-07

## 專案位置

- 網頁專案：`C:\Users\forev\minimax-h3-video-studio`
- MiniMax H3：`C:\Users\forev\minimax-h3-local`
- ComfyUI：`C:\Users\forev\ComfyUI`

## 使用中的網路架構

Tailscale Serve 設定由使用者自行管理，本次不修改 Serve；網頁改回直接使用已開放的 `8787` port：

- 網頁：`0.0.0.0:8787/app`
- `/comfy` → `http://localhost:8188`
- 不恢復獨立 bridge，8787 由網頁服務直接處理頁面與 API

模型服務維持 loopback 綁定：

- ComfyUI：`127.0.0.1:8188`
- Ollama：`127.0.0.1:11434`

網頁服務應監聽 `0.0.0.0:8787`，手機使用主機的已開放 8787 位址加上 `/app`。

## 已完成的內容

- 建立 H3 Studio 網頁專案。
- 建立 Ollama prompt API、H3/ComfyUI 相關 API 與資源瀏覽介面。
- 支援文字生片、參考圖片、影片檔名與資源庫顯示。
- 加入手機 RWD 版面。
- 加入導覽、模式切換、資源選取等非模型互動。
- 前端 API 使用同源 `/app/api/...` 路徑。
- 媒體資源使用 `/app/media/...` 路徑。
- `barry.taile4899e.ts.net` 已加入 Vite allowed host。
- 網頁服務改回直接監聽已開放的 8787 port，不恢復獨立 bridge。
- ComfyUI 設定已改為 loopback 綁定。
- `npm run lint` 曾通過。
- `npm run test` 曾通過，包含 2 項現有測試。
- HTML 與 JavaScript 回應已加入 `Cache-Control: no-store` 並移除 ETag，避免手機使用舊版前端模組。
- 修正 Vinext 在 `/app` 下的 HTML、Flight module 與執行時模組路徑前綴。
- 對 `req.url` 與 `req.originalUrl` 同時套用 `/app` 內部正規化，避免 RSC middleware 還原根路徑。
- 已在 `/app` 與 `/app/` 驗證 200，並以手機尺寸 `390×844` 重新整理確認前端可接管。
- 已驗證非模型互動、`/app/api/health`、`/app/api/assets` 與實際 `/app/media?...` 媒體回應。
- Vite HMR 已移除：`server.hmr`、`server.ws` 與 `server.forwardConsole` 均已關閉，RSC/Vinext browser entry 也不再注入 HMR client。
- 網頁改用直接開放 port 後，手機不再依賴 Tailscale Serve 或 HMR WebSocket；需從可連到 8787 的裝置驗證 `/app`。
- 進一步檢查確認，`@vitejs/plugin-rsc` 的 `virtual:vite-rsc/entry-browser` 與 Vinext `app-browser-entry` 會在模組內加入 `import.meta.hot`；因此只設定 `server.hmr/ws: false` 仍不能完整消除其 HMR 依賴。
- 已加入只針對上述兩個已知瀏覽器入口的前置轉換，沒有修改 `node_modules` 或 Tailscale Serve。
- `npm run lint`、`npm run test` 需在本次 8787/HMR 移除後重新執行。
- 頁面文案已改為功能導向，移除「抓住起點」「畫面性格」等空泛說法；`npm run lint` 與 `npm run test` 均通過。
- 影片尺寸已改為可手動輸入寬度與高度，保留常用尺寸選單；H3 送出前檢查 32 的倍數，影片替換檢查 16 的倍數。
- 提示詞輸入欄、H3 提示詞、負面提示詞與輸出檔名初始為空值；提示詞模型選單已加入 Qwen、Gemma 1/2/3/3n，並顯示 Ollama 安裝狀態。
- 提示詞模型選單已限制寬度並允許長名稱換行，手機版改為滿寬顯示，避免名稱推開產生提示詞按鈕。
- 提示詞模型選單現已只渲染 `/app/api/health` 回報的 Ollama 已安裝模型；未安裝的預設模型不再列出。

## 本次接續已解決的問題

手機重新整理時前端 JavaScript 接管失敗的問題已修正。根因是 Vinext/RSC middleware 使用 `req.originalUrl`，以及 HTML Flight module 參照與執行時模組仍使用根路徑，造成 `/app` 下的模組解析與 React 載入不一致。

目前透過 Tailscale `/app` 路徑時，HTML、entry module、navigation module 與內嵌 Flight module 參照均已統一處理；根路徑仍可正常開發使用。

手機端 Vite HMR 曾先連到 `127.0.0.1:3000` 或根路徑，後來改用 Tailscale WSS `/app`；但閒置連線仍可能被手機或代理關閉，觸發 WebSocket promise rejection，因此目前直接移除 HMR，並改用 8787 直接連線。

這次手機截圖顯示新版頁面已載入，但後續 RSC browser module 又載入了 `/app/@vite/client`。本機已針對該實際 module chain 驗證修正；目前這個工作環境沒有使用者 tailnet 憑證，無法代替手機完成 Tailscale 網址的最後一次實機驗證。

## 目前重要程式設定

`vite.config.ts` 目前包含：

- `listenHost = "127.0.0.1"`
- `listenHost = "0.0.0.0"`
- `webPort = 8787`
- `webBasePath = "/app"`
- `tailscaleHost = "barry.taile4899e.ts.net"`
- `/app` 路徑轉送與 API/media 路徑處理。
- `prefixWebAssetPaths()` 會處理 HTML attribute 與內嵌 Flight module 參照。
- `prefixWebModulePaths()` 會處理 `from/import/export`、`createHotContext`、`BASE_URL` 與 Vinext router base path。
- `stripWebBasePath()` 會容忍並移除重複的 `/app` 前綴。
- Vite HMR、WebSocket 與 browser unhandled-error forwarding 均已關閉；RSC/Vinext browser entry 的 HMR 呼叫由 `disableRemoteDevHmr()` 移除。
- `disableWebCache()` 會對 HTML/JavaScript/API 相關回應停用快取。

`app/page.tsx` 目前使用：

```ts
const BRIDGE_URL = "/app";
```

`next.config.ts` 的 `basePath: "/app"` 曾經測試，但造成 `/app/` 重導迴圈與模組 404，已撤回。不要直接重新加入，除非同步調整目前的自訂 middleware。

## 後續建議

- 維持 ComfyUI 與 Ollama 的 loopback 綁定，不修改 Tailscale Serve 設定。
- 若更新 Vinext/Vite，重新驗證 8787 的 `/app`、entry module 與內嵌 Flight module。
- 仍只在模型服務可用且另行確認後，才測試 Ollama prompt 或影片生成。

## 重要限制

- 不要修改使用者的 Tailscale Serve 設定。
- 不要重新加入獨立 8787 bridge；8787 由網頁服務直接處理。
- 不要把 ComfyUI 或 Ollama 改成對外監聽所有介面。
- 不要在非模型功能測試階段啟動影片生成或 Ollama prompt 生成。
- 本次修正未啟動 Ollama prompt 或影片生成。
