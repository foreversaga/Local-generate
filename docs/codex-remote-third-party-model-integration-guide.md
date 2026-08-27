# Codex Desktop 串接遠端第三方模型完整整合指南

> 更新基準：2026-08-27  
> 適用情境：Codex Desktop / Codex CLI → 遠端 OpenAI-compatible API → vLLM 或 llama.cpp  
> 目標：
> 1. Codex 使用自訂 API Base URL 呼叫遠端模型。
> 2. 模型可作為主代理模型。
> 3. 多模型時，盡量出現在 Codex 模型選擇器。
> 4. 模型可被指定為 Codex subagent（子代理）模型。
> 5. 遠端 vLLM / llama.cpp 能正確處理 Codex 的 tool-call agent loop，而不只是一般聊天。

---

## 1. 先講結論

你的目標架構應該是：

```text
┌──────────────────────────┐
│ Codex Desktop / CLI      │
│                          │
│ ~/.codex/config.toml     │
│ model = "remote-main"    │
│ model_provider="remote"  │
└─────────────┬────────────┘
              │
              │ HTTPS
              │ POST /v1/responses
              │ model = "remote-main"
              │ tools = [...]
              │ stream = true
              ▼
┌──────────────────────────┐
│ 你的遠端 API             │
│ https://llm.example/v1   │
└─────────────┬────────────┘
              │
       ┌──────┴───────┐
       ▼              ▼
┌─────────────┐  ┌─────────────┐
│ vLLM        │  │ llama.cpp   │
│ Responses   │  │ Responses   │
│ tool parser │  │ Jinja/tools │
└─────────────┘  └─────────────┘
```

最重要的五件事：

1. **Codex 自訂 provider 現在要使用 OpenAI Responses API。**
   `wire_api = "responses"`，而且官方設定參考目前只支援 `responses`。
2. 遠端端點至少要能正確處理：
   - `POST /v1/responses`
   - SSE streaming
   - function/tool calling
   - `function_call_output`
   - 多輪 tool-call loop
3. vLLM 已有官方 Codex 整合文件，是目前兩者中最直接的 Codex backend。
4. 最新 llama.cpp 也已提供 `/v1/responses`，可直接使用，但要確認你使用的 build 足夠新，並完整測試 tool call。
5. **Codex Desktop 的第三方模型下拉選單目前不是完全成熟的功能。**
   `model_catalog_json` 可以供 Codex 載入模型 metadata，但：
   - 它不是從遠端 `/v1/models` 自動同步。
   - 目前是 catalog replacement，不是 append。
   - catalog entry 本身不能可靠地切換到另一個 provider/base URL。
   - Desktop 至 2026-08-27 仍有自訂 provider picker 顯示、過濾與 provider routing 的未解 issue。

因此，若你要一個 Desktop 下拉選單裡放多個第三方模型，**最穩定的設計是讓這些模型都能由同一個 `base_url` 接收，並由 request body 的 `model` 決定實際模型。**

這不代表一定要增加 Gateway：
- llama.cpp router mode 本身就可以是一個多模型 API。
- 若你的遠端 API 已經會依 `model` 路由，就直接使用。
- 單一 vLLM instance 只服務一個模型時，也可以直接連，不需要任何額外路由層。
- 只有當多個 vLLM instance 分別在不同 URL，而你又想讓 Codex Desktop 用同一 provider 下拉切換時，才需要額外的統一入口。

---

# 2. Codex 到遠端模型之間真正的協定

Codex 不是單純呼叫：

```text
/v1/chat/completions
```

目前自訂 provider 的 wire protocol 是：

```text
POST {base_url}/responses
```

如果：

```toml
base_url = "https://llm.example.com/v1"
```

實際就是：

```text
POST https://llm.example.com/v1/responses
```

Codex 官方設定目前的 `wire_api` 唯一支援值就是：

```toml
wire_api = "responses"
```

所以如果你的遠端 API 只有：

```text
/v1/chat/completions
```

而沒有：

```text
/v1/responses
```

就不算完整的 Codex-compatible endpoint。

---

# 3. Codex agent loop 是怎麼運作的

理解這段非常重要，因為很多第三方模型「可以聊天」但「不能當 Codex」。

一個典型流程：

```text
1. Codex → Model
   POST /v1/responses
   input = 使用者要求
   tools = shell / file / function ...

2. Model → Codex
   回傳 function_call
   例如：要求執行 shell command

3. Codex 本機執行 tool
   例如：
   git status
   cat src/main.ts
   pytest
   npm test

4. Codex → Model
   再次 POST /v1/responses
   帶回 function_call_output

5. Model 繼續思考

6. 若還需要工具
   再回 function_call

7. 所有工作完成
   回傳 final assistant output
```

注意：

> **遠端模型伺服器不負責執行 Codex 的 shell / workspace tools。**

遠端模型只需要：

- 正確收到工具定義。
- 正確決定要呼叫哪個工具。
- 正確輸出 Responses API function-call item。
- 收到 Codex 執行後的 `function_call_output`。
- 繼續產生下一步。

真正的檔案修改、shell command、git 等工具是在 Codex 那一端執行。

---

# 4. Codex Desktop 基本設定

使用：

```text
~/.codex/config.toml
```

provider/auth 屬於 machine-local 設定，應放 user-level `~/.codex/config.toml`，不要只放 project `.codex/config.toml`。

範例：

