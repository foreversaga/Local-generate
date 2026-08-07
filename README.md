# H3 Studio

本機 MiniMax H3 影片控制介面。網頁服務同時處理 Ollama、ComfyUI、檔案資源與影片生成，直接使用已開放的 `8787` port。

## 啟動

先確認 Ollama 與 ComfyUI 已在本機執行，再啟動網頁：

```powershell
cd C:\Users\forev\minimax-h3-video-studio
npm.cmd run dev
```

## 重啟網頁服務

只需要重啟 H3 Studio Web/API 時，使用專案內的固定腳本：

```powershell
cd C:\Users\forev\minimax-h3-video-studio
.\scripts\restart-web.ps1
```

也可以使用 npm 指令：

```powershell
npm.cmd run restart:web
```

腳本會辨識 `8787` 的現有 H3 Studio process、停止後重新執行 `npm.cmd run dev`，並等待 `/app/api/health` 回傳 `200`。ComfyUI `8188` 與 Ollama `11434` 會沿用現有服務，不需要一併重啟；啟動紀錄會寫入專案的 `logs` 資料夾。

網頁與本機 API 共用 `8787`：

```text
http://<主機 IP 或主機名稱>:8787/app
```

不再需要透過 Tailscale Serve 轉送網頁，也不使用 HMR WebSocket。

## 本機服務

```text
網頁：0.0.0.0:8787
ComfyUI：127.0.0.1:8188
Ollama：127.0.0.1:11434
```

手機請使用主機在網路上已開放的 `8787` 位址；ComfyUI 仍使用既有的 `8188` 服務。

## 功能

- Ollama 產生並可手動修改 H3 提示詞
- 文字生片、參考圖生片、影片替換
- 解析度、秒數、Steps、Seed、模型 profile 設定
- 上傳與預覽圖片、影片、輸出 MP4
- 生成進度、取消工作與歷史紀錄

網頁資源位置：ComfyUI 的 `input` 與 `output` 資料夾；上傳、預覽與生成結果都直接使用這兩個資料夾，不再在 `minimax-h3-local` 內建立副本。
