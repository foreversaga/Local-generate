# MiniMax H3 Studio Agent Instructions

本檔案是 `C:\Users\forev\minimax-h3-video-studio` 的專案層級代理規則。涉及執行時驗證、影片生成或本機服務時，依照下列文件與啟動方式操作：

- `README.md`
- `C:\Users\forev\minimax-h3-local\README.md`
- `C:\Users\forev\minimax-h3-local\scripts\start-comfyui.ps1`
- `C:\Users\forev\minimax-h3-local\config\runtime.low-vram.json`
- `vite.config.ts`
- `local-bridge.mjs`

## 服務拓撲

- **H3 Studio Web/API**：本專案，監聽 `0.0.0.0:8787`，入口為 `/app`。
- **ComfyUI**：`C:\Users\forev\ComfyUI`，只監聽 `127.0.0.1:8188`。
- **MiniMax H3 本地專案**：`C:\Users\forev\minimax-h3-local`；其產生器透過 ComfyUI HTTP/WebSocket API 執行，不直接載入模型。
- **Ollama**：`127.0.0.1:11434`，供 H3 Studio 的提示詞整理功能使用。

保持 ComfyUI 與 Ollama 的 loopback 綁定，不把它們改成 `0.0.0.0`，也不要為了遠端存取修改 Tailscale Serve。對外使用的是 Web 的 `8787` port。

## 標準啟動順序

只在任務需要執行時驗證、預覽或生成影片時啟動服務；靜態檢查與純程式碼修改不必啟動模型服務。啟動前先檢查既有服務，若已可用就重用，不要建立第二個實例。

### 1. 啟動或重用 ComfyUI

在 PowerShell 執行：

```powershell
Set-Location C:\Users\forev\minimax-h3-local
.\scripts\start-comfyui.ps1 -Profile low-vram -Background
```

規則：

- `start-comfyui.ps1` 會使用 `C:\Users\forev\ComfyUI\venv\Scripts\python.exe` 與 `ComfyUI\main.py`。
- 預設使用 `low-vram` profile、`127.0.0.1:8188`、動態 VRAM/CPU offload 與 2 GB VRAM 保留。
- 只有在使用者明確要求品質模式時，才改用 `-Profile quality`。
- 這個腳本會先檢查 `8188` 是否已有 listener；已啟動時直接重用。
- 背景啟動的 stdout/stderr 會寫入 `C:\Users\forev\minimax-h3-local\logs`。
- 健康檢查：

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:8188/system_stats -UseBasicParsing -TimeoutSec 5
```

不要以全域 Python 或任意 Python 環境直接取代上述腳本，也不要在未確認需求時執行安裝、下載模型或 smoke test。

### 2. 啟動 H3 Studio Web/API

在本專案根目錄執行：

```powershell
Set-Location C:\Users\forev\minimax-h3-video-studio
npm.cmd run dev
```

規則：

- Web 使用 `0.0.0.0:8787`，本機網址為 `http://127.0.0.1:8787/app`；遠端裝置使用主機可連線的 IP 或主機名稱加 `/app`。
- Web 與本機 API 共用同一個 `8787` process；`local-bridge.mjs` 是被 Vite/Vinext 掛載的 route，不是獨立服務。
- 不要執行 `node local-bridge.mjs`、`npm run bridge`，也不要新增獨立 bridge launcher。
- 不要恢復 HMR WebSocket 或要求 Tailscale Serve 轉送 Web；目前設定已停用 HMR/WS。
- 健康檢查：

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:8787/app/api/health -UseBasicParsing -TimeoutSec 10
```

### 3. Ollama（需要提示詞整理時）

README 只要求 Ollama 在本機執行；需要使用提示詞整理功能時，先檢查：

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:11434/api/tags -UseBasicParsing -TimeoutSec 5
```

若服務未啟動且任務明確需要它，使用本機既有的 Ollama 啟動方式（通常為 `ollama serve`），不要修改 `OLLAMA_URL` 或對外開放 Ollama port。

## 停止與安全規則

- 前景服務以 `Ctrl+C` 停止；不要用模糊的 process name 或廣泛的 `Stop-Process` 終止使用者可能正在使用的服務。
- 不要為了啟動新實例而殺掉已在 `8188` 或 `8787` 執行的服務；先重用、診斷，必要時再請使用者確認。
- 不要修改 `C:\Users\forev\ComfyUI` 的模型、custom nodes、binding 或設定，除非任務明確要求。
- 不要在例行驗證時下載模型、改動 Hugging Face token、啟動正式影片生成或刪除輸出檔。

## 驗證命令

服務啟動後，依序確認：

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:8188/system_stats -UseBasicParsing -TimeoutSec 5
Invoke-WebRequest -Uri http://127.0.0.1:11434/api/tags -UseBasicParsing -TimeoutSec 5
Invoke-WebRequest -Uri http://127.0.0.1:8787/app/api/health -UseBasicParsing -TimeoutSec 10
```

只有當任務要求模型或生成流程驗證時，才使用 `C:\Users\forev\minimax-h3-local\scripts\run-smoke-test.ps1`；執行前先確認使用者允許模型運算與輸出檔案變更。
