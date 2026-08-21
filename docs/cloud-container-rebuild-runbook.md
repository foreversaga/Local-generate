# 雲端 GPU 容器重建手冊（Vast-style）

> 更新日期：2026-08-19
>
> 這是一份以目前 **Vast-style GPU base container** 為起點的操作手冊。此 repo 沒有 Dockerfile、compose 檔或完整裸機安裝腳本；OS、CUDA、Python、Torch、ComfyUI、supervisor 的基底版本尚未全部 pin，因此本手冊不宣稱可從裸 Ubuntu 完整重建。換容器前先採集版本與設定，再依本手冊重放模型與服務。

## 1. 適用範圍與拓撲

涵蓋 H3 影片生成、SeedVR2 與 MiniMax H3 Latent 影片升頻、Ollama 提示詞整理，以及可選的遠端 img2img／SAM3.1 replacement auto mask。正式影片或圖片生成不屬於一般重建驗證，必須另行取得明確允許。

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
/workspace/ComfyUI/models/h3_latent_upscalers/
/workspace/*.log                 # bootstrap／錯誤紀錄
```

`/workspace/.h3-model-staging/` 與 `/workspace/.seedvr2-model-staging/` 可作為下載 staging（保留到 hash 驗證完成；不要把未驗證檔當成模型），媒體與 staging 也要預留空間。目前沒有 persistent volume；停止／重啟同一容器通常仍保留 `/workspace`，但 recycle 或 destroy 會遺失 Ollama、H3 權重與設定。

固定 safetensors 容量（十進位 bytes）：

| 組合 | bytes | 約略十進位 GB | 備註 |
| --- | ---: | ---: | --- |
| H3 五檔 | 46,557,479,455 | 46.56 | bootstrap 核心 |
| SeedVR2 兩檔 | 5,261,019,606 | 5.26 | bootstrap 核心升頻 |
| H3 Latent Upscaler 2x | 59,022,848 | 0.06 | bootstrap 核心升頻 |
| H3＋SeedVR2＋Latent Upscaler | 51,877,521,909 | 51.88 | 尚未含 Ollama、media、cache、staging |
| 再加選配 SDXL Turbo | 58,815,603,814 | 58.82 | 僅 remote img2img 需要 |

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

表內 bytes 與 SHA-256 是安裝驗收值；下載一律使用固定 revision。完整 `runtime-manifest.json` 現在有 20 檔唯一模型／權重：H3 七檔、SeedVR2 兩檔、Wan2.2 Animate 六檔、SAM2 一檔、Wan Animate DWPose 兩檔、SCAIL-2 一檔與 SAM3.1 一檔。Wan UMT5 與 Wan VAE 由 Wan2.2／SCAIL-2 共用同一組已驗證檔案。若把 remote img2img 的選配 SDXL Turbo 算入完整 safetensors inventory，則再加 1 檔；SDXL 明確不屬 `h3-bootstrap.sh` 自動安裝。

### 6.1 H3 與 SeedVR2（bootstrap 核心）

| 功能 | Repo @ revision | HF source（固定 revision） | 容器 destination | bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| H3 FL2VA diffusion | `Abiray/Minimax-H3-nvfp4-INT4-INT8-Convrot` @ `6e632a197e7e1fe99f2c9f4b635c39db801b2210` | [`MiniMax_H3_FL2VA_pruned_nvfp4.safetensors`](https://huggingface.co/Abiray/Minimax-H3-nvfp4-INT4-INT8-Convrot/resolve/6e632a197e7e1fe99f2c9f4b635c39db801b2210/MiniMax_H3_FL2VA_pruned_nvfp4.safetensors) | `/workspace/ComfyUI/models/diffusion_models/minimax_h3_fl2va_pruned_nvfp4.safetensors` | 12528636800 | `9d49beb65ddc373a0df523b8ce715b61b73f88127bf3c8d3ffda76c5dda02bd4` |
| H3 Ref2VA diffusion | `lilcheaty/MiniMax-H3-NVFP4` @ `8c5abfed61e1b6a170240792b65253fba1a65b7b` | [`minimax_h3_ref2va_pruned_nvfp4.safetensors`](https://huggingface.co/lilcheaty/MiniMax-H3-NVFP4/resolve/8c5abfed61e1b6a170240792b65253fba1a65b7b/minimax_h3_ref2va_pruned_nvfp4.safetensors) | `/workspace/ComfyUI/models/diffusion_models/minimax_h3_ref2va_pruned_nvfp4.safetensors` | 12528636800 | `c813c5eabd85e275daccbf45e6f8ac4d9d14a1827d425e5be5070c92c60b78ac` |
| H3 Qwen text encoder | `Comfy-Org/MiniMax-H3` @ `eb8a16107c595128b3a578f82d2ce2f75920c355` | [`text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/eb8a16107c595128b3a578f82d2ce2f75920c355/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors) | `/workspace/ComfyUI/models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 15687142551 | `35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6` |
| H3 video VAE | `Comfy-Org/MiniMax-H3` @ `eb8a16107c595128b3a578f82d2ce2f75920c355` | [`vae/minimax_h3_video_vae_fp16.safetensors`](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/eb8a16107c595128b3a578f82d2ce2f75920c355/vae/minimax_h3_video_vae_fp16.safetensors) | `/workspace/ComfyUI/models/vae/minimax_h3_video_vae_fp16.safetensors` | 5207808496 | `7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522` |
| H3 audio VAE | `Comfy-Org/MiniMax-H3` @ `eb8a16107c595128b3a578f82d2ce2f75920c355` | [`vae/minimax_h3_audio_vae_fp32.safetensors`](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/eb8a16107c595128b3a578f82d2ce2f75920c355/vae/minimax_h3_audio_vae_fp32.safetensors) | `/workspace/ComfyUI/models/vae/minimax_h3_audio_vae_fp32.safetensors` | 605254808 | `8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48` |
| H3 Latent Upscaler 2x | `Mamad8/H3-Latent-Upscaler-2x` @ `d2245ba2ccd4e209007a9f80f2bfd6405861a95f` | [`h3_clean_latent_upscaler_v1_mamad8.safetensors`](https://huggingface.co/Mamad8/H3-Latent-Upscaler-2x/resolve/d2245ba2ccd4e209007a9f80f2bfd6405861a95f/h3_clean_latent_upscaler_v1_mamad8.safetensors) | `/workspace/ComfyUI/models/h3_latent_upscalers/h3_clean_latent_upscaler_v1_mamad8.safetensors` | 59022848 | `28005ed952a879f8e1d59903bf9c4440fa589d7a39280f960bb3dfb430219c71` |
| H3 Realism People LoRA | `fal/MiniMax-H3-Realism-People-LoRA` @ `039cc8579d7aa357a882d7f4111b25da4f72dccc` | [`h3-realism-people-t2v-i2v-r2v.safetensors`](https://huggingface.co/fal/MiniMax-H3-Realism-People-LoRA/resolve/039cc8579d7aa357a882d7f4111b25da4f72dccc/h3-realism-people-t2v-i2v-r2v.safetensors) | `/workspace/ComfyUI/models/loras/h3-realism-people-t2v-i2v-r2v.safetensors` | 131229656 | `acc529601d2da117fb81179e76c56e488a3beab1171659d305f04fa3655b787e` |
| SeedVR2 7B Sharp NVFP4 diffusion | `Comfy-Org/SeedVR2` @ `10f035adc869a5b3ffc466360b869641511c0610` | [`diffusion_models/seedvr2_7b_sharp_nvfp4.safetensors`](https://huggingface.co/Comfy-Org/SeedVR2/resolve/10f035adc869a5b3ffc466360b869641511c0610/diffusion_models/seedvr2_7b_sharp_nvfp4.safetensors) | `/workspace/ComfyUI/models/diffusion_models/seedvr2_7b_sharp_nvfp4.safetensors` | 4759694792 | `80d57af7722f5a5bd4c01d2ab2688f2bf05e552e59d3d3287257de709db10397` |
| SeedVR2 EMA VAE | `Comfy-Org/SeedVR2` @ `10f035adc869a5b3ffc466360b869641511c0610` | [`vae/seedvr2_ema_vae_fp16.safetensors`](https://huggingface.co/Comfy-Org/SeedVR2/resolve/10f035adc869a5b3ffc466360b869641511c0610/vae/seedvr2_ema_vae_fp16.safetensors) | `/workspace/ComfyUI/models/vae/seedvr2_ema_vae_fp16.safetensors` | 501324814 | `20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1` |

### 6.1.1 H3 Latent Upscaler（選配 profile）

custom node `ComfyUI-H3-Latent-Upscaler-Mamad8` 已由 `runtime-manifest.json` 固定至 `e98237773011523528353a8beb4863e65b099a38`。模型來源是 [`Mamad8/H3-Latent-Upscaler-2x`](https://huggingface.co/Mamad8/H3-Latent-Upscaler-2x) @ `d2245ba2ccd4e209007a9f80f2bfd6405861a95f`，現在已納入 `h3-bootstrap.sh` 自動下載；檔名必須是 `h3_clean_latent_upscaler_v1_mamad8.safetensors`，目的地為 `/workspace/ComfyUI/models/h3_latent_upscalers/`。

若要在既有容器不重跑完整 bootstrap 的情況下補裝，可執行：

```bash
set -euo pipefail
revision='d2245ba2ccd4e209007a9f80f2bfd6405861a95f'
dest='/workspace/ComfyUI/models/h3_latent_upscalers/h3_clean_latent_upscaler_v1_mamad8.safetensors'
mkdir -p /workspace/ComfyUI/models/h3_latent_upscalers
/venv/main/bin/hf download Mamad8/H3-Latent-Upscaler-2x \
  h3_clean_latent_upscaler_v1_mamad8.safetensors \
  --revision "$revision" \
  --local-dir /workspace/ComfyUI/models/h3_latent_upscalers
test "$(stat -c '%s' "$dest")" = 59022848
printf '%s  %s\n' '28005ed952a879f8e1d59903bf9c4440fa589d7a39280f960bb3dfb430219c71' "$dest" | sha256sum --check --status
supervisorctl restart comfyui
curl -fsS http://127.0.0.1:18188/system_stats >/dev/null
```

未安裝此模型時，SeedVR2 profile 仍可使用；H3 Latent profile 的 readiness 會保持未就緒，不會錯誤地退回 SeedVR2。

### 6.1.2 Wan2.2 Animate replacement 與 SAM2 遮罩

`wan22_animate_fp8` 是獨立的 replacement profile，不會共用 H3 diffusion 權重。它需要 Wan2.2 Animate 的 6 檔生成依賴、`ComfyUI-segment-anything-2` 的 SAM2 base-plus checkpoint，以及 `comfyui_controlnet_aux` 使用的兩個 DWPose 權重；缺少其中任一檔時，replacement 應保持未就緒，而不是顯示模型可用後才在節點執行時失敗。

| 功能 | Repo @ revision | HF source（固定 revision） | 容器 destination | bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| Wan2.2 Animate diffusion | `Kijai/WanVideo_comfy_fp8_scaled` @ `033a4e487f60220b3d6e469599a6aebc46e13cee` | [`Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors`](https://huggingface.co/Kijai/WanVideo_comfy_fp8_scaled/resolve/033a4e487f60220b3d6e469599a6aebc46e13cee/Wan22Animate/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors) | `/workspace/ComfyUI/models/diffusion_models/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors` | 18401760586 | `2936b31473a967e7a429a6646bba60e7862d0938e178b58b2a140f391dd5b8e6` |
| Wan Animate UMT5 text encoder | `Comfy-Org/Wan_2.1_ComfyUI_repackaged` @ `06e001fc51048fb03433a6fb25334de7836704a5` | [`umt5_xxl_fp8_e4m3fn_scaled.safetensors`](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/06e001fc51048fb03433a6fb25334de7836704a5/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors) | `/workspace/ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6735906897 | `c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68` |
| Wan Animate video VAE | `Comfy-Org/Wan_2.1_ComfyUI_repackaged` @ `06e001fc51048fb03433a6fb25334de7836704a5` | [`wan_2.1_vae.safetensors`](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/06e001fc51048fb03433a6fb25334de7836704a5/split_files/vae/wan_2.1_vae.safetensors) | `/workspace/ComfyUI/models/vae/wan_2.1_vae.safetensors` | 253815318 | `2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b` |
| Wan Animate CLIP Vision | `Comfy-Org/Wan_2.1_ComfyUI_repackaged` @ `06e001fc51048fb03433a6fb25334de7836704a5` | [`clip_vision_h.safetensors`](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/06e001fc51048fb03433a6fb25334de7836704a5/split_files/clip_vision/clip_vision_h.safetensors) | `/workspace/ComfyUI/models/clip_vision/clip_vision_h.safetensors` | 1264219396 | `64a7ef761bfccbadbaa3da77366aac4185a6c58fa5de5f589b42a65bcc21f161` |
| Wan Animate LightX2V LoRA | `Kijai/WanVideo_comfy` @ `8260d429d19fd7a72304cad059160b95d843913f` | [`lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors`](https://huggingface.co/Kijai/WanVideo_comfy/resolve/8260d429d19fd7a72304cad059160b95d843913f/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors) | `/workspace/ComfyUI/models/loras/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors` | 738005744 | `85c4a61c30e0497aa44b91d93a893b624708461a56fe5485183b28fa07e2dfb3` |
| Wan Animate relight LoRA | `Kijai/WanVideo_comfy` @ `8260d429d19fd7a72304cad059160b95d843913f` | [`WanAnimate_relight_lora_fp16.safetensors`](https://huggingface.co/Kijai/WanVideo_comfy/resolve/8260d429d19fd7a72304cad059160b95d843913f/LoRAs/Wan22_relight/WanAnimate_relight_lora_fp16.safetensors) | `/workspace/ComfyUI/models/loras/WanAnimate_relight_lora_fp16.safetensors` | 1436672440 | `fc646c74c73f4b251f5fd9bc440ef21b03b27305f499966c68b2b3aa31498561` |
| SAM2 Hiera base-plus | `Kijai/sam2-safetensors` @ `f885607d88bb3f9145efa49c3e3c50a9e5bf13eb` | [`sam2_hiera_base_plus.safetensors`](https://huggingface.co/Kijai/sam2-safetensors/resolve/f885607d88bb3f9145efa49c3e3c50a9e5bf13eb/sam2_hiera_base_plus.safetensors) | `/workspace/ComfyUI/models/sam2/sam2_hiera_base_plus.safetensors` | 323407992 | `fa02d9028dcc4859c191f1d3f1ca1f7eefdb85f3b5e746c9ad738f322f3e89e2` |
| Wan Animate DWPose YOLOX-L detector | `yzd-v/DWPose` @ `1a7144101628d69ee7a3768d1ee3a094070dc388` | [`yolox_l.onnx`](https://huggingface.co/yzd-v/DWPose/resolve/1a7144101628d69ee7a3768d1ee3a094070dc388/yolox_l.onnx) | `/workspace/ComfyUI/custom_nodes/comfyui_controlnet_aux/ckpts/yzd-v/DWPose/yolox_l.onnx` | 216746733 | `7860ae79de6c89a3c1eb72ae9a2756c0ccfbe04b7791bb5880afabd97855a411` |
| Wan Animate DWPose whole-body estimator | `hr16/DWPose-TorchScript-BatchSize5` @ `359d662a9b33b73f6d0f21732baf8845f17bb4be` | [`dw-ll_ucoco_384_bs5.torchscript.pt`](https://huggingface.co/hr16/DWPose-TorchScript-BatchSize5/resolve/359d662a9b33b73f6d0f21732baf8845f17bb4be/dw-ll_ucoco_384_bs5.torchscript.pt) | `/workspace/ComfyUI/custom_nodes/comfyui_controlnet_aux/ckpts/hr16/DWPose-TorchScript-BatchSize5/dw-ll_ucoco_384_bs5.torchscript.pt` | 135059124 | `d86a0b2b59fddc0901a7076e9f59c9f8602602133ed72511c693fd11eea23d91` |

本機 `download_models_linux.py --profile wan22_animate_fp8` 會下載上述 9 檔，DWPose 會放在 `custom_nodes/comfyui_controlnet_aux/ckpts/` 而不是一般模型目錄；雲端 `h3-bootstrap.sh` 則依完整 manifest 一次處理所有 20 檔。自動 mask 依賴 `ComfyUI-segment-anything-2`，其 `DownloadAndLoadSAM2Model` 節點使用 `models/sam2/` 目錄。若只使用 H3／SeedVR2，本機可以不下載這組 replacement 權重。

### 6.1.3 SCAIL-2 fallback 與 SAM3.1 自動遮罩

舊版 SCAIL-2 CLI replacement 仍保留作 fallback；它需要自己的 diffusion 權重，並共用 Wan UMT5／VAE。省略 `--mask-video` 時，CLI 會再呼叫 SAM3.1 產生人物追蹤遮罩，因此兩個檔案都列入完整 cloud bootstrap，避免只下載 SCAIL diffusion 後在自動遮罩階段才失敗。

| 功能 | Repo @ revision | HF source（固定 revision） | 容器 destination | bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| SCAIL-2 NVFP4 diffusion | `Comfy-Org/SCAIL-2` @ `3bb6077b807b1a0e80ba35a091042ec2b39dc20e` | [`wan2.1_14B_SCAIL_2_nvfp4_mxpf8_mix.safetensors`](https://huggingface.co/Comfy-Org/SCAIL-2/resolve/3bb6077b807b1a0e80ba35a091042ec2b39dc20e/diffusion_models/wan2.1_14B_SCAIL_2_nvfp4_mxpf8_mix.safetensors) | `/workspace/ComfyUI/models/diffusion_models/wan2.1_14B_SCAIL_2_nvfp4_mxpf8_mix.safetensors` | 11023570536 | `5053562142b46a12ef368360373304609ce6e6e010b3fddd35ef1cd27e180e7d` |
| SAM3.1 multiplex FP16 | `Comfy-Org/sam3.1` @ `5febd4769e8802cdfdb75e1f733abd8c68434a85` | [`sam3.1_multiplex_fp16.safetensors`](https://huggingface.co/Comfy-Org/sam3.1/resolve/5febd4769e8802cdfdb75e1f733abd8c68434a85/checkpoints/sam3.1_multiplex_fp16.safetensors) | `/workspace/ComfyUI/models/checkpoints/sam3.1_multiplex_fp16.safetensors` | 1745546848 | `9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03` |

本機若只跑 H3／Wan2.2 Animate，可不執行 `scail2_nvfp4` 或 `sam3_auto_mask` profile；使用 SCAIL CLI 時執行 `download_models_linux.py --profile scail2_nvfp4 --profile sam3_auto_mask`。

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

### 6.3 SAM3.1 replacement auto mask（資料表索引）

完整 cloud runtime 已納入此檔；若只在本機使用 H3／SeedVR2，才可省略 `sam3_auto_mask` profile。詳細用途與 SCAIL fallback 關係見 6.1.3。

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

1. 讀取版本化 `runtime-manifest.json`，固定 ComfyUI、custom nodes（包含 H3 Latent Upscaler）、H3/SeedVR2 模型與 Ollama inventory。
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

核對 inventory 表的每一列（完整 runtime 20 檔；若另選 remote img2img，再加 SDXL）之 size/hash。以下命令在**容器 Bash**提供可重複的檔案檢查：

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
check_model 59022848 28005ed952a879f8e1d59903bf9c4440fa589d7a39280f960bb3dfb430219c71 /workspace/ComfyUI/models/h3_latent_upscalers/h3_clean_latent_upscaler_v1_mamad8.safetensors
check_model 131229656 acc529601d2da117fb81179e76c56e488a3beab1171659d305f04fa3655b787e /workspace/ComfyUI/models/loras/h3-realism-people-t2v-i2v-r2v.safetensors
check_model 4759694792 80d57af7722f5a5bd4c01d2ab2688f2bf05e552e59d3d3287257de709db10397 /workspace/ComfyUI/models/diffusion_models/seedvr2_7b_sharp_nvfp4.safetensors
check_model 501324814 20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1 /workspace/ComfyUI/models/vae/seedvr2_ema_vae_fp16.safetensors
check_model 18401760586 2936b31473a967e7a429a6646bba60e7862d0938e178b58b2a140f391dd5b8e6 /workspace/ComfyUI/models/diffusion_models/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors
check_model 6735906897 c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68 /workspace/ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
check_model 253815318 2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b /workspace/ComfyUI/models/vae/wan_2.1_vae.safetensors
check_model 1264219396 64a7ef761bfccbadbaa3da77366aac4185a6c58fa5de5f589b42a65bcc21f161 /workspace/ComfyUI/models/clip_vision/clip_vision_h.safetensors
check_model 738005744 85c4a61c30e0497aa44b91d93a893b624708461a56fe5485183b28fa07e2dfb /workspace/ComfyUI/models/loras/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors
check_model 1436672440 fc646c74c73f4b251f5fd9bc440ef21b03b27305f499966c68b2b3aa31498561 /workspace/ComfyUI/models/loras/WanAnimate_relight_lora_fp16.safetensors
check_model 323407992 fa02d9028dcc4859c191f1d3f1ca1f7eefdb85f3b5e746c9ad738f322f3e89e2 /workspace/ComfyUI/models/sam2/sam2_hiera_base_plus.safetensors
check_model 216746733 7860ae79de6c89a3c1eb72ae9a2756c0ccfbe04b7791bb5880afabd97855a411 /workspace/ComfyUI/custom_nodes/comfyui_controlnet_aux/ckpts/yzd-v/DWPose/yolox_l.onnx
check_model 135059124 d86a0b2b59fddc0901a7076e9f59c9f8602602133ed72511c693fd11eea23d91 /workspace/ComfyUI/custom_nodes/comfyui_controlnet_aux/ckpts/hr16/DWPose-TorchScript-BatchSize5/dw-ll_ucoco_384_bs5.torchscript.pt
check_model 11023570536 5053562142b46a12ef368360373304609ce6e6e010b3fddd35ef1cd27e180e7d /workspace/ComfyUI/models/diffusion_models/wan2.1_14B_SCAIL_2_nvfp4_mxpf8_mix.safetensors
check_model 1745546848 9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03 /workspace/ComfyUI/models/checkpoints/sam3.1_multiplex_fp16.safetensors

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
2. H3 Latent Upscaler checkpoint 已固定 revision、size 與 SHA-256，並納入核心 bootstrap；既有容器可依 6.1.1 的單檔命令補裝。
3. supervisor 的 `comfyui` config／啟動參數仍由 base image 提供，未在 repo 固化；需把脫敏後設定納入未來 image/volume 規格。
4. Ollama pull 尚無 digest／size pin；保留舊容器 `ollama list`／`ollama show`，並在 registry 穩定後補上可驗證 digest。
5. SageAttention 目前只有 Windows cu130／Torch2.11／cp310 wheel pin；Linux Vast 需另找相容 build，不能直接沿用。
6. 現行 Vast 沒有 persistent volume；若不補 volume，任何 recycle／destroy 都必須重新下載模型、Ollama 與設定。
7. SDXL Turbo 仍是 remote img2img 選配；SAM3.1 已納入完整 runtime manifest，只有不使用 SCAIL／自動遮罩的本機部署才可省略。

## 13. Sources of truth

- [`scripts/vast/h3-bootstrap.sh`](../scripts/vast/h3-bootstrap.sh)／[`h3-bootstrap.conf`](../scripts/vast/h3-bootstrap.conf)：完整 runtime manifest 的 H3／SeedVR2／Wan Animate／SAM2／DWPose／SCAIL／SAM3 固定 revision、size/hash、staging、Ollama pull、ComfyUI restart。
- [`scripts/vast/seedvr2-bootstrap.sh`](../scripts/vast/seedvr2-bootstrap.sh)：SeedVR2 修復／獨立補裝。
- [`scripts/vast/ollama.sh`](../scripts/vast/ollama.sh)／[`ollama.conf`](../scripts/vast/ollama.conf)：loopback、模型根目錄與 supervisor runtime 環境。
- [`scripts/vast/start-tunnel.ps1`](../scripts/vast/start-tunnel.ps1)、[`start-vast-remote.ps1`](../scripts/vast/start-vast-remote.ps1)、[`status.ps1`](../scripts/vast/status.ps1)：SSH forward、Studio runtime 與健康檢查。
- [`scripts/vast/inspect-safetensors.py`](../scripts/vast/inspect-safetensors.py)：需要檢視 safetensors header／tensor data／trailing bytes 時使用。
- [`ComfyUI-H3-Latent-Upscaler-Mamad8`](https://github.com/mamad8c/ComfyUI-H3-Latent-Upscaler-Mamad8)：H3 clean-latent 2× custom node 上游。
- [`README.md`](../README.md)、[`package.json`](../package.json)、[`tests/video-upscale.test.mjs`](../tests/video-upscale.test.mjs)、[`tests/img2img.test.mjs`](../tests/img2img.test.mjs)：本機啟動、Node engine、SeedVR2／img2img readiness 與測試契約。
