# H3 Studio

## 語言

Studio 介面支援繁體中文（`zh-TW`，預設）與英文（`en`）。可使用頂端列的語言選擇器切換；選擇會以 `h3-studio.locale` 同時儲存在瀏覽器 `localStorage` 與同站 Cookie，讓伺服器在後續造訪的第一幀就輸出已選語系，並同步更新文件的 `lang` 屬性。語言只影響顯示文字，不會改變 API 路由、工作狀態值、來源識別碼或 bridge payload。

介面翻譯集中在 [`app/i18n/dictionaries.ts`](app/i18n/dictionaries.ts)。新增 shell 或工作流程顯示文字時，需同時補上兩種語言的相同 key，client component 透過 `useI18n()` 取得翻譯。共用的後端狀態／來源標籤則由 [`app/lib/ui-copy.mjs`](app/lib/ui-copy.mjs) 接收選用的 locale。

- [WebUI 功能說明](docs/webui-functions.md)
- [English](README.md)

H3 Studio 是本機 MiniMax H3 影片控制介面。網頁服務透過 `/app` 入口協調 Ollama、ComfyUI、媒體素材與影片生成。

公開入口 `/app` 會顯示 Create landing；Single、Long、Jobs、Library、Tools 與 Settings 由同一個 Studio shell 提供，所有流程共用既有的 `/app/api/...` bridge contract。

## 本機設定

請在專案根目錄執行：

```powershell
Copy-Item .env.example .env.local
```

如果 `.env.local` 已存在，請只將缺少的變數名稱合併進去，不要覆寫本機路徑或秘密。

再依目前機器填寫 `.env.local` 的路徑與服務端點。`.env.local` 必須留在版本控制之外；提交的 `.env.example` 只包含空值、loopback 預設值與安全 placeholder。

重要路徑設定如下：

- `MINIMAX_H3_ROOT` 是 `scripts/vast/start-local-runtime.ps1` 必填的本機 `minimax-h3-local` 專案路徑。
- `MINIMAX_H3_PYTHON` 是 `scripts/vast/start-vast-remote.ps1` 必填的 Python 執行檔路徑，也可以是 `PATH` 上可執行的命令。
- 如果 ComfyUI 與本 repository 不在預設的相鄰位置，可用 `COMFYUI_ROOT` 與 `MINIMAX_H3_ROOT` 覆寫 bridge 的預設路徑。
- `VLLM_URL`、`VLLM_API_KEY` 與 `VLLM_PROMPT_MODEL` 用來設定 Docker vLLM 的 OpenAI 相容提示詞服務；既有 `SGLANG_*` 名稱仍可作為遷移備援。
- 如果 `ffmpeg` 與 `ffprobe` 不在 `PATH`，長影片媒體處理才需要設定 `FFMPEG_PATH` 與 `FFPROBE_PATH`。

不要把 credentials、API key、SSH key、模型 token 或 provider secret 放入 `.env.example`。真實秘密請放在本機被忽略的檔案或部署 provider 的 secret store。Vast 實際連線檔也只應留在本機：將 `scripts/vast/vast-runtime.config.example.json` 複製為 `scripts/vast/vast-runtime.config.json`，再填入 instance host、SSH port、user 與 tunnel ports；實際檔案已由 Git 忽略。

## Vast RTX 5090 遠端模式

Vast runtime 只透過 loopback SSH forward 連線，ComfyUI 與 Ollama 不會直接暴露到網際網路。instance-specific host、SSH port、tunnel ports 與 optional persistent-volume 設定放在被忽略的 runtime config；可重現的軟體 inventory 則版本化在 [`scripts/vast/runtime-manifest.json`](scripts/vast/runtime-manifest.json)。

### 新增或替換 instance