```toml
model = "remote-main"
model_provider = "remote"

[model_providers.remote]
name = "Remote Models"
base_url = "https://llm.example.com/v1"
env_key = "REMOTE_LLM_API_KEY"
wire_api = "responses"

# vLLM / llama.cpp 一般使用 HTTP + SSE 即可。
# 除非你的 endpoint 明確實作 Responses WebSocket，
# 否則不要宣告 WebSocket。
supports_websockets = false

requires_openai_auth = false

request_max_retries = 2
stream_max_retries = 2
stream_idle_timeout_ms = 300000
```

環境變數：

```bash
export REMOTE_LLM_API_KEY='your-api-key'
```

如果你的 API 不需要 auth，也可以省略 `env_key`。

不建議直接把 token 寫成：

```toml
experimental_bearer_token = "..."
```

官方設定也將它標記為不建議使用，優先用 `env_key`。

---

## 4.1 如果 API 使用自訂 Header

例如你的遠端服務要求：

```http
X-API-Key: ...
```

而不是：

```http
Authorization: Bearer ...
```

可以用：

```toml
[model_providers.remote]
name = "Remote Models"
base_url = "https://llm.example.com/v1"
wire_api = "responses"
requires_openai_auth = false

env_http_headers = {
    X-API-Key = "REMOTE_LLM_API_KEY"
}
```

`REMOTE_LLM_API_KEY` 是環境變數名稱，不是 token 本身。

---

# 5. 遠端 model id 一定要和 Codex 對得上

例如 Codex：

```toml
model = "remote-main"
```

遠端收到：

```json
{
  "model": "remote-main"
}
```

所以服務端一定要能辨識：

```text
remote-main
```

否則會出現典型錯誤：

```text
model not found
```

最佳做法是永遠使用穩定 alias，而不是直接把磁碟路徑、HF repo 路徑或 GGUF filename 當 Codex model id。

例如：

```text
remote-main
remote-worker
remote-fast
remote-reviewer
```

---

# 6. vLLM：遠端模型端的設定方式

vLLM 已有官方 Codex integration，官方文件明確說明 vLLM 實作 OpenAI Responses API，可以讓 Codex 將 vLLM 作為 backend。

## 6.1 最基本啟動方式

假設模型是：

```text
Qwen/Qwen3.6-27B
```

範例：

```bash
vllm serve Qwen/Qwen3.6-27B \
    --host 0.0.0.0 \
    --port 8000 \
    --served-model-name remote-main \
    --max-model-len 131072 \
    --enable-auto-tool-choice \
    --tool-call-parser qwen3_coder \
    --reasoning-parser qwen3
```

重點：

```text
--served-model-name remote-main
```

要和：

```toml
model = "remote-main"
```

一致。

---

## 6.2 tool parser 是必要重點

對 Codex 而言，模型能不能「文字回答」不是主要問題。

真正重要的是：

```text
它能不能穩定產生 tool calls。
```

vLLM 官方 Codex 文件要求對其他模型使用：

```text
--enable-auto-tool-choice
--tool-call-parser <該模型對應 parser>
```

如果是 reasoning model，通常還要搭配正確的：

```text
--reasoning-parser <parser>
```

例如：

```bash
--enable-auto-tool-choice \
--tool-call-parser qwen3_coder \
--reasoning-parser qwen3
```

但 parser 名稱會隨：

- 模型 family
- vLLM 版本
- chat template

而不同。

所以不要把 `qwen3_coder` 套到所有模型。

原則：

```text
Qwen → 用該 vLLM 版本針對 Qwen 支援的 parser
DeepSeek → 用 DeepSeek parser
Kimi → 用 Kimi parser
GPT-OSS → 用 GPT-OSS/OpenAI parser
其他 Hermes template 模型 → 視 vLLM 文件使用 Hermes parser
```

啟動前請以你實際安裝版本確認：

```bash
vllm serve --help
```

以及該版本的 tool calling 文件。

---

## 6.3 遠端 API key

如果直接由 vLLM 驗證：

```bash
vllm serve ... \
    --api-key "$VLLM_API_KEY"
```

Codex：

```toml
[model_providers.remote]
env_key = "REMOTE_LLM_API_KEY"
```

Codex 會送：

```http
Authorization: Bearer <key>
```

---

## 6.4 vLLM 單模型的推薦架構

```text
Codex
  |
  | model = remote-main
  |
  v
https://llm.example.com/v1
  |
  v
vLLM
  |
  +-- served-model-name = remote-main
```

這是最簡單、最穩定的型態。

---

## 6.5 多個 vLLM 模型

若你有：

```text
vLLM A : remote-main   :8000
vLLM B : remote-worker :8001
vLLM C : remote-fast   :8002
```

而 Codex 只設定：

```toml
base_url = "https://llm.example.com/v1"
```

那 `llm.example.com` 必須依 JSON body：

```json
{
  "model": "remote-worker"
}
```

路由到正確 vLLM instance。

也就是：

```text
                  ┌─ remote-main   → vLLM :8000
Codex → API root ─┼─ remote-worker → vLLM :8001
                  └─ remote-fast   → vLLM :8002
```

如果你的遠端 API 本來就有這種能力，不需要再加一層。

---

# 7. llama.cpp：遠端模型端的設定方式

最新 llama.cpp server 已包含：

```text
POST /v1/responses
POST /responses
```

而且 README 明確提供 OpenAI Responses API example。

這代表新版 llama.cpp 可以直接當 Codex 的 Responses backend，不必先轉成 Chat Completions。

要注意的是：

> llama.cpp 的 `/v1/responses` 內部會把 Responses request 轉換成 Chat Completions processing。

因此模型的：

- chat template
- Jinja template
- tool-call formatting
- reasoning formatting

