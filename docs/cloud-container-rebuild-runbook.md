# 雲端 GPU 容器重建手冊（Vast-style）

> 更新日期：2026-08-10
>
> 這是一份以目前 **Vast-style GPU base container** 為起點的操作手冊。此 repo 沒有 Dockerfile、compose 檔或完整裸機安裝腳本；OS、CUDA、Python、Torch、ComfyUI、supervisor 的基底版本尚未全部 pin，因此本手冊不宣稱可從裸 Ubuntu 完整重建。換容器前先採集版本與設定，再依本手冊重放模型與服務。

## 1. 適用範圍與拓撲

涵蓋 H3 影片生成、SeedVR2 影片升頻、Ollama 提示詞整理，以及可選的遠端 img2img／SAM3.1 replacement auto mask。正式影片或圖片生成不屬於一般重建驗證，必須另行取得明確允許。

目前的安全拓撲如下（所有雲端服務維持 loopback，不公開到網際網路）：

| 元件 | 綁定位址／port | 說明 |
| --- | --- | --- |
| 雲端 ComfyUI | `127.0.0.1:18188` | 容器內服務；由 supervisor 管理 |
| 雲端 Ollama | `127.0.0.1:11434` | 容器內服務；模型根目錄為 `/workspace/ollama-models` |
| 本機 SSH forward | `127.0.0.1:18188` → 雲端 `18188`；`127.0.0.1:11435` → 雲端 `11434` | 只讓本機 Studio 存取，SSH host/port 使用 `<VAST_HOST>`／`<SSH_PORT>` 佔位符 |
| H3 Studio Web/API | `0.0.0.0:8787`（本機亦可用 `127.0.0.1:8787`） | 入口 `/app`；本機 bridge 與 Web 共用同一 process |

不要將 18188 或 11434 綁到 `0.0.0.0`，也不要為了遠端存取修改 Tailscale Serve。

## 2. 先決條件

### 2.1 雲端容器

- Vast-style GPU base image 已提供 NVIDIA driver、CUDA runtime、Python/Torch、ComfyUI、supervisor 與 `/venv/main/bin/hf`；實際版本需依下節採集，不能假設。
- `/workspace/ComfyUI` 已存在，且 supervisor 已有名為 `comfyui` 的 program；`h3-bootstrap.sh` 會在模型安裝後執行 `supervisorctl restart comfyui`。
- 容器可連線到 Hugging Face、Ollama registry 與官方 Ollama installer；受限／gated repo 只在必要時使用 `HF_TOKEN`（不要把 token 寫入文件或命令歷史）。
- 可在容器內使用 `curl`、`sha256sum`、`stat`、`install`、`mv`、`supervisorctl`；建議有 `jq` 供驗證命令使用。

### 2.2 本機

- Windows PowerShell、OpenSSH `ssh.exe`／`scp.exe`，以及可連線到 `<VAST_HOST>:<SSH_PORT>` 的 SSH key（key 的值不寫入文件）。
- Node.js `>=22.13.0`（見 [`package.json`](../package.json)），npm 可執行；本機 ComfyUI／Ollama 可選，remote mode 仍保留 local URL 作 fallback。

## 3. 摧毀舊容器前的版本／設定採集

以下命令在**容器 Bash**執行。輸出只保留版本、revision、路徑與狀態；不要執行 `env`／`printenv` 全量傾印，也不要收集任何 token、key、password 或 credential。

