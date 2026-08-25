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

日常使用預設啟動既有 production build；程式碼變更完成後先執行一次 build，再由固定重啟腳本啟動：

```powershell
Set-Location C:\Users\forev\minimax-h3-video-studio
npm.cmd run build
npm.cmd run restart:web
```

規則：

- Web 使用 `0.0.0.0:8787`，本機網址為 `http://127.0.0.1:8787/app`；遠端裝置使用主機可連線的 IP 或主機名稱加 `/app`。
- Web 與本機 API 共用同一個 `8787` process；`local-bridge.mjs` 是被 Vite/Vinext 掛載的 route，不是獨立服務。
- `npm.cmd run restart:web` 預設使用 `server/production-web.mjs` 啟動既有 Vinext production build，並在同一個正式入口掛載 `/app` 與本機 API；只有主動開發時才使用 `npm.cmd run restart:web:dev`。
- production build 不存在時必須明確失敗，不得自動 fallback 到 development mode，也不得用臨時背景啟動器繞過。
- 重啟 H3 Studio Web/API（`8787`）只能由主對話／主代理親自執行，禁止委派給子代理；此規則優先於一般的操作委派規則。
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

## Git commit privilege rule

- For an explicitly authorized local commit on Windows, run the `.git`-writing portion (`git add` and `git commit`) with `sandbox_permissions: "require_escalated"` by default, using a narrow justification for the requested commit.
- Keep the staged path list explicit; never include `.worktrees/` or other unreviewed files merely because elevated access is being used.
- This rule does not authorize `push`, `pull`, remote writes, service restarts, or any other operation beyond the user-requested local commit.

## 需求範圍限制（強制）

- 只允許執行完成使用者當回合明示需求所必需的探索、修改、操作與驗證；不得自行擴張目標或把相鄰改善視為已授權。
- 禁止未經使用者明確同意而進行非必要的重構、最佳化、清理、改寫、技術替換、導覽／互動邏輯變更、UI 調整、依賴更新或其他順手修改，即使代理認為能改善體驗、品質或維護性也一樣。
- 修正問題時採用最小必要變更，保留與需求無關的既有架構、行為與檔案；不得為了繞過問題而更換另一個未被要求的子系統或既有流程。
- 若判斷必須修改需求範圍外的項目才能安全完成，必須先停止該項操作，向使用者說明具體原因、預計影響的檔案／行為與替代方案，並取得明確同意後才可執行。
- 測試、build、重啟與驗收只授權為本次必要變更提供證據，不得藉驗證之名修改其他功能或擴大實作範圍。

## UI 數字欄位規則（強制）

- 所有數字輸入欄位在使用者編輯時必須允許空字串，不得在使用者刪除內容後立即強制回填 `0`。
- 不得以 `value={Number(value) || 0}` 或其他會在 `onChange` 階段將空值轉為 `0` 的方式綁定數字欄位。
- 編輯期間以字串 state 保留使用者輸入；有效數字、範圍、必填與預設值的驗證或正規化，改在失焦或送出時處理。

## 子代理使用規則

- 主代理預設直接處理所有任務，包括探索、操作、驗證與回報。
- 只有使用者在當回合明確要求使用子代理、Luna、委派或平行代理時，才可建立或使用子代理；主代理須先界定範圍、ownership、限制與驗收條件。
- 使用者明確要求子代理時，密切相關的後續工作應重用同一 Luna（例如 `followup_task`）；只有真正獨立、ownership 不衝突且可獨立驗收的工作才建立新的 Luna。
- 功能完成後執行一次 Browser 與完整 quality gate，除非不可替代的前置執行時證據需要更早檢查；簡單狀態查詢或短答不因形式而啟動 Browser 或完整測試。
- 同一 parent task 的 production build（或等價完整 build）最多執行一次，且只由所有模組變更完成後的 final integration verifier 執行；若有明確授權的子代理，child task 與平行 Luna 不得自行 build，除非使用者另行明確要求，並且不得平行 build。
- 若使用子代理，child tasks 優先執行 targeted tests 與 lint；TypeScript checks 可依成本集中處理，production build 仍維持單一 final integration check。

## 變更後重啟與驗收（強制）

- 任何程式碼、設定、路由或服務行為改動後，無論開發伺服器是否支援 HMR，都不得在未重啟受影響服務前回報完成。
- 本專案的 Web/API 改動一律重啟 `8787` 的 H3 Studio Web/API 服務；若改動涉及 ComfyUI 或 Ollama，也必須重啟相應服務。重啟時只能操作明確對應的服務程序，不得使用模糊的全域 process name。
- 重啟後必須重新執行受影響服務的 health check，並依風險執行必要的 targeted tests、完整測試、lint 或 build。
- UI 或使用者流程改動必須在重啟後用 Browser 實際操作驗收；涉及素材、上傳、選取或資料夾流程時，必須確認成功結果與實際 API／檔案狀態。
- 只要重啟、health check、必要測試或 Browser 驗收任一項尚未完成，不得對使用者宣稱「完成」；應明確回報尚未完成的驗收項目。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Local-generate** (5251 symbols, 14168 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/Local-generate/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Local-generate/clusters` | All functional areas |
| `gitnexus://repo/Local-generate/processes` | All execution flows |
| `gitnexus://repo/Local-generate/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