都非常重要。

---

## 7.1 llama.cpp 單模型

推薦：

```bash
llama-server \
    -m /models/model.gguf \
    --host 0.0.0.0 \
    --port 8080 \
    --alias remote-main \
    --ctx-size 131072 \
    --parallel 4 \
    --jinja \
    --api-key "$LLAMA_API_KEY"
```

關鍵：

```text
--alias remote-main
```

如此：

```text
GET /v1/models
```

回傳的 model id 就可以穩定對應 Codex：

```toml
model = "remote-main"
```

---

## 7.2 llama.cpp Tool Calling

請確認 GGUF 內的 chat template 能正確描述：

```text
tools
tool_choice
assistant tool call
tool result
```

建議明確開啟：

```bash
--jinja
```

雖然新版可能已預設啟用，但明確指定可降低部署差異。

若 GGUF 沒有可用的 tool-aware template，使用：

```bash
--chat-template-file /path/to/model-tool-template.jinja
```

不要只測一般問答。

一定要測：

```text
Codex → tools
model → function_call
Codex → function_call_output
model → final answer
```

完整 loop。

---

# 8. llama.cpp Router Mode：很適合 Codex 多模型

如果你使用多個 GGUF，而希望 Codex 只設定一個 `base_url`，llama.cpp 的 router mode 很符合這個需求。

不指定 `-m`：

```bash
llama-server \
    --host 0.0.0.0 \
    --port 8080 \
    --models-dir /models \
    --models-max 2 \
    --parallel 4 \
    --api-key "$LLAMA_API_KEY"
```

router 會依 request body 的：

```json
{
  "model": "..."
}
```

選模型。

查：

```bash
curl -sS \
    -H "Authorization: Bearer $LLAMA_API_KEY" \
    https://llm.example.com/v1/models
```

然後把回傳的：

```json
data[].id
```

當成 Codex 的 model slug。

架構：

```text
Codex
  |
  | model = "qwen-coder-gguf"
  | 或
  | model = "small-worker-gguf"
  |
  v
llama.cpp router
  |
  ├── qwen-coder-gguf
  └── small-worker-gguf
```

這樣 Codex provider 不必改，只要切換 `model`。

---

# 9. vLLM vs llama.cpp，作為 Codex backend 的差異

| 項目 | vLLM | llama.cpp |
|---|---|---|
| `/v1/responses` | 支援 | 新版支援 |
| Codex 官方整合文件 | 有 | 沒有專屬 Codex guide，但 server 支援 Responses |
| Tool parser | 模型專屬 parser，控制較明確 | 主要依 chat template / Jinja / parser 行為 |
| 大量併發 | 強 | 可用 `--parallel` + continuous batching |
| 多 GPU serving | 強 | 可用 GPU offload / split，但架構不同 |
| 單一 endpoint 多模型 | 一般需外部路由或你的 API 層 | Router mode 原生支援 |
| GGUF | 否 | 是 |
| Codex agent 使用優先度 | **推薦優先** | 可以使用，但要更嚴格做 E2E tool-loop 測試 |

如果同一個模型你 vLLM 和 llama.cpp 都能跑，而目標主要是：

```text
Codex agent / tool use / subagents
```

優先從 vLLM 開始通常比較省整合工作。

如果主要需求是：

```text
GGUF
量化
有限 VRAM
單一 server 動態切換多個 GGUF
```

llama.cpp router 很有價值。

---

# 10. Responses API：遠端至少要接受哪些欄位

Codex request 可能包含：

```json
{
  "model": "remote-main",
  "instructions": "...",
  "input": [],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": {},
  "stream": true
}
```

實際欄位會依：

- Codex 版本
- 模型 metadata
- 是否啟用 reasoning
- 是否啟用 MCP
- 是否是 subagent

而變化。

服務端整合原則：

> **不要對你不認得、但屬於合理 Responses optional field 的欄位過度嚴格拒絕。**

如果 vLLM / llama.cpp 已自行處理，就不需要另外寫 parser。

如果你前面還有自己的 API service / reverse proxy / request transformer，這一點尤其重要。

---

# 11. Function Tool 格式

Responses API 的 function tool 不是舊 Chat Completions 的巢狀格式。

典型工具：

```json
{
  "type": "function",
  "name": "probe",
  "description": "Return a probe value",
  "parameters": {
    "type": "object",
    "properties": {
      "value": {
        "type": "integer"
      }
    },
    "required": ["value"],
    "additionalProperties": false
  },
  "strict": true
}
```

模型應能回傳 function call item，例如概念上：

```json
{
  "type": "function_call",
  "call_id": "call_123",
  "name": "probe",
  "arguments": "{\"value\":42}"
}
```

其中：

```text
arguments
```

是 JSON string。

Codex 執行工具後會把結果用：

```text
function_call_output
```

帶回模型。

---

# 12. SSE Streaming 必須能正常工作

Codex 主要使用 Responses streaming。

因此遠端：

```text
POST /v1/responses
stream=true
```

需要保持正確 SSE stream。

常見 Responses events 包括：

```text
response.created
response.output_item.added
response.output_text.delta

response.function_call_arguments.delta
response.function_call_arguments.done
response.output_item.done

response.completed
```

你的 service 不一定要自己手刻這些事件：

- vLLM 會處理。
- llama.cpp 會處理。
- 如果前面有 proxy，proxy 不可以破壞 SSE。

反向代理特別要避免：

```text
把整個 response buffer 完才一次回給 Codex。
```

這會讓 Codex 看起來像卡住。

---