```bash
set -euo pipefail

# Base image：Vast 控制台／宿主若能提供 image ID，請另外記在受控的部署紀錄；
# 容器內僅做 best-effort metadata 採集。
cat /etc/os-release
for f in /etc/container_release /etc/vastai-image /etc/image-id; do
  if [[ -r "$f" ]]; then printf '\n===== %s =====\n' "$f"; sed -n '1,120p' "$f"; fi
done

# 若可在 Vast 宿主／控制台取得 container ID，於宿主（非容器）執行唯讀查詢：
# docker inspect --format '{{.Config.Image}} image-sha={{.Image}}' "$CONTAINER_ID"
# 將輸出的 base image 名稱與 image-sha 和下列採集結果一起保存。

nvidia-smi
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv
nvcc --version 2>/dev/null || true
/venv/main/bin/python -VV
/venv/main/bin/python -c 'import torch; print("torch", torch.__version__, "cuda", torch.version.cuda, "available", torch.cuda.is_available())'

git -C /workspace/ComfyUI rev-parse HEAD
git -C /workspace/ComfyUI status --short
git -C /workspace/ComfyUI log -1 --format='%H%n%ad%n%s' --date=iso-strict

supervisorctl status
find /etc/supervisor -maxdepth 3 -type f -print
for f in /etc/supervisor/supervisord.conf /etc/supervisor/conf.d/*; do
  [[ -f "$f" ]] || continue
  printf '\n===== %s =====\n' "$f"
  # 只輸出設定結構；常見 secret 欄位先遮罩。
  sed -E 's/(TOKEN|KEY|SECRET|PASSWORD)=([^,[:space:]]+)/\1=<REDACTED>/Ig' "$f"
done

/usr/local/bin/ollama --version 2>/dev/null || ollama --version
OLLAMA_MODELS=/workspace/ollama-models /usr/local/bin/ollama list
for model in \
  'huihui_ai/qwen3-vl-abliterated:32b-instruct-q4_K_M' \
  'hf.co/HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP:Q4_K_M'; do
  printf '\n===== ollama show %s =====\n' "$model"
  OLLAMA_MODELS=/workspace/ollama-models /usr/local/bin/ollama show "$model" \
    | sed -E 's/(TOKEN|KEY|SECRET|PASSWORD)=([^,[:space:]]+)/\1=<REDACTED>/Ig'
done

/venv/main/bin/hf --version
```

把上述結果與 Vast 控制台的 base image ID、GPU 型號、磁碟／volume 名稱一併保存到受控的部署紀錄；不要把秘密值複製到本文件。`ollama list`／`ollama show` 是必要的舊容器基線，因為目前 pull 沒有 digest 或 size pin。

## 4. 持久化 volume 與容量

首選將整個 `/workspace` 掛在可重用的 persistent volume。若平台只能掛子目錄，至少保留：

```text
/workspace/ComfyUI/models/
/workspace/ComfyUI/input/
/workspace/ComfyUI/output/
/workspace/ComfyUI/custom_nodes/
/workspace/ComfyUI/config/
/workspace/ollama-models/
/workspace/h3-bootstrap.sh
/workspace/h3-bootstrap.conf
/workspace/ollama.sh
/workspace/ollama.conf
/workspace/seedvr2-bootstrap.sh
/workspace/*.log                 # bootstrap／錯誤紀錄
```

`/workspace/.h3-model-staging/` 與 `/workspace/.seedvr2-model-staging/` 可作為下載 staging（保留到 hash 驗證完成；不要把未驗證檔當成模型），媒體與 staging 也要預留空間。目前沒有 persistent volume；停止／重啟同一容器通常仍保留 `/workspace`，但 recycle 或 destroy 會遺失 Ollama、H3 權重與設定。

固定 safetensors 容量（十進位 bytes）：

| 組合 | bytes | 約略十進位 GB | 備註 |
| --- | ---: | ---: | --- |
| H3 五檔 | 46,557,479,455 | 46.56 | bootstrap 核心 |
| SeedVR2 兩檔 | 3,959,584,518 | 3.96 | bootstrap 核心升頻 |
| H3＋SeedVR2 | 50,517,063,973 | 50.52 | 尚未含 Ollama、media、cache、staging |
| 再加選配 SDXL Turbo | 57,455,145,878 | 57.46 | 僅 remote img2img 需要 |

`150 GB+` 是包含 Ollama 模型、輸入／輸出影片、暫存下載與更新餘量的操作建議，不是模型檔的硬性需求；依實際保留 media 與 staging 的政策加大。

## 5. Secret／環境變數清單

只記名稱、用途與是否必要；值放在受控的本機 shell／secret store，不要寫入此文件、git、bootstrap log 或 screenshot。