1. 以所需 GPU 建立 Vast instance。如果有 persistent storage，請掛載到 `/workspace`（manifest 也會保留 `/workspace/.h3-runtime-cache` 作為模型快取）；沒有 persistent storage 時，bootstrap 會從 pinned sources 重新建立。
2. 將 bootstrap bundle 與 manifest 複製到 instance，然後執行一次性 bootstrap 指令：

   ```powershell
   $VastHost = '<VAST_HOST>'
   $SshPort = [int]'<SSH_PORT>'
   $Remote = "root@$VastHost"
   $Files = @(
     'scripts/vast/h3-bootstrap.sh',
     'scripts/vast/runtime-manifest.json',
     'scripts/vast/runtime-status.sh',
     'scripts/vast/ollama.sh',
     'scripts/vast/ollama.conf'
   )
   scp.exe -P $SshPort @Files ("{0}:/workspace/" -f $Remote)
   ssh.exe -p $SshPort $Remote 'chmod 0755 /workspace/h3-bootstrap.sh /workspace/runtime-status.sh && /workspace/h3-bootstrap.sh'
   ```

   Bootstrap 具備 idempotency：已驗證的模型與 pinned Git checkout 會重用；遺失或不相符的 artifact 會先隔離，再從 persistent cache 或 staging 還原，最後以 atomic install 完成。只有 health check 成功後才會寫入 `/workspace/.h3-runtime-state.json`。
3. 第一次建立本機連線檔，之後 Vast 替換 instance 時只更新這個檔案：

   ```powershell
   Copy-Item scripts/vast/vast-runtime.config.example.json scripts/vast/vast-runtime.config.json
   # 在複製出的檔案設定 instance.host、instance.sshPort、instance.user 與 tunnel ports。
   ```

   如果要放在其他位置，可在 `.env.local` 設定 `VAST_RUNTIME_CONFIG`，或傳入 `-ConfigPath`。
4. 啟動 tunnel 與 Web/API，再檢查 health 與 drift：

   ```powershell
   .\scripts\vast\start-vast-remote.ps1
   .\scripts\vast\status.ps1
   ```

   `status.ps1` 會回報 loopback tunnel health、H3 Studio health、manifest version、native-node availability、遺失或 checksum 不符的權重、Git revision drift、Ollama model drift，以及 persistent-cache/state 是否存在。需要修復時會以 code `1` 結束。

Launcher 會把設定好的 local tunnel port forward 到遠端 ComfyUI/Ollama，接著以 Vast runtime 啟動 `http://127.0.0.1:8787/app`。WebUI 的 **MODEL RUNTIME** 控制可以在本機服務（`8188`／`11434`）與 Vast 之間切換。生成或 upscaling 進行中時會拒絕切換；安全時 bridge 會檢查或啟動選定服務，並釋放離開 runtime 上已載入的模型。輸入素材保留在本機 media library；每次遠端 workflow 會上傳所需素材，完成品再下載回本機 output library。

遠端 prompt generation 預設使用 `hf.co/HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP:Q4_K_M`；仍可選用 `huihui_ai/qwen3-vl-abliterated:32b-instruct-q4_K_M`。兩個模型都支援文字與圖片 prompt。Ollama inference 前 bridge 會卸載 ComfyUI 模型；影片生成前會卸載使用中的 Ollama 模型。Ollama request 使用 8192-token context 與 `keep_alive: 0`。

影片工作被接受前發生的 prompt-generation failure 與 H3 validation failure，會附加到 `logs/prompt-errors-YYYYMMDD.jsonl`。每筆記錄包含問題 prompt、validation/API error、model、mode、duration、runtime 與 timestamp；附件圖片資料永遠不會寫入這個 log。

遠端 instance 設計上是 disposable。Persistent `/workspace` volume 非必要，但可透過 `.h3-runtime-cache` 加快恢復；沒有 volume 時，pinned manifest 與 bootstrap command 是唯一依據。本機 Library 檔案與 job metadata 保留在本機，不會只依賴 Vast 上的 provenance。