# 13. 第一階段 API 驗證：確認 `/v1/models`

```bash
export BASE_URL='https://llm.example.com/v1'
export API_KEY='...'

curl -sS \
    "$BASE_URL/models" \
    -H "Authorization: Bearer $API_KEY"
```

確認：

```json
{
  "data": [
    {
      "id": "remote-main"
    }
  ]
}
```

model id 要跟 Codex 完全一致。

注意：

> `/v1/models` 對 Codex Desktop 主要是診斷用途。  
> **Codex Desktop 不會因為這個 endpoint 回了 models 就自動把所有模型加入 GUI 下拉選單。**

Desktop picker 使用的是 Codex 自己的 model catalog 機制。

---

# 14. 第二階段 API 驗證：純文字 Responses

```bash
curl -N \
    "$BASE_URL/responses" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "remote-main",
      "input": "Reply exactly: RESPONSE_OK",
      "stream": true
    }'
```

至少確認：

```text
HTTP 200
SSE 持續輸出
最後 response.completed
文字可正常解析
```

---

# 15. 第三階段：Tool Call 測試

建議用 OpenAI Python SDK 做 protocol probe。

建立：

```text
test_responses_tools.py
```

```python
import os
from typing import Any

from openai import OpenAI


BASE_URL = os.environ["BASE_URL"]
API_KEY = os.environ["API_KEY"]
MODEL = os.environ["MODEL"]


def build_probe_tool() -> dict[str, Any]:
    return {
        "type": "function",
        "name": "probe",
        "description": "Return a deterministic probe result.",
        "parameters": {
            "type": "object",
            "properties": {
                "value": {
                    "type": "integer",
                },
            },
            "required": ["value"],
            "additionalProperties": False,
        },
        "strict": True,
    }


def main() -> None:
    client = OpenAI(
        base_url=BASE_URL,
        api_key=API_KEY,
    )

    first = client.responses.create(
        model=MODEL,
        input="Call the probe tool with value 42. Do not answer directly.",
        tools=[build_probe_tool()],
        tool_choice="auto",
    )

    function_calls = [
        item
        for item in first.output
        if item.type == "function_call"
    ]

    if not function_calls:
        raise RuntimeError(
            "Model returned no function_call. "
            "Check tool parser/chat template."
        )

    call = function_calls[0]

    print("tool:", call.name)
    print("arguments:", call.arguments)
    print("call_id:", call.call_id)

    continuation_input: list[Any] = list(first.output)
    continuation_input.append(
        {
            "type": "function_call_output",
            "call_id": call.call_id,
            "output": "probe_result=84",
        }
    )

    second = client.responses.create(
        model=MODEL,
        input=continuation_input,
        tools=[build_probe_tool()],
    )

    print("final:", second.output_text)


if __name__ == "__main__":
    main()
```

執行：

```bash
export BASE_URL='https://llm.example.com/v1'
export API_KEY='...'
export MODEL='remote-main'

python test_responses_tools.py
```

如果這個測試過不了，就先不要測 Codex。

---

# 16. Codex E2E 驗證

API probe 全部通過後，再測 Codex。

CLI 可用：

```bash
codex exec \
  "Use tools to inspect the current directory. Then create a file named codex-probe.txt containing exactly CODEX_OK. Verify the file after writing it."
```

驗證：

```bash
cat codex-probe.txt
```

應為：

```text
CODEX_OK
```

這能一次驗證：

```text
Responses API
→ tool schema
→ model tool choice
→ tool call parsing
→ Codex 本地 tool execution
→ function_call_output
→ 後續模型回應
```

比單純問：

```text
1+1 等於多少
```

有意義得多。

---

# 17. Codex Desktop 下拉選單

這是目前整合裡最容易踩坑的部分。

Codex 有：

```toml
model_catalog_json = "/absolute/path/to/models.json"
```

可以載入自訂 model catalog。

但是截至 2026-08-27：

1. `model_catalog_json` 是 Codex 自己的 catalog，不是 `/v1/models`。
2. Desktop 對 custom provider 的 model picker 仍有已知 bug。
3. 有些版本會：
   - custom model 不顯示。
   - 顯示 `Custom`。
   - 顯示 `Custom High` 之類 fallback label。
   - catalog 有載入，但 picker 為空。
4. `model_catalog_json` 目前屬於 replacement 行為，而不是把第三方模型 append 到原本 OpenAI model list。
5. catalog model entry 沒有穩定的 per-model provider/base_url binding。

所以：

> **不要設計成「下拉模型 A → provider A、下拉模型 B → provider B」。**

目前最可靠的是：

```text
同一個 model_provider
同一個 base_url
不同 model slug
```

例如：

```text
remote-main
remote-worker
remote-fast
```

都送到：

```text
https://llm.example.com/v1/responses
```

再由 server 依：

```json
"model": "remote-worker"
```

決定真正模型。

---

# 18. `model_catalog_json` 的版本問題

這個 JSON 不建議從網路隨便複製一份舊範本。

原因：

```text
Codex model catalog schema 仍會隨版本變動。
```

最安全方式：

1. 確認 Desktop 內部 Codex core / CLI 版本。
2. 使用**同一版本**的 catalog schema。
3. 再複製一個正常 entry 修改成自己的模型。
4. 每次 Codex Desktop 大版本更新後重新驗證。

如果你目前版本支援：

```bash
codex debug models
```

可以先用：

```bash
codex debug models > /tmp/codex-models.json
```

檢查目前 core 實際解析出的 model metadata。

如果 Desktop 和 shell 裡的 Codex CLI 不是同一版本，請以 Desktop 實際使用的 core schema 為準。