| 名稱 | 用途 | Required |
| --- | --- | --- |
| `HF_TOKEN` | Hugging Face gated/private repo 或 rate limit 時的下載授權 | 條件式；公開 revision 不需要 |
| SSH key（檔案／agent） | 本機 SSH forward 登入雲端 | 是；不寫 key 值 |
| `VAST_HOST` | 新容器 SSH host | 是；使用 `<VAST_HOST>` 佔位符 |
| `SSH_PORT` | 新容器 SSH port | 是；使用 `<SSH_PORT>` 佔位符 |
| `COMFY_REMOTE` | Studio 啟動為 remote runtime；`1`／`0` | remote mode 是 |
| `LOCAL_COMFY_URL` | 本機 fallback ComfyUI，例如 `http://127.0.0.1:8188` | remote mode 建議設 |
| `LOCAL_OLLAMA_URL` | 本機 fallback Ollama，例如 `http://127.0.0.1:11434` | remote mode 建議設 |
| `REMOTE_COMFY_URL` | SSH forward 後的本機 URL，例如 `http://127.0.0.1:18188` | remote mode 是 |
| `REMOTE_OLLAMA_URL` | SSH forward 後的本機 URL，例如 `http://127.0.0.1:11435` | remote mode 是 |
| `COMFY_URL` | 目前 active ComfyUI URL；通常等於 remote URL | 建議設 |
| `OLLAMA_URL` | 目前 active Ollama URL；通常等於 remote URL | 建議設 |
| `MINIMAX_H3_PYTHON` | 本機 H3 generator 使用的 Python；remote mode 仍需可解析的 local path | 依本機安裝 |
| `COMFYUI_ROOT`、`MINIMAX_H3_ROOT`、`MINIMAX_H3_LOGS_ROOT` | 覆寫本機 ComfyUI／H3／log 根目錄 | optional |
| `FFMPEG_PATH`、`FFPROBE_PATH` | 不在 `PATH` 時指定媒體工具 | optional；long-video 才需 |
| `CODEX_CLI_PATH`、`CODEX_HOME`、`H3_PROMPT_SKILL_PATH` | Codex prompt 整理功能位置 | optional |

雲端 `ollama.sh` 會固定 `OLLAMA_HOST=127.0.0.1:11434`、`OLLAMA_MODELS=/workspace/ollama-models`、`OLLAMA_NO_CLOUD=true` 等設定；不要把它改成對外 listener。

## 6. 精確模型 inventory

表內 bytes 與 SHA-256 是安裝驗收值；下載一律使用固定 revision。核心 bootstrap 共有 H3 五檔＋SeedVR2 兩檔（7 檔）。若把 remote img2img 的選配 SDXL Turbo 算入完整 safetensors inventory，則完整清單為 8 檔；SDXL 明確不屬 `h3-bootstrap.sh` 自動安裝。SAM3.1 另列為 replacement auto mask 選配。

### 6.1 H3 與 SeedVR2（bootstrap 核心）