## 長影片工作與診斷

長影片 draft 與 job 會保存於 `data/jobs/<sequence-id>/`。每個 job 有 atomic `job.json`、segment files，以及 append-only `events.jsonl`；事件包含 generation、ffprobe/ffmpeg、assembly、API start 與 restart-recovery。每日摘要寫入 `logs/long-video-YYYYMMDD.jsonl`；log 會記錄 command exit code 與最後的 stderr bytes，但不會記錄 token、base64 media 或重複的完整 prompt。如果 executable 不在 `PATH`，請設定 `FFMPEG_PATH` 與 `FFPROBE_PATH`。Sequence output folder 只會配置在 `ComfyUI/output` 下；如果資料夾已存在，會回傳 `OUTPUT_FOLDER_EXISTS`。

Continuation prompt finalization 在 runner 中提供可注入的 `finalizePrompt` seam。從 segment 2 開始，bridge 會暫時把 normalized previous tail image 傳給選定的 vision-capable Ollama model；request、timeout、unsafe-tail 與 validation failure 會使用保留 continuity 的 deterministic fallback，並記錄 provider/model/fallback provenance，但不會保存圖片 bytes。

## 啟動網頁服務

設定好 `.env.local` 後，可以重用已健康的本機 Ollama 與 ComfyUI，或使用本機 runtime helper：

```powershell
.\scripts\vast\start-local-runtime.ps1
```

接著從專案根目錄啟動 Web/API：

```powershell
Set-Location '<PROJECT_ROOT>'
npm.cmd run dev
```

## 重啟網頁服務

只需要重啟 H3 Studio Web/API 時，使用專案內固定腳本：

```powershell
Set-Location '<PROJECT_ROOT>'
.\scripts\restart-web.ps1
```

也可以使用 npm 指令：

```powershell
npm.cmd run restart:web
```

腳本會辨識 `8787` 上現有的 H3 Studio process、停止後重新執行 `npm.cmd run dev`，並等待 `/app/api/health` 回傳 `200`。ComfyUI `8188` 與 Ollama `11434` 會沿用現有服務，不需要一併重啟；啟動紀錄會寫入專案的 `logs` 資料夾。

## 本機服務

```text
Web/API：0.0.0.0:8787
ComfyUI：127.0.0.1:8188
Ollama：127.0.0.1:11434
```

手機或其他 client 請使用主機對外開放的 `8787` 位址；ComfyUI 仍使用既有的 loopback service。

Web/API 不需要透過 Tailscale Serve 轉送，也不使用 HMR WebSocket。

## 功能

- Ollama 產生並可手動修改 H3 prompt
- 長影片可由整體文字產生 continuity bible、全片分鏡時間、首段 T2VA prompt 與續段 I2VA prompt，也可切換為作者鎖定的 timeline
- 文字生片、參考圖生片、影片替換
- 解析度、秒數、Steps、Seed 與 model profile 設定
- 上傳與預覽圖片、影片及輸出 MP4
- 影片升頻可選 SeedVR2 7B 或 MiniMax H3 Latent 2x 後端
- 生成進度、取消工作與歷史紀錄

網頁資源只使用 ComfyUI 的兩個原生路徑：上傳與參考素材使用 `<COMFYUI_ROOT>/input`，生成影片與輸出資源使用 `<COMFYUI_ROOT>/output`。生成器直接寫入 ComfyUI output，不會在本專案或 `minimax-h3-local` 建立第二份輸出副本。

## CI 與 hosted 設定

GitHub workflow 會執行依賴安裝、lint、build、unit tests 與 WebUI route smoke checks；它是 quality gate，不是 deployment command。Hosted project metadata 保存在 `.openai/hosting.json`；credentials 應放在 hosting provider 的 secret 設定中，不要加入本 repository。

## 授權

本專案採用 MIT License，詳見 [LICENSE](LICENSE)。