不要直接抓 Codex GitHub `main` 分支最新的 models schema，然後假設舊 Desktop 一定能讀。

---

# 19. 建議的 `config.toml`：主模型 + 子代理

這是最符合你需求的結構：

```toml
model = "remote-main"
model_provider = "remote"

# 要使用 Desktop custom catalog 時才啟用。
# model_catalog_json = "/home/USER/.codex/remote-models.json"

[model_providers.remote]
name = "Remote Models"
base_url = "https://llm.example.com/v1"
env_key = "REMOTE_LLM_API_KEY"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = false
request_max_retries = 2
stream_max_retries = 2
stream_idle_timeout_ms = 300000

[agents]
enabled = true
default_subagent_model = "remote-worker"
default_subagent_reasoning_effort = "medium"
max_concurrent_threads_per_session = 4
```

這代表：

```text
主代理：
remote-main

預設子代理：
remote-worker
```

而且兩者都送到：

```text
https://llm.example.com/v1
```

server 依：

```json
"model"
```

做選擇。

---

# 20. 自訂子代理角色

Codex 官方支援：

```text
~/.codex/agents/*.toml
```

個人級 custom agents。

例如：

```text
~/.codex/agents/local-reviewer.toml
```

內容：

```toml
name = "local_reviewer"
description = "Review code for correctness, regressions, concurrency issues, and missing tests."

model = "remote-worker"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"

developer_instructions = """
Review the target code without modifying files.

Prioritize:
1. Correctness bugs.
2. Race conditions and state consistency.
3. Error handling.
4. API compatibility.
5. Missing or weak tests.

Return concise findings with file paths and concrete evidence.
"""
```

Codex 官方目前的 resolution 邏輯是：

```text
explicit spawn model
→ [agents] default
→ parent model
→ custom agent file override
```

而 custom agent file 裡的：

```toml
model = "..."
model_reasoning_effort = "..."
```

可以覆蓋子代理模型。

---

# 21. 第三方模型當 Subagent：目前要注意 Multi-Agent V2

這是 2026-08 非常重要的限制。

目前 Codex GitHub 已有多個 issue：

```text
Multi-Agent V2
+ external Responses provider
```

在子代理 task payload 上可能使用 OpenAI-specific：

```text
agent_message
encrypted_content
```

第三方 provider 不能解開，造成：

```text
子代理 thread 有建立
模型也對
但是實際 task payload 是空的
```

已有人驗證的 workaround 是在 custom model catalog 中使用：

```json
"multi_agent_version": "v1"
```

讓 delegated task 改走 plaintext user input。

注意：

> 這是目前的相容性 workaround，不是 Responses API 標準要求。

而且不同 Codex build 對 V1/V2 的行為仍可能不同。

因此第三方 subagent 建議測試順序：

```text
1. 主 agent 的 tool loop 先通
2. 單一 third-party subagent
3. Multi-Agent V1
4. 再測多個 concurrent subagents
5. 最後才測 Multi-Agent V2
```

如果：

```text
主模型可以正常 coding
但 spawn_agent 收不到 task
```

不要第一時間怪 vLLM / llama.cpp。

它很可能是 Codex client-side 的 V2 custom-provider 相容性問題。

---

# 22. Subagent 的 provider 設計

如果：

```text
主模型 remote-main
子代理 remote-worker
```

兩個都在：

```text
https://llm.example.com/v1
```

最簡單：

```text
同 provider，不同 model。
```

例如：

```toml
model_provider = "remote"
```

主：

```toml
model = "remote-main"
```

子：

```toml
model = "remote-worker"
```

不要依賴：

```text
主 agent 用 provider A
子 agent model 一改就自動切 provider B
```

目前 Desktop/custom catalog/provider routing 還不適合做這種設計。

如果真的需要：

```text
OpenAI parent
→ remote vLLM child
```

或：

```text
vLLM parent
→ llama.cpp child
```

請把它當成進階相容性場景，單獨做版本驗證。

---

# 23. 子代理併發對遠端 server 的要求

設定：

```toml
[agents]
max_concurrent_threads_per_session = 4
```

代表 Codex 可能同時建立多個 model request。

你的遠端模型服務需要能承受：

```text
parent request
+ 4 child requests
+ 每個 child 的 tool-loop continuation
```

---

## 23.1 llama.cpp

使用：

```bash
--parallel 4
```

並配合足夠 context / KV cache。

例如：

```bash
llama-server \
    -m /models/model.gguf \
    --alias remote-worker \
    --ctx-size 131072 \
    --parallel 4 \
    --jinja
```

注意：

```text
--parallel 4
```

不是免費的。

context / KV cache / prompt 長度會影響可承受併發。

---

## 23.2 vLLM

vLLM 本身較適合 serving concurrency，但仍需要控制：

```text
max model len
GPU memory utilization
batching
TP / DP
同時 sequence 數量
```

不要只用單一簡單 request 測出成功，就直接把：

```toml
max_concurrent_threads_per_session = 16
```

拉很高。

先從：

```toml
max_concurrent_threads_per_session = 2
```

或：

```toml
= 4
```

開始。

---

# 24. Reasoning 相容性

如果模型不是 reasoning model，最好不要強制：

```toml
model_reasoning_effort = "high"
```

如果是 reasoning model：

vLLM：

```text
--reasoning-parser <正確 parser>
```

llama.cpp：

```text
使用模型相符的 reasoning format / chat template
```

很重要。

否則可能出現：