| 功能 | Repo @ revision | HF source（固定 revision） | 容器 destination | bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| H3 FL2VA diffusion | `Abiray/Minimax-H3-nvfp4-INT4-INT8-Convrot` @ `6e632a197e7e1fe99f2c9f4b635c39db801b2210` | [`MiniMax_H3_FL2VA_pruned_nvfp4.safetensors`](https://huggingface.co/Abiray/Minimax-H3-nvfp4-INT4-INT8-Convrot/resolve/6e632a197e7e1fe99f2c9f4b635c39db801b2210/MiniMax_H3_FL2VA_pruned_nvfp4.safetensors) | `/workspace/ComfyUI/models/diffusion_models/minimax_h3_fl2va_pruned_nvfp4.safetensors` | 12528636800 | `9d49beb65ddc373a0df523b8ce715b61b73f88127bf3c8d3ffda76c5dda02bd4` |
| H3 Ref2VA diffusion | `lilcheaty/MiniMax-H3-NVFP4` @ `8c5abfed61e1b6a170240792b65253fba1a65b7b` | [`minimax_h3_ref2va_pruned_nvfp4.safetensors`](https://huggingface.co/lilcheaty/MiniMax-H3-NVFP4/resolve/8c5abfed61e1b6a170240792b65253fba1a65b7b/minimax_h3_ref2va_pruned_nvfp4.safetensors) | `/workspace/ComfyUI/models/diffusion_models/minimax_h3_ref2va_pruned_nvfp4.safetensors` | 12528636800 | `c813c5eabd85e275daccbf45e6f8ac4d9d14a1827d425e5be5070c92c60b78ac` |
| H3 Qwen text encoder | `Comfy-Org/MiniMax-H3` @ `eb8a16107c595128b3a578f82d2ce2f75920c355` | [`text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/eb8a16107c595128b3a578f82d2ce2f75920c355/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors) | `/workspace/ComfyUI/models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 15687142551 | `35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6` |
| H3 video VAE | `Comfy-Org/MiniMax-H3` @ `eb8a16107c595128b3a578f82d2ce2f75920c355` | [`vae/minimax_h3_video_vae_fp16.safetensors`](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/eb8a16107c595128b3a578f82d2ce2f75920c355/vae/minimax_h3_video_vae_fp16.safetensors) | `/workspace/ComfyUI/models/vae/minimax_h3_video_vae_fp16.safetensors` | 5207808496 | `7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522` |
| H3 audio VAE | `Comfy-Org/MiniMax-H3` @ `eb8a16107c595128b3a578f82d2ce2f75920c355` | [`vae/minimax_h3_audio_vae_fp32.safetensors`](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/eb8a16107c595128b3a578f82d2ce2f75920c355/vae/minimax_h3_audio_vae_fp32.safetensors) | `/workspace/ComfyUI/models/vae/minimax_h3_audio_vae_fp32.safetensors` | 605254808 | `8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48` |
| SeedVR2 3B Int8 diffusion | `Comfy-Org/SeedVR2` @ `0ef637b0cfd0543a4843d5d49231da2ca35a306f` | [`diffusion_models/seedvr2_3b_int8_convrot.safetensors`](https://huggingface.co/Comfy-Org/SeedVR2/resolve/0ef637b0cfd0543a4843d5d49231da2ca35a306f/diffusion_models/seedvr2_3b_int8_convrot.safetensors) | `/workspace/ComfyUI/models/diffusion_models/seedvr2_3b_int8_convrot.safetensors` | 3458259704 | `c3dec8bcc5916843a8a858572970597462e1f2dc598d6dfd818f6cd40f53a157` |
| SeedVR2 EMA VAE | `Comfy-Org/SeedVR2` @ `0ef637b0cfd0543a4843d5d49231da2ca35a306f` | [`vae/seedvr2_ema_vae_fp16.safetensors`](https://huggingface.co/Comfy-Org/SeedVR2/resolve/0ef637b0cfd0543a4843d5d49231da2ca35a306f/vae/seedvr2_ema_vae_fp16.safetensors) | `/workspace/ComfyUI/models/vae/seedvr2_ema_vae_fp16.safetensors` | 501324814 | `20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1` |

Ollama pull（**未 pin digest／size**，須先用 `ollama list`／`ollama show` 記錄舊容器結果）如下，模型檔放在 `/workspace/ollama-models`：

```text
huihui_ai/qwen3-vl-abliterated:32b-instruct-q4_K_M
hf.co/HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP:Q4_K_M
```

### 6.2 選配 remote img2img

只有要在雲端 runtime 執行 img2img 時才下載；現行 `h3-bootstrap.sh` 不會下載此檔。

| 功能 | Repo @ revision | HF source | destination | bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| SDXL Turbo checkpoint | `stabilityai/sdxl-turbo` @ `cf0e5cbf9cb1ce0f632875ea8e1b996a9df869d8` | [`sd_xl_turbo_1.0_fp16.safetensors`](https://huggingface.co/stabilityai/sdxl-turbo/resolve/cf0e5cbf9cb1ce0f632875ea8e1b996a9df869d8/sd_xl_turbo_1.0_fp16.safetensors) | `/workspace/ComfyUI/models/checkpoints/sd_xl_turbo_1.0_fp16.safetensors` | 6938081905 | `e869ac7d6942cb327d68d5ed83a40447aadf20e0c3358d98b2cc9e270db0da26` |

img2img 還需要 ComfyUI 原生節點（`CheckpointLoaderSimple`、`LoadImage`、`VAEEncode`、`CLIPTextEncode`、`KSampler`、`VAEDecode`、`SaveImage`）；沒有節點或 checkpoint 時，`/app/api/img2img/health` 應保持未 ready，不要以「下載成功」宣稱功能完成。現行 UI 另有 SD 1.5 選項，但其權重未在本手冊 pin。

### 6.3 選配 SAM3.1 replacement auto mask

只在 replacement auto mask 需求明確時安裝，非 H3／SeedVR2 核心 bootstrap。

| 功能 | Repo @ revision | HF source | destination | bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| SAM3.1 multiplex FP16 | `Comfy-Org/sam3.1` @ `5febd4769e8802cdfdb75e1f733abd8c68434a85` | [`checkpoints/sam3.1_multiplex_fp16.safetensors`](https://huggingface.co/Comfy-Org/sam3.1/resolve/5febd4769e8802cdfdb75e1f733abd8c68434a85/checkpoints/sam3.1_multiplex_fp16.safetensors) | `/workspace/ComfyUI/models/checkpoints/sam3.1_multiplex_fp16.safetensors` | 1745546848 | `9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03` |

SageAttention 不是模型：目前只有 Windows `cu130`／Torch `2.11`／`cp310` wheel pin；該 wheel 不能直接當作 Linux Vast 依賴，除非另有相容的 Linux build 與明確驗證，否則不要安裝或宣稱可用。

## 7. 下載安全規則與 staging 範例

`h3-bootstrap.sh`／`seedvr2-bootstrap.sh` 使用 `/venv/main/bin/hf download --revision`，先下載到 staging，再檢查 size 與 SHA-256，最後 `mv` 到模型目錄。既有檔案若 size/hash 不符會 fail，不會覆寫；部分下載器若附加已知 `L2P_bypass_*` trailer，腳本只在 prefix hash 與 trailer 格式均符合時截斷，否則 fail。

以下是**容器 Bash** 的單檔手動範例；把變數替換成上表的一列。任何 mismatch 都保留為隔離檔，禁止 `rm -rf` 後重跑：

```bash
set -euo pipefail

repo='Comfy-Org/MiniMax-H3'
revision='eb8a16107c595128b3a578f82d2ce2f75920c355'
remote_path='vae/minimax_h3_video_vae_fp16.safetensors'
dest='/workspace/ComfyUI/models/vae/minimax_h3_video_vae_fp16.safetensors'
expected_size='5207808496'
expected_sha='7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522'

stage_dir="/workspace/.h3-model-staging/manual-${revision:0:12}"
source="$stage_dir/$remote_path"
mkdir -p "$stage_dir" "$(dirname "$dest")"
/venv/main/bin/hf download "$repo" "$remote_path" \
  --revision "$revision" \
  --local-dir "$stage_dir"

if [[ "$(stat -c '%s' "$source")" != "$expected_size" ]]; then
  quarantine="${source}.bad.$(date -u +%Y%m%dT%H%M%SZ)"
  mv -- "$source" "$quarantine"
  printf 'size mismatch; quarantined at %s\n' "$quarantine" >&2
  exit 1
fi
if ! printf '%s  %s\n' "$expected_sha" "$source" | sha256sum --check --status; then
  quarantine="${source}.bad.$(date -u +%Y%m%dT%H%M%SZ)"
  mv -- "$source" "$quarantine"
  printf 'sha mismatch; quarantined at %s\n' "$quarantine" >&2
  exit 1
fi
if [[ -e "$dest" ]]; then
  printf 'refusing to overwrite existing destination: %s\n' "$dest" >&2
  exit 2
fi
mv -- "$source" "$dest"
chmod 0644 "$dest"
```

## 8. Bootstrap 與 supervisor

### 8.1 從本機部署檔案

以下在**本機 PowerShell**、repo 根目錄執行；只替換 `<VAST_HOST>` 與 `<SSH_PORT>`，不要把真實值提交到文件：

```powershell
Set-Location <REPO_ROOT>
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
ssh.exe -p $SshPort $Remote 'chmod 0755 /workspace/h3-bootstrap.sh /workspace/runtime-status.sh /workspace/ollama.sh && /workspace/h3-bootstrap.sh'
```

### 8.2 容器內安裝 supervisor 設定並手動啟動

以下在**容器 Bash**執行。bootstrap 會在 checksum、固定 git revision 與 ComfyUI health check 通過後寫入 `/workspace/.h3-runtime-state.json`；不要把未驗證的下載交給 supervisor 自動啟動。

```bash
set -euo pipefail

install -m 0644 /workspace/ollama.conf /etc/supervisor/conf.d/ollama.conf
supervisorctl reread
supervisorctl update
supervisorctl status comfyui ollama
```

`h3-bootstrap.sh` 的內容與行為：

1. 讀取版本化 `runtime-manifest.json`，固定 ComfyUI、custom nodes、H3/SeedVR2 模型與 Ollama inventory。
2. 若 `/usr/local/bin/ollama` 不存在，使用官方 installer；安裝／更新 `ollama.conf` 與 `/opt/supervisor-scripts/ollama.sh`。
3. 驗證既有 artifact；缺少或 checksum/revision 不符時隔離到 `.bad.<timestamp>`，優先從 persistent cache 恢復，否則下載至 staging 後 atomic install。
4. 重啟 ComfyUI、確認 health，並寫入 manifest checksum 與 runtime state；可用 `/usr/local/bin/h3-runtime-status.sh` 回報 drift。
4. `supervisorctl restart comfyui`，並等待 `127.0.0.1:18188/system_stats` 成功後才回報完成。

`seedvr2-bootstrap.sh` 是 SeedVR2 修復／獨立補裝入口，同樣會檢查兩檔、重啟 ComfyUI 並檢查 18188；它不是完整 H3 bootstrap 的替代品。

## 9. 本機 SSH tunnel 與 Studio

### 9.1 建立 forward

以下為**本機 PowerShell**。本機 18188／11435 是 forward listener，雲端仍是 18188／11434；不要把雲端 port 公開：

```powershell
Set-Location <REPO_ROOT>
Copy-Item scripts\vast\vast-runtime.config.example.json scripts\vast\vast-runtime.config.json
# Set instance.host, instance.sshPort, and tunnel ports in vast-runtime.config.json.
.\scripts\vast\start-tunnel.ps1
```

`start-vast-remote.ps1` 會讀取同一份 config、建立 tunnel 並重啟 Web/API。若設定檔放在 repo 外，使用 `-ConfigPath` 或 `VAST_RUNTIME_CONFIG`；替換 instance 時不需要修改 script。

### 9.2 啟動 H3 Studio

在同一個**本機 PowerShell** 視窗設定 remote mode；`<LOCAL_H3_PYTHON>` 代表本機已存在、可供 bridge 使用的 H3 Python，不是雲端秘密：

```powershell
$env:COMFY_REMOTE = '1'
$env:LOCAL_COMFY_URL = 'http://127.0.0.1:8188'
$env:LOCAL_OLLAMA_URL = 'http://127.0.0.1:11434'
$env:VAST_RUNTIME_CONFIG = '<PATH_TO_VAST_RUNTIME_CONFIG>'
$env:MINIMAX_H3_PYTHON = '<LOCAL_H3_PYTHON>'

.\scripts\vast\start-vast-remote.ps1
.\scripts\vast\status.ps1
```

Studio 入口為 `http://127.0.0.1:8787/app`。不要執行 `node local-bridge.mjs` 或另開 bridge process；Web/API 與 bridge 由 Vite/Vinext 同一個 8787 process 提供。

## 10. 驗證矩陣

### 10.1 雲端容器（容器 Bash）

```bash
set -euo pipefail

curl -fsS http://127.0.0.1:11434/api/tags
curl -fsS http://127.0.0.1:18188/system_stats
curl -fsS http://127.0.0.1:18188/object_info -o /tmp/h3-object-info.json

for node in \
  MiniMaxH3ImageToVideo \
  MiniMaxH3ReferenceToVideo \
  EmptyMiniMaxH3LatentAV \
  MiniMaxH3SigmaShift; do
  jq -e --arg node "$node" 'has($node)' /tmp/h3-object-info.json >/dev/null \
    || { echo "missing native H3 node: $node" >&2; exit 1; }
done
```

核對 inventory 表的每一列（核心 7 檔；若已選擇 remote img2img，再加 SDXL）之 size/hash。以下命令在**容器 Bash**提供可重複的檔案檢查：

```bash
set -euo pipefail
check_model() {
  local expected_size="$1" expected_sha="$2" path="$3"
  [[ "$(stat -c '%s' "$path")" == "$expected_size" ]] || { echo "size mismatch: $path" >&2; return 1; }
  printf '%s  %s\n' "$expected_sha" "$path" | sha256sum --check --status
}

check_model 12528636800 9d49beb65ddc373a0df523b8ce715b61b73f88127bf3c8d3ffda76c5dda02bd4 /workspace/ComfyUI/models/diffusion_models/minimax_h3_fl2va_pruned_nvfp4.safetensors
check_model 12528636800 c813c5eabd85e275daccbf45e6f8ac4d9d14a1827d425e5be5070c92c60b78ac /workspace/ComfyUI/models/diffusion_models/minimax_h3_ref2va_pruned_nvfp4.safetensors
check_model 15687142551 35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6 /workspace/ComfyUI/models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
check_model 5207808496 7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522 /workspace/ComfyUI/models/vae/minimax_h3_video_vae_fp16.safetensors
check_model 605254808 8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48 /workspace/ComfyUI/models/vae/minimax_h3_audio_vae_fp32.safetensors
check_model 3458259704 c3dec8bcc5916843a8a858572970597462e1f2dc598d6dfd818f6cd40f53a157 /workspace/ComfyUI/models/diffusion_models/seedvr2_3b_int8_convrot.safetensors
check_model 501324814 20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1 /workspace/ComfyUI/models/vae/seedvr2_ema_vae_fp16.safetensors

# remote img2img 選配才執行：
# check_model 6938081905 e869ac7d6942cb327d68d5ed83a40447aadf20e0c3358d98b2cc9e270db0da26 /workspace/ComfyUI/models/checkpoints/sd_xl_turbo_1.0_fp16.safetensors
```

### 10.2 本機 tunnel／Studio（本機 PowerShell）

```powershell
$checks = @(
  'http://127.0.0.1:18188/system_stats',
  'http://127.0.0.1:11435/api/tags',
  'http://127.0.0.1:8787/app/api/health',
  'http://127.0.0.1:8787/app/api/runtime',
  'http://127.0.0.1:8787/app/api/img2img/health'
)
foreach ($uri in $checks) {
  $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 10
  if ($response.StatusCode -ne 200) { throw "health failed: $uri" }
  Write-Host "OK $uri"
}

$health = (Invoke-WebRequest -Uri 'http://127.0.0.1:8787/app/api/health' -UseBasicParsing).Content | ConvertFrom-Json
if (-not $health.bridge -or -not $health.comfy.online -or -not $health.ollama.online) {
  throw 'Studio health does not report bridge, ComfyUI, and Ollama all online.'
}
Write-Host "runtime=$($health.runtime.mode) comfy=$($health.comfy.url) ollama=$($health.ollama.url)"
```

`/app/api/img2img/health` 只有在已部署選配 checkpoint 與所需節點後才應報 ready；核心 H3／SeedVR2 重建不以 img2img ready 為必要條件。正式 smoke test、模型載入或影片／圖片生成會改變 GPU、輸出檔與服務狀態，需另行取得明示允許。

## 11. 故障復原、idempotency 與安全

- 先看 `h3-bootstrap.log`／`h3-bootstrap.err.log`、`supervisorctl status`；不要為了重跑而刪除模型或整個 staging。
- 既有 destination size/hash mismatch 時，bootstrap 會停止且不覆寫。先針對**精確路徑**改名隔離，例如 `mv -- <path> <path>.bad.<UTC timestamp>`，再重新執行；不要使用 `/workspace/**/*.safetensors` 等廣泛 glob。
- staging 下載 mismatch 時保留 `.bad.<timestamp>` 供調查；確認正確檔已安裝並通過 hash 後，才依平台 retention policy 清理 staging。
- `supervisorctl restart comfyui` 失敗通常表示 base image 的 ComfyUI program／config 不相容；不要隨意新增另一個 ComfyUI instance，先回到版本採集與 base image 差異。
- Ollama tags 沒有 pinned digest／size；新容器 pull 後先比對舊容器的 `ollama list`／`ollama show`，變更時記錄並評估是否需要未來 pin。
- SSH key、`HF_TOKEN`、Vast host／port 與任何 credential 不得寫入本手冊、git、log、截圖或命令列歷史；Hugging Face 需要授權時使用外部 secret store／暫時環境變數。
- 18188／11434 永遠只 listen loopback；外部只透過 SSH forward 與 Studio 8787。不要開防火牆例外或把 `OLLAMA_HOST` 改為 `0.0.0.0`。

## 12. 目前缺口／TODO

1. 精確 Vast base image 名稱／ID、OS、CUDA driver/runtime、Python、Torch 尚未 pin；下次換容器前必須採集並決定可重建的 image digest。
2. ComfyUI commit、custom nodes 版本及支援 H3 native nodes（`MiniMaxH3ImageToVideo`、`MiniMaxH3ReferenceToVideo`、`EmptyMiniMaxH3LatentAV`、`MiniMaxH3SigmaShift`）尚未形成鎖定 manifest。
3. supervisor 的 `comfyui` config／啟動參數仍由 base image 提供，未在 repo 固化；需把脫敏後設定納入未來 image/volume 規格。
4. Ollama pull 尚無 digest／size pin；保留舊容器 `ollama list`／`ollama show`，並在 registry 穩定後補上可驗證 digest。
5. SageAttention 目前只有 Windows cu130／Torch2.11／cp310 wheel pin；Linux Vast 需另找相容 build，不能直接沿用。
6. 現行 Vast 沒有 persistent volume；若不補 volume，任何 recycle／destroy 都必須重新下載模型、Ollama 與設定。
7. SDXL Turbo、SAM3.1 是選配；除非需求明確，不要把它們加入核心 bootstrap 或容量最低值。

## 13. Sources of truth

- [`scripts/vast/h3-bootstrap.sh`](../scripts/vast/h3-bootstrap.sh)／[`h3-bootstrap.conf`](../scripts/vast/h3-bootstrap.conf)：H3＋SeedVR2 固定 revision、size/hash、staging、Ollama pull、ComfyUI restart。
- [`scripts/vast/seedvr2-bootstrap.sh`](../scripts/vast/seedvr2-bootstrap.sh)：SeedVR2 修復／獨立補裝。
- [`scripts/vast/ollama.sh`](../scripts/vast/ollama.sh)／[`ollama.conf`](../scripts/vast/ollama.conf)：loopback、模型根目錄與 supervisor runtime 環境。
- [`scripts/vast/start-tunnel.ps1`](../scripts/vast/start-tunnel.ps1)、[`start-vast-remote.ps1`](../scripts/vast/start-vast-remote.ps1)、[`status.ps1`](../scripts/vast/status.ps1)：SSH forward、Studio runtime 與健康檢查。
- [`scripts/vast/inspect-safetensors.py`](../scripts/vast/inspect-safetensors.py)：需要檢視 safetensors header／tensor data／trailing bytes 時使用。
- [`README.md`](../README.md)、[`package.json`](../package.json)、[`tests/video-upscale.test.mjs`](../tests/video-upscale.test.mjs)、[`tests/img2img.test.mjs`](../tests/img2img.test.mjs)：本機啟動、Node engine、SeedVR2／img2img readiness 與測試契約。