```text
思考 token 混進 final answer
tool call 被 reasoning block 吃掉
reasoning effort 設定完全沒有作用
Codex 以為模型支援某 metadata，實際 provider 不支援
```

custom catalog 裡的 reasoning capabilities 應該反映真實模型能力。

---

# 25. `supports_websockets`

vLLM / llama.cpp 這種情境建議先：

```toml
supports_websockets = false
```

因為你已經有：

```text
HTTP Responses
+ SSE
```

就足夠 Codex 使用。

只有當你的遠端 endpoint 明確支援 Codex 所需的 Responses WebSocket transport 才改成：

```toml
true
```

不要只是因為 proxy 支援 WebSocket upgrade 就設成 true。

---

# 26. MCP / namespace tools 的相容性

這是另一個要分階段測的項目。

標準 Responses function tool：

```json
{
  "type": "function",
  ...
}
```

通常最容易讓：

```text
vLLM
llama.cpp
第三方 provider
```

處理。

但 Codex 的 MCP / plugin / namespace tool surface 可能出現第三方 provider 尚未支援的 tool type。

所以相容性驗證推薦：

```text
Phase 1
純文字

Phase 2
標準 function tool / shell agent loop

Phase 3
parallel tool calls

Phase 4
subagent

Phase 5
MCP / namespace tools

Phase 6
Multi-Agent V2
```

如果 Phase 2 正常、Phase 5 不正常，不代表你的 `/v1/responses` 基本整合失敗。

---

# 27. 反向代理 / HTTPS 設定

因為你是「Codex → 遠端 API」，不建議直接把：

```text
vLLM :8000
llama.cpp :8080
```

裸露到 Internet。

推薦：

```text
Internet
   |
 HTTPS 443
   |
Nginx / Caddy / Traefik
   |
private network
   |
vLLM / llama.cpp
```

需要：

```text
TLS
API key
IP allowlist（可用時）
rate limit
request size
SSE buffering disabled
合理 read timeout
```

尤其 SSE：

```text
proxy buffering
```

要避免把 stream buffer 起來。

---

# 28. Nginx 概念設定

若使用 Nginx，至少注意：

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:8000/v1/;

    proxy_http_version 1.1;

    proxy_buffering off;
    proxy_cache off;

    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Content-Type $content_type;
}
```

如果後端是 llama.cpp：

```text
8000
```

換成：

```text
8080
```

這只是一個最小示意。

實際 production 還要加：

```text
TLS
auth
network policy
logging
rate limits
```

---

# 29. 遠端 API access log 建議記錄什麼

非常推薦你的 API log 至少包含：

```text
request_id
model
path
HTTP status
TTFT
total latency
input tokens
output tokens
tool count
stream/non-stream
upstream
queue time
```

但不要直接把：

```text
完整 prompt
API key
Authorization header
原始 code
```

無條件寫進 production log。

當 Codex 子代理路由錯誤時，最有用的是直接看：

```text
request.model
```

例如你期待：

```text
remote-worker
```

如果 server log 收到：

```text
remote-main
```

就知道問題在 Codex model resolution，而不是 vLLM model loading。

---

# 30. 完整診斷矩陣

| 症狀 | 最可能原因 | 先檢查 |
|---|---|---|
| `404 /v1/responses` | server 太舊或 base URL 錯 | server version、`base_url` 是否含 `/v1` |
| 一般聊天正常，Codex tool 不動 | tool parser/template 未啟用 | vLLM `--tool-call-parser` / llama Jinja |
| model not found | model slug 不一致 | vLLM `--served-model-name` / llama `--alias` |
| stream 卡住 | proxy buffering / SSE 格式 | reverse proxy |
| Desktop dropdown 空 | Codex Desktop custom catalog bug / schema mismatch | `model_catalog_json`、Codex build |
| dropdown 顯示 `Custom` | Desktop picker fallback issue | 實際 server log 的 `model` |
| `/v1/models` 有模型但 Desktop 沒顯示 | 正常設計差異 | Desktop 不會自動用 `/v1/models` 建 catalog |
| subagent 有建立但 task 是空的 | Multi-Agent V2 external provider bug | 改測 V1 |
| child 使用錯 model | Codex subagent routing / override | server request log |
| tool arguments 無法 parse | parser/template 不相容 | raw response、chat template |
| reasoning 混進 answer | reasoning parser/format 錯 | reasoning parser |
| MCP tool 400 unsupported | namespace/custom tool compatibility | 先關 MCP、只測 standard tools |
| 多 subagent timeout | inference concurrency 不足 | vLLM queue / llama `--parallel` |
| 401 | env key / header 錯 | Desktop process 是否看得到 env var |

---

# 31. 建議的部署模式 A：一個 vLLM 模型

最簡單。

```text
Codex
  │
  │ model=remote-main
  ▼
https://llm.example.com/v1
  ▼
vLLM
  └─ remote-main
```

Codex：

```toml
model = "remote-main"
model_provider = "remote"

[model_providers.remote]
name = "Remote vLLM"
base_url = "https://llm.example.com/v1"
env_key = "REMOTE_LLM_API_KEY"
wire_api = "responses"
supports_websockets = false
```

vLLM：

```bash
vllm serve /models/main \
    --host 0.0.0.0 \
    --port 8000 \
    --served-model-name remote-main \
    --enable-auto-tool-choice \
    --tool-call-parser YOUR_MODEL_PARSER
```

---

# 32. 建議的部署模式 B：llama.cpp Router 多模型

```text
Codex
  │
  │ model=...
  ▼
https://llm.example.com/v1
  ▼
llama-server router
  ├─ remote-main
  ├─ remote-worker
  └─ remote-fast
```

server：

```bash
llama-server \
    --host 0.0.0.0 \
    --port 8080 \
    --models-dir /models \
    --models-max 2 \
    --parallel 4 \
    --api-key "$LLAMA_API_KEY"
```

Codex：

```toml
model = "remote-main"
model_provider = "remote"

[model_providers.remote]
name = "Remote llama.cpp"
base_url = "https://llm.example.com/v1"
env_key = "REMOTE_LLM_API_KEY"
wire_api = "responses"
supports_websockets = false

[agents]
default_subagent_model = "remote-worker"
max_concurrent_threads_per_session = 2
```

---

# 33. 建議的部署模式 C：多 vLLM instance + 既有統一 API

如果你的「遠端建立好的模型入口」本來就能依 model routing：

```text
Codex
   │
   ▼
https://llm.example.com/v1
   │
   ├─ model=remote-main
   │      └→ vLLM A
   │
   ├─ model=remote-worker
   │      └→ vLLM B
   │
   └─ model=remote-fast
          └→ vLLM C
```

那 Codex 就只要：

```toml
model_provider = "remote"
```

不要在 Codex 端建立三個不同 provider。

這是最符合 Desktop picker / subagent model override 的方式。

---

# 34. 如果每個遠端模型真的是不同 URL

例如：

```text
https://main.example/v1
https://worker.example/v1
https://fast.example/v1
```

Codex CLI profile 可以比較容易切換 provider。

但如果你的需求是：

```text
Desktop 單一下拉選單
+ 同 thread 切模型
+ subagent 指定不同模型
```

目前不建議依賴 Desktop 自動把：

```text
model → provider → base_url
```

全部一起切。

因為目前 catalog entry 沒有成熟的 per-model provider binding。

這種情況若一定要有單一 Desktop UX，才值得在遠端整理成：

```text
https://models.example/v1
```

統一入口。

再次強調：

> 這是多 URL 場景才需要。  
> 你的遠端 API 如果已經是一個統一入口，就不需要額外 Gateway。

---

# 35. 如何判斷「第三方模型已真正可以當 Codex」

不要只看它能不能回答。

一個模型至少要依序通過：

```text
[1] POST /v1/responses 普通文字
[2] stream=true
[3] 收到 tools
[4] 產出 function_call
[5] 收到 function_call_output
[6] 根據 tool output 繼續回答
[7] 能連續呼叫 2 次以上工具
[8] 能在 Codex workspace 裡 inspect file
[9] 能修改檔案
[10] 能跑 test 並根據 test failure 修正
[11] parallel requests
[12] subagent
```

前 10 項才是 Codex coding backend 的基本品質。

---

# 36. 建議的「Codex 相容測試 Prompt」

第一個：

```text
Inspect this repository using tools.
Do not guess file contents.
Find the project entry point and explain how the application starts.
```

第二個：

```text
Create a file named codex-probe.txt containing exactly CODEX_OK.
Read the file back after writing it and verify the content.
```

第三個：

```text
Find one existing test in this project.
Run only that test using the appropriate shell command.
Report the exact command and whether it passed.
```

第四個：

```text
Spawn one subagent to inspect the repository structure.
Ask it to return exactly three important directories and their purposes.
Wait for the subagent and summarize its result.
```

如果前三個正常、第四個不正常：

```text
優先查 Codex subagent/custom-provider compatibility，
不是先改 vLLM inference。
```

---

# 37. 實作優先順序

推薦照這個順序：

```text
Stage 1
遠端單一模型
Responses API
普通文字

Stage 2
SSE

Stage 3
Tool calling

Stage 4
完整 Codex coding E2E

Stage 5
固定 model slug / alias

Stage 6
第二個模型
同一 base_url 依 model routing

Stage 7
default_subagent_model

Stage 8
custom agent TOML

Stage 9
model_catalog_json / Desktop dropdown

Stage 10
Multi-Agent V1

Stage 11
MCP / namespace tools

Stage 12
Multi-Agent V2
```

這樣比較容易判斷是哪一層出錯。

---

# 38. 最終推薦設定

假設你的遠端已經是：

```text
https://llm.your-domain.com/v1
```

而它可接受：

```text
remote-main
remote-worker
```

最推薦的 Codex 設定：

```toml
model = "remote-main"
model_provider = "remote"

[model_providers.remote]
name = "Remote Models"
base_url = "https://llm.your-domain.com/v1"
env_key = "REMOTE_LLM_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 2
stream_max_retries = 2
stream_idle_timeout_ms = 300000

[agents]
enabled = true
default_subagent_model = "remote-worker"
default_subagent_reasoning_effort = "medium"
max_concurrent_threads_per_session = 4
```

遠端：

```text
POST /v1/responses
```

收到：

```json
{
  "model": "remote-main"
}
```

就送主模型。

收到：

```json
{
  "model": "remote-worker"
}
```

就送 worker 模型。

這就是最乾淨的整合介面。

---

# 39. 目前對 Desktop 下拉選單的最終判斷

截至 2026-08-27：

### 可以做

```text
Codex custom provider
→ remote Responses API
→ 指定 model
→ vLLM / llama.cpp

[agents]
default_subagent_model = "..."

custom agent TOML
model = "..."
```

這些都有明確的 config / server 支援。

### 仍有 UI / 相容性風險

```text
Codex Desktop custom-provider model picker
model_catalog_json 顯示
provider-aware picker
custom model 顯示名稱
API-key-only custom picker
Multi-Agent V2 → external provider
cross-provider subagent
```

因此：

> **先把 API、tool loop、subagent routing 做對，再把 Desktop dropdown 當 UI enhancement。**

不要反過來先用 picker 是否漂亮顯示來判斷 API 是否整合成功。

---

# 40. 驗收 Checklist

## Codex Client

- [ ] `~/.codex/config.toml` 使用 user-level provider 設定。
- [ ] `base_url` 指向 `/v1`。
- [ ] `wire_api = "responses"`。
- [ ] `supports_websockets = false`，除非 endpoint 真的支援。
- [ ] `model` 和 server model id 完全一致。
- [ ] API key 可被 Codex Desktop process 讀取。
- [ ] `default_subagent_model` 指向遠端可辨識的 model id。

## Remote API

- [ ] `GET /v1/models` 正常。
- [ ] `POST /v1/responses` 正常。
- [ ] streaming 正常。
- [ ] function tools 正常。
- [ ] `function_call_output` continuation 正常。
- [ ] 多輪 tool calls 正常。
- [ ] 併發 request 正常。
- [ ] 錯誤回應有正確 HTTP status。
- [ ] reverse proxy 不 buffer SSE。

## vLLM

- [ ] `--served-model-name` 固定且與 Codex 一致。
- [ ] `--enable-auto-tool-choice`。
- [ ] `--tool-call-parser` 正確。
- [ ] reasoning model 的 `--reasoning-parser` 正確。
- [ ] 先完成單 agent E2E 再開高 subagent concurrency。

## llama.cpp

- [ ] 使用含 `/v1/responses` 的新版 build。
- [ ] `--alias` 與 Codex model 一致，或 router 回傳 id 與 catalog 一致。
- [ ] `--jinja`。
- [ ] chat template 支援 tool use。
- [ ] `--parallel` 與硬體/context 需求相符。
- [ ] router mode 時 request `model` 能正確選到模型。

## Desktop / Model Catalog

- [ ] 確認 `model_catalog_json` schema 與 Codex Desktop core 版本相符。
- [ ] 知道 catalog 是 replacement，不是自動 merge。
- [ ] 不依賴 `/v1/models` 自動填 Desktop picker。
- [ ] 不依賴 catalog entry 自動切換 provider/base URL。
- [ ] Desktop 顯示 `Custom` 時，用 server log 確認實際 routing。

## Subagent

- [ ] 單一 subagent 正常。
- [ ] server log 收到正確 child `model`。
- [ ] delegated task 不是空白。
- [ ] 若 V2 payload 問題，測試 `multi_agent_version = v1`。
- [ ] 再逐步增加 concurrent subagents。

---

# 41. 參考來源

截至文件更新日，主要依據：

1. OpenAI / Codex Configuration Reference
   - `model_providers.<id>.base_url`
   - `env_key`
   - `wire_api`
   - `model_catalog_json`
   - `agents.default_subagent_model`
   - `agents.max_concurrent_threads_per_session`

2. OpenAI / Codex Subagents
   - custom agents
   - `~/.codex/agents/*.toml`
   - per-agent `model`
   - per-agent `model_reasoning_effort`

3. vLLM 官方文件：Codex integration
   - vLLM 實作 OpenAI Responses API
   - Codex `base_url`
   - `wire_api = "responses"`
   - `--enable-auto-tool-choice`
   - `--tool-call-parser`
   - `--reasoning-parser`

4. llama.cpp 官方 server README / source
   - `/v1/responses`
   - `/v1/models`
   - `--alias`
   - `--parallel`
   - Jinja tool calling
   - router mode
   - `--models-dir`
   - request body `model` routing

5. openai/codex GitHub issues（截至 2026-08）
   - Desktop custom provider / model picker limitations
   - `model_catalog_json` replacement behavior
   - provider-aware picker limitations
   - Multi-Agent V2 external provider `agent_message` / `encrypted_content`
   - V1 workaround reports

官方文件：
- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/codex/subagents
- https://docs.vllm.ai/en/latest/serving/integrations/codex/
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md

相關 Codex issues：
- https://github.com/openai/codex/issues/29156
- https://github.com/openai/codex/issues/34487
- https://github.com/openai/codex/issues/36582
- https://github.com/openai/codex/issues/37379
- https://github.com/openai/codex/issues/33551
- https://github.com/openai/codex/issues/34833
- https://github.com/openai/codex/issues/36586

---

# 42. 最簡版決策

如果你只要一個可以直接落地的答案：

```text
Codex Desktop
    ↓
一個自訂 provider
    ↓
https://你的遠端API/v1
    ↓
POST /v1/responses
    ↓
依 body.model 決定模型
    ↓
vLLM 或 llama.cpp
```

Codex：

```toml
model = "remote-main"
model_provider = "remote"

[model_providers.remote]
name = "Remote Models"
base_url = "https://你的遠端API/v1"
env_key = "REMOTE_LLM_API_KEY"
wire_api = "responses"
supports_websockets = false

[agents]
enabled = true
default_subagent_model = "remote-worker"
max_concurrent_threads_per_session = 4
```

遠端最少保證：

```text
/v1/responses
SSE
function tools
function_call_output
正確 model alias
併發
```

vLLM：

```text
enable-auto-tool-choice
+ 正確 tool-call-parser
+ reasoning model 時正確 reasoning-parser
```

llama.cpp：

```text
新版 /v1/responses
+ --alias
+ --jinja
+ tool-aware chat template
+ --parallel
```

這個結構最符合目前 Codex Desktop、自訂 provider、subagent 和遠端模型 API 的實際行為。
