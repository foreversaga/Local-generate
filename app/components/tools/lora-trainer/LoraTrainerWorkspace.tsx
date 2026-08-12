"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AssetPickerButton } from "../../library/AssetPickerButton";
import { assetKey, assetUrl, fetchAssetLibrary, type StudioAsset, type StudioAssetFolder, uploadAssets } from "../../library/asset-client";
import { FIELD_LABELS, jobStatusLabel } from "../../../lib/ui-copy.mjs";
import { loraTrainingProgress } from "../../../lib/job-adapter.mjs";
import {
  artifactDownloadUrl,
  cancelLoraJob,
  confirmCaptions,
  createLoraJob,
  enqueueLoraJob,
  fetchArtifact,
  fetchCaptions,
  fetchLoraJob,
  fetchLoraTrainingHealth,
  isLoraRevisionConflict,
  retryCaption,
  retryLoraJob,
  runPreflight,
  saveLoraConfig,
  startLoraJob,
  updateCaption,
  type ArtifactDetails,
  type CaptionRecord,
  type CaptionReviewMode,
  type LoraFamily,
  type LoraJob,
  type LoraTrainingConfig,
  type LoraTrainingHealth,
  type LoraTrainingHealthCheck,
  type PreflightResult,
} from "./lora-training-client";
import styles from "./LoraTrainerWorkspace.module.css";

type Stage = "dataset" | "captions" | "config" | "progress" | "artifact";

type HealthResource =
  | { key: string; status: "loaded"; health: LoraTrainingHealth }
  | { key: string; status: "error"; error: string };

const MAX_TRIGGER_WORDS = 20;
const NEW_UPLOAD_FOLDER = "__new_upload_folder__";

function parseTriggerWordsDraft(raw: string) {
  const seen = new Set<string>();
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { values, error: values.length > MAX_TRIGGER_WORDS ? `觸發詞最多只能有 ${MAX_TRIGGER_WORDS} 個。` : "" };
}

function fallbackTriggerWord(characterName: string) {
  const cleaned = characterName
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N} _.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .slice(0, 80)
    .trim();
  if (!cleaned || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) return "character";
  return cleaned;
}

function resolvedTrainingConfig(config: LoraTrainingConfig, triggerDraft: string): LoraTrainingConfig {
  const parsed = parseTriggerWordsDraft(triggerDraft);
  return {
    ...config,
    triggerWords: parsed.values.length ? parsed.values : [fallbackTriggerWord(config.characterName || config.outputName)],
  };
}

const STAGES: { id: Stage; label: string; short: string }[] = [
  { id: "dataset", label: "訓練資料", short: "01" },
  { id: "captions", label: "圖片描述", short: "02" },
  { id: "config", label: "設定與檢查", short: "03" },
  { id: "progress", label: "訓練進度", short: "04" },
  { id: "artifact", label: "完成", short: "05" },
];

const ACTIVE_STATUSES = new Set(["captioning", "queued", "training", "cancelling", "installing"]);
const QUEUEABLE_JOB_STATUSES = new Set(["draft", "ready", "preflight_failed"]);

const DEFAULT_CONFIG: LoraTrainingConfig = {
  family: "illustrious",
  baseProfile: "wai-illustrious",
  presetId: "illustrious-character-balanced",
  characterName: "my-character",
  outputName: "my-character-lora",
  triggerWords: [],
  overrides: { rank: 16, alpha: 16, learningRate: 0.0001, epochs: 10, batchSize: 1, resolution: 1024, seed: 42 },
};

function stageForJob(job: LoraJob | null): Stage {
  if (!job) return "dataset";
  if (["captioning", "caption_review", "caption_failed"].includes(job.status)) return "captions";
  if (["draft", "ready", "preflight_failed"].includes(job.status)) return job.dataset.imageCount ? "config" : "dataset";
  if (["queued", "training", "cancelling", "cancelled", "installing", "failed", "interrupted"].includes(job.status)) return "progress";
  return job.status === "completed" ? "artifact" : "dataset";
}

function isStage(value: string | null): value is Stage {
  return STAGES.some((stage) => stage.id === value);
}

function subscribeToLocation(onStoreChange: () => void) {
  window.addEventListener("popstate", onStoreChange);
  return () => window.removeEventListener("popstate", onStoreChange);
}

function getLocationSearch() {
  return window.location.search;
}

function getServerLocationSearch() {
  return "";
}

function friendlyError(reason: unknown, fallback: string) {
  const message = reason instanceof Error ? reason.message : fallback;
  return /triggerWords/i.test(message)
    ? "觸發詞必須是 1–20 個不重複且安全的值。"
    : message;
}

function formatBytes(value?: number) {
  if (!Number.isFinite(value)) return "—";
  if ((value || 0) < 1024 * 1024) return `${Math.round((value || 0) / 1024)} KB`;
  return `${((value || 0) / 1024 / 1024).toFixed(1)} MB`;
}

function formatEta(seconds?: number) {
  if (!Number.isFinite(seconds)) return "計算中";
  const minutes = Math.floor((seconds || 0) / 60);
  return `${minutes}m ${Math.round((seconds || 0) % 60)}s`;
}

function focusLoraField(id: string) {
  const element = document.getElementById(id);
  if (element instanceof HTMLElement) {
    element.focus();
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function healthCheckLabel(name: string) {
  const normalized = name.toLowerCase().replaceAll("_", "-");
  if (normalized.includes("python") || normalized.includes("venv")) return "Python 執行環境";
  if (normalized.includes("trainer") || normalized.includes("sd-scripts")) return "訓練器";
  if (normalized.includes("checkpoint") || normalized.includes("base-profile") || normalized.includes("base-model")) return "基礎模型檢查點";
  if (normalized.includes("lora-output") || normalized.includes("output") || normalized.includes("trained-root")) return "LoRA 輸出目錄";
  return name || "執行環境檢查";
}

function healthCheckPriority(check: LoraTrainingHealthCheck) {
  const label = healthCheckLabel(check.name);
  return ["Python 執行環境", "訓練器", "基礎模型檢查點", "LoRA 輸出目錄"].indexOf(label) + 1 || 5;
}

function importantFailedChecks(health: LoraTrainingHealth | null) {
  return (health?.checks || [])
    .filter((check) => !check.ok)
    .sort((left, right) => healthCheckPriority(left) - healthCheckPriority(right))
    .slice(0, 4);
}

function healthCheckDetail(check: LoraTrainingHealthCheck) {
  const detail = check.message || check.error || "尚未就緒。";
  return check.path ? `${detail} · ${check.path}` : detail;
}

export function LoraTrainerWorkspace() {
  const locationSearch = useSyncExternalStore(subscribeToLocation, getLocationSearch, getServerLocationSearch);
  const requestedStage = useMemo(() => {
    const value = new URLSearchParams(locationSearch).get("step");
    return isStage(value) ? value : null;
  }, [locationSearch]);
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [inputFolders, setInputFolders] = useState<StudioAssetFolder[]>([]);
  const [uploadFolderMode, setUploadFolderMode] = useState<"existing" | "new">("existing");
  const [uploadFolder, setUploadFolder] = useState("");
  const [newUploadFolder, setNewUploadFolder] = useState("");
  const [mode, setMode] = useState<CaptionReviewMode>("auto");
  const [config, setConfig] = useState<LoraTrainingConfig>(DEFAULT_CONFIG);
  const [triggerDraft, setTriggerDraft] = useState(DEFAULT_CONFIG.characterName);
  const [job, setJob] = useState<LoraJob | null>(null);
  const [stageOverride, setStage] = useState<Stage | null>(null);
  const stage = stageOverride || requestedStage || "dataset";
  const [captions, setCaptions] = useState<CaptionRecord[]>([]);
  const [captionDrafts, setCaptionDrafts] = useState<Record<string, string>>({});
  const [captionCursor, setCaptionCursor] = useState<string | null>(null);
  const [captionPage, setCaptionPage] = useState(1);
  const [captionPageCursors, setCaptionPageCursors] = useState<(string | null)[]>([null]);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [artifact, setArtifact] = useState<ArtifactDetails | null>(null);
  const [healthResource, setHealthResource] = useState<HealthResource | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [triggerError, setTriggerError] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const triggerDraftCustomizedRef = useRef(false);
  const actionLockRef = useRef("");
  const requestSequenceRef = useRef(0);
  const activeJobIdRef = useRef<string | null>(null);
  const latestJobRevisionRef = useRef(-1);

  useEffect(() => {
    if (stage !== "dataset") return;
    let cancelled = false;
    void fetchAssetLibrary().then((library) => {
      if (cancelled) return;
      setInputFolders(library.folders
        .filter((folder) => folder.root === "input")
        .sort((left, right) => left.path.localeCompare(right.path)));
    }).catch(() => {
      // The root option remains available even if the folder listing is temporarily unavailable.
    });
    return () => { cancelled = true; };
  }, [stage]);

  const commitJob = useCallback((next: LoraJob) => {
    if (activeJobIdRef.current === next.id && next.revision < latestJobRevisionRef.current) return false;
    if (activeJobIdRef.current !== next.id) latestJobRevisionRef.current = next.revision;
    else latestJobRevisionRef.current = Math.max(latestJobRevisionRef.current, next.revision);
    activeJobIdRef.current = next.id;
    // Invalidate every in-flight poll from before this canonical mutation.
    requestSequenceRef.current += 1;
    const persistedConfig = next.config && typeof next.config === "object" ? next.config : {};
    const persistedCharacterName = next.characterName || persistedConfig.characterName || next.displayName || "";
    const persistedOutputName = next.outputName || persistedConfig.outputName || "";
    const persistedTriggerWords = (next.triggerWords || persistedConfig.triggerWords || [])
      .filter((word): word is string => typeof word === "string" && Boolean(word.trim()))
      .map((word) => word.trim());
    if (persistedCharacterName || persistedOutputName || persistedTriggerWords.length) {
      setConfig((current) => ({
        ...current,
        ...persistedConfig,
        ...(persistedCharacterName ? { characterName: persistedCharacterName } : {}),
        ...(persistedOutputName ? { outputName: persistedOutputName } : {}),
        ...(persistedTriggerWords.length ? { triggerWords: persistedTriggerWords } : {}),
      }));
      if (persistedTriggerWords.length) {
        setTriggerDraft(persistedTriggerWords.join(", "));
        triggerDraftCustomizedRef.current = persistedTriggerWords.join(", ") !== persistedCharacterName;
      } else if (persistedCharacterName) {
        setTriggerDraft(persistedCharacterName);
        triggerDraftCustomizedRef.current = false;
      }
    }
    setJob(next);
    return true;
  }, []);

  function tryLockAction(key: string) {
    if (actionLockRef.current) return false;
    actionLockRef.current = key;
    return true;
  }

  function unlockAction(key: string) {
    if (actionLockRef.current === key) actionLockRef.current = "";
  }

  const selectedKeys = useMemo(() => assets.map(assetKey), [assets]);
  const canonicalStage = stageForJob(job);
  const jobId = job?.id;
  const jobStatus = job?.status;
  const canQueueJob = !job || QUEUEABLE_JOB_STATUSES.has(job.status);
  const selectedFamily = config.family;
  const selectedBaseProfile = config.baseProfile;
  const healthKey = `${selectedFamily}:${selectedBaseProfile}`;
  const currentHealth = healthResource?.key === healthKey && healthResource.status === "loaded" ? healthResource.health : null;
  const healthNetworkWarning = healthResource?.key === healthKey && healthResource.status === "error" ? healthResource.error : "";
  const healthLoading = healthResource?.key !== healthKey;
  const healthBlocked = currentHealth?.ok === false;
  const failedHealthChecks = useMemo(() => importantFailedChecks(currentHealth), [currentHealth]);
  const healthBlockReason = healthBlocked
    ? `訓練環境尚需設定${failedHealthChecks.length ? `：${failedHealthChecks.map((check) => healthCheckLabel(check.name)).join("、")}` : ""}。`
    : "";
  const healthDisplayState = healthLoading ? "checking" : healthNetworkWarning ? "warning" : currentHealth?.ok ? "ready" : "blocked";
  const healthTitle = healthDisplayState === "ready"
    ? "訓練環境已就緒"
    : healthDisplayState === "blocked"
      ? "訓練環境尚需設定"
      : healthDisplayState === "warning"
        ? "無法確認訓練環境狀態"
        : "正在檢查訓練環境狀態";
  const hasMeasuredProgress = Number.isFinite(job?.training.totalSteps) && (job?.training.totalSteps || 0) > 0;
  const progress = hasMeasuredProgress
    ? loraTrainingProgress(job)
    : job?.status === "completed" ? 100 : job?.status === "installing" ? 99 : 0;
  const progressStateLabel = job?.status === "queued"
    ? "等待 GPU"
    : job?.status === "training"
      ? "啟動訓練中"
      : "尚未開始";

  const loadJob = useCallback(async (id: string, quiet = false) => {
    const requestSequence = ++requestSequenceRef.current;
    if (!quiet) setBusy("loading");
    try {
      const next = await fetchLoraJob(id);
      if (
        requestSequence !== requestSequenceRef.current
        || (activeJobIdRef.current && activeJobIdRef.current !== id)
        || (activeJobIdRef.current === id && next.revision < latestJobRevisionRef.current)
      ) return null;
      if (!commitJob(next)) return null;
      setStage(stageForJob(next));
      setError("");
      return next;
    } catch (reason) {
      if (requestSequence !== requestSequenceRef.current || (activeJobIdRef.current && activeJobIdRef.current !== id)) return null;
      if (!quiet) setError(friendlyError(reason, "無法載入訓練工作。"));
      return null;
    } finally {
      if (requestSequence === requestSequenceRef.current && !quiet) setBusy("");
    }
  }, [commitJob]);

  const loadCaptionPage = useCallback(async (id: string, cursor?: string, page = 1) => {
    setBusy("captions");
    try {
      const result = await fetchCaptions(id, cursor);
      setCaptions(result.captions);
      setCaptionDrafts(Object.fromEntries(result.captions.map((item) => [item.imageId, item.caption])));
      setCaptionCursor(result.nextCursor);
      setCaptionPage(page);
      if (page === 1) setCaptionPageCursors([null]);
      setError("");
    } catch (reason) {
      setError(friendlyError(reason, "無法載入圖片描述。"));
    } finally {
      setBusy("");
    }
  }, []);

  async function reportActionError(reason: unknown, fallback: string, id?: string) {
    if (isLoraRevisionConflict(reason) && id) {
      const latest = await loadJob(id, true);
      if (latest) {
        const actual = Number.isSafeInteger(latest.revision) ? ` revision ${latest.revision}` : "";
        setError(`工作資料已更新${actual}，已重新整理，請再次執行。`);
        return;
      }
    }
    setError(friendlyError(reason, fallback));
  }

  useEffect(() => {
    const requestKey = healthKey;
    let cancelled = false;

    void fetchLoraTrainingHealth(selectedFamily, selectedBaseProfile).then(
      (health) => {
        if (!cancelled) setHealthResource({ key: requestKey, status: "loaded", health });
      },
      (reason) => {
        if (!cancelled) setHealthResource({
          key: requestKey,
          status: "error",
          error: friendlyError(reason, "無法連線訓練環境檢查服務。"),
        });
      },
    );

    return () => { cancelled = true; };
  }, [healthKey, selectedBaseProfile, selectedFamily]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedJob = params.get("job");
    if (!requestedJob) return;
    let cancelled = false;
    const requestSequence = ++requestSequenceRef.current;

    void fetchLoraJob(requestedJob).then(
      (nextJob) => {
        if (cancelled || requestSequence !== requestSequenceRef.current || (activeJobIdRef.current && activeJobIdRef.current !== requestedJob)) return;
        if (!commitJob(nextJob)) return;
        setStage(stageForJob(nextJob));
        setError("");
      },
      (reason) => {
        if (!cancelled) setError(friendlyError(reason, "無法載入訓練工作。"));
      },
    );

    return () => { cancelled = true; };
  }, [commitJob]);

  useEffect(() => {
    if (!job) return;
    const url = new URL(window.location.href);
    url.searchParams.set("job", job.id);
    url.searchParams.set("step", canonicalStage);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [canonicalStage, job]);

  useEffect(() => {
    if (!job || !ACTIVE_STATUSES.has(job.status)) return;
    const timer = window.setInterval(() => { void loadJob(job.id, true); }, 2000);
    return () => window.clearInterval(timer);
  }, [job, loadJob]);

  useEffect(() => {
    if (!jobId || stage !== "captions") return;
    let cancelled = false;

    void fetchCaptions(jobId).then(
      (result) => {
        if (cancelled) return;
        setCaptions(result.captions);
        setCaptionDrafts(Object.fromEntries(result.captions.map((item) => [item.imageId, item.caption])));
        setCaptionCursor(result.nextCursor);
        setCaptionPage(1);
        setCaptionPageCursors([null]);
        setError("");
      },
      (reason) => {
        if (!cancelled) setError(friendlyError(reason, "無法載入圖片描述。"));
      },
    );

    return () => { cancelled = true; };
  }, [jobId, stage]);

  useEffect(() => {
    if (!jobId || jobStatus !== "completed") return;
    let cancelled = false;

    void fetchArtifact(jobId).then(
      (nextArtifact) => {
        if (!cancelled) setArtifact(nextArtifact);
      },
      (reason) => {
        if (!cancelled) setError(friendlyError(reason, "無法載入模型產物。"));
      },
    );

    return () => { cancelled = true; };
  }, [jobId, jobStatus]);

  function chooseAssets(next: StudioAsset[]) {
    setAssets(next);
    setError("");
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files || [])].filter((file) => file.type.startsWith("image/"));
    event.target.value = "";
    if (!files.length) return;
    if (uploadFolderMode === "new" && !newUploadFolder.trim()) {
      setError("請先輸入新的資料夾名稱。");
      return;
    }
    setBusy("upload");
    try {
      const targetFolder = uploadFolderMode === "new" ? newUploadFolder.trim() : uploadFolder;
      const uploaded = await uploadAssets(files, targetFolder);
      setAssets((current) => [...current, ...uploaded].slice(0, 50));
      if (targetFolder) {
        setUploadFolderMode("existing");
        setUploadFolder(targetFolder);
        setNewUploadFolder("");
      }
      try {
        const library = await fetchAssetLibrary();
        setInputFolders(library.folders
          .filter((folder) => folder.root === "input")
          .sort((left, right) => left.path.localeCompare(right.path)));
      } catch {
        // The upload already succeeded; a stale folder list can refresh on the next stage visit.
      }
      setNotice(`已加入 ${uploaded.length} 張圖片。`);
      setError("");
    } catch (reason) {
      setError(friendlyError(reason, "圖片上傳失敗。"));
    } finally {
      setBusy("");
    }
  }

  function patchConfig<K extends keyof LoraTrainingConfig>(key: K, value: LoraTrainingConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
    setPreflight(null);
  }

  function patchCharacterName(value: string) {
    patchConfig("characterName", value);
    if (triggerDraftCustomizedRef.current) return;
    const parsed = parseTriggerWordsDraft(value);
    setTriggerDraft(value);
    setTriggerError(parsed.error);
    patchConfig("triggerWords", parsed.values);
  }

  function patchTriggerDraft(value: string) {
    triggerDraftCustomizedRef.current = true;
    const parsed = parseTriggerWordsDraft(value);
    setTriggerDraft(value);
    setTriggerError(parsed.error);
    patchConfig("triggerWords", parsed.values);
  }

  function patchOverride(key: keyof NonNullable<LoraTrainingConfig["overrides"]>, raw: string) {
    const value = Number(raw);
    setConfig((current) => ({ ...current, overrides: { ...current.overrides, [key]: Number.isFinite(value) ? value : undefined } }));
    setPreflight(null);
  }

  async function beginTraining() {
    if (!assets.length) {
      setError("請先選擇至少一張訓練圖片。");
      setStage("dataset");
      focusLoraField("lora-asset-picker");
      return;
    }
    if (!config.characterName.trim()) {
      setError("請填寫角色名稱。");
      setStage("config");
      focusLoraField("lora-character-name");
      return;
    }
    if (!config.outputName.trim()) {
      setError("請填寫模型名稱。");
      setStage("config");
      focusLoraField("lora-output-name");
      return;
    }
    const parsedTriggerWords = parseTriggerWordsDraft(triggerDraft);
    if (parsedTriggerWords.error) {
      setTriggerError(parsedTriggerWords.error);
      setError("請先修正觸發詞，再開始訓練。");
      setStage("config");
      focusLoraField("trigger-words");
      return;
    }
    if (healthBlocked) {
      setError(`${healthBlockReason} 請先完成上方檢查項目。`);
      focusLoraField("lora-health-summary");
      return;
    }
    const resolvedConfig = resolvedTrainingConfig(config, triggerDraft);
    setConfig(resolvedConfig);
    setTriggerError("");
    const actionKey = "start";
    if (!tryLockAction(actionKey)) return;
    let createdId: string | undefined;
    setBusy("start"); setError(""); setNotice("");
    try {
      const created = await createLoraJob({ sourceAssetIds: assets.map(assetKey), captionReviewMode: mode, config: resolvedConfig });
      createdId = created.id;
      commitJob(created);
      const started = await startLoraJob(created.id, { revision: created.revision, captionReviewMode: mode, config: resolvedConfig });
      commitJob(started);
      setStage(stageForJob(started));
      // The start response is canonical; any conflict below can safely refetch it.
      setNotice(mode === "manual" ? "已建立工作；圖片描述完成後請逐一檢查並確認。" : "已建立工作，系統會自動檢查並排入訓練。所需時間依 GPU 與佇列而定。 ");
    } catch (reason) {
      await reportActionError(reason, "無法開始 LoRA 訓練。", createdId);
    } finally { setBusy(""); unlockAction(actionKey); }
  }

  async function saveCaption(record: CaptionRecord) {
    if (!job) return;
    const value = (captionDrafts[record.imageId] || "").trim();
    if (!value) { setError("圖片描述不可為空白。"); return; }
    const actionKey = `caption:${record.imageId}`;
    if (!tryLockAction(actionKey)) return;
    setBusy(`caption-${record.imageId}`);
    try {
      commitJob(await updateCaption(job.id, record.imageId, value, job.revision));
      setNotice(`已儲存 ${record.imageFile}。`); setError("");
      await loadCaptionPage(job.id, undefined, 1);
    } catch (reason) { await reportActionError(reason, "圖片描述儲存失敗。", job.id); }
    finally { setBusy(""); unlockAction(actionKey); }
  }

  async function retryOneCaption(record: CaptionRecord) {
    if (!job) return;
    const actionKey = `caption:${record.imageId}`;
    if (!tryLockAction(actionKey)) return;
    setBusy(`caption-${record.imageId}`);
    try {
      commitJob(await retryCaption(job.id, record.imageId, job.revision));
      setNotice(`正在重新產生 ${record.imageFile}。`); setError("");
      await loadCaptionPage(job.id, undefined, 1);
    } catch (reason) { await reportActionError(reason, "無法重試圖片描述。", job.id); }
    finally { setBusy(""); unlockAction(actionKey); }
  }

  async function confirmCaptionReview() {
    if (!job) return;
    const actionKey = "confirm";
    if (!tryLockAction(actionKey)) return;
    let confirmedJob: LoraJob | undefined;
    setBusy("confirm");
    try {
      const next = await confirmCaptions(job.id, job.revision);
      confirmedJob = next;
      commitJob(next);
      setStage(stageForJob(next)); setNotice("圖片描述已鎖定，可以執行訓練前檢查。"); setError("");
    } catch (reason) { await reportActionError(reason, "無法確認圖片描述。", job.id); }
    finally { setBusy(""); unlockAction(actionKey); if (confirmedJob) setStage(stageForJob(confirmedJob)); }
  }

  async function checkAndQueue() {
    if (!job) return;
    if (!QUEUEABLE_JOB_STATUSES.has(job.status)) {
      setStage(stageForJob(job));
      setError("此工作已進入佇列或已結束，無法重複執行 preflight。");
      return;
    }
    const parsedTriggerWords = parseTriggerWordsDraft(triggerDraft);
    if (parsedTriggerWords.error) {
      setTriggerError(parsedTriggerWords.error);
      setError("請先修正觸發詞，再開始訓練。");
      setStage("config");
      focusLoraField("trigger-words");
      return;
    }
    if (!config.characterName.trim()) {
      setError("請填寫角色名稱。");
      setStage("config");
      focusLoraField("lora-character-name");
      return;
    }
    if (!config.outputName.trim()) {
      setError("請填寫模型名稱。");
      setStage("config");
      focusLoraField("lora-output-name");
      return;
    }
    if (healthBlocked) {
      setError(`${healthBlockReason} 請先完成上方檢查項目。`);
      focusLoraField("lora-health-summary");
      return;
    }
    const resolvedConfig = resolvedTrainingConfig(config, triggerDraft);
    setConfig(resolvedConfig);
    setTriggerError("");
    const actionKey = "preflight";
    if (!tryLockAction(actionKey)) return;
    setBusy("preflight"); setPreflight(null);
    try {
      const saved = await saveLoraConfig(job.id, resolvedConfig, job.revision);
      commitJob(saved);
      const result = await runPreflight(saved.id, saved.revision);
      setPreflight(result);
      const preflightJob = result.job || await fetchLoraJob(saved.id);
      commitJob(preflightJob);
      const hasFailure = result.status === "fail" || result.checks.some((check) => check.status === "fail");
      if (hasFailure || !result.preflightToken) {
        setError(hasFailure ? "訓練前檢查未通過；請修正下列項目後重試。" : "伺服器未提供 preflight token，尚未排入佇列。");
        return;
      }
      const queued = await enqueueLoraJob(preflightJob.id, preflightJob.revision, result.preflightToken);
      commitJob(queued);
      setStage(stageForJob(queued)); setNotice("訓練已排入 FIFO 佇列。"); setError("");
    } catch (reason) { await reportActionError(reason, "訓練前檢查或排程失敗。", job.id); }
    finally { setBusy(""); unlockAction(actionKey); }
  }

  async function cancelJob() {
    if (!job || !window.confirm("確定取消這個 LoRA 訓練工作？已完成的步驟不會產生可用模型。")) return;
    const actionKey = "cancel";
    if (!tryLockAction(actionKey)) return;
    setBusy("cancel");
    try { commitJob(await cancelLoraJob(job.id)); setNotice("已送出取消要求。"); setError(""); }
    catch (reason) { await reportActionError(reason, "無法取消訓練。", job.id); }
    finally { setBusy(""); unlockAction(actionKey); }
  }

  async function retryJob() {
    if (!job) return;
    const actionKey = "retry";
    if (!tryLockAction(actionKey)) return;
    setBusy("retry");
    try {
      const next = await retryLoraJob(job.id);
      commitJob(next);
      setStage(stageForJob(next)); setNotice(`已建立重試工作 ${next.id}。`); setError("");
    } catch (reason) { await reportActionError(reason, "無法重試訓練。", job.id); }
    finally { setBusy(""); unlockAction(actionKey); }
  }

  return (
    <div className={styles.workspace}>
      <nav className={styles.stepper} aria-label="LoRA 訓練步驟">
        {STAGES.map((item) => {
          const current = item.id === stage;
          const enabled = !job || item.id === canonicalStage || (item.id === "dataset" && job.status === "draft");
          return <button key={item.id} type="button" className={current ? styles.currentStep : ""} aria-current={current ? "step" : undefined} disabled={!enabled} onClick={() => setStage(item.id)}><span>{item.short}</span>{item.label}</button>;
        })}
      </nav>

      <section id="lora-health-summary" className={styles.readiness} data-state={healthDisplayState} tabIndex={-1} aria-live="polite" aria-atomic="true">
        <div className={styles.readinessHeader}>
          <span className={styles.readinessMark} aria-hidden="true" />
          <div>
            <strong>{healthTitle}</strong>
            <p>{healthDisplayState === "ready"
              ? `${selectedFamily.toUpperCase()} · ${selectedBaseProfile} 可開始訓練。`
              : healthDisplayState === "blocked"
                ? "完成下列執行環境與模型設定後才能開始訓練。"
                : healthDisplayState === "warning"
                  ? `${healthNetworkWarning} 此連線錯誤不阻擋提交，正式檢查仍會再次執行。`
                  : `正在確認 ${selectedFamily.toUpperCase()} · ${selectedBaseProfile}。`}</p>
          </div>
          <span className={styles.readinessProfile}>{selectedFamily} / {selectedBaseProfile}</span>
        </div>
        {healthBlocked && failedHealthChecks.length > 0 && <ul className={styles.readinessChecks}>
          {failedHealthChecks.map((check) => <li key={check.name}><strong>{healthCheckLabel(check.name)}</strong><span>{healthCheckDetail(check)}</span></li>)}
        </ul>}
        {healthBlocked && <p className={styles.setupHint}>先執行 <code>scripts/setup-lora-trainer.ps1</code>，再確認 Python 執行環境、訓練器、基礎模型檢查點與 LoRA 輸出目錄。</p>}
      </section>

      {(error || notice || job?.error) && <div className={styles.feedback} aria-live="polite">
        {error && <p className={styles.error} role="alert">{error}</p>}
        {!error && job?.error && <p className={styles.error} role="alert"><strong>{job.error.code}</strong> · {job.error.message}</p>}
        {notice && <p className={styles.notice}>{notice}</p>}
      </div>}

      <div className={styles.layout}>
        <main className={styles.main}>
          {stage === "dataset" && <section className={styles.panel} aria-labelledby="dataset-title">
            <header className={styles.sectionHeader}><div><span>01 / 訓練資料</span><h2 id="dataset-title">選擇訓練圖片</h2><p>建議使用 10–30 張主體一致、構圖與角度有變化的清晰圖片。</p></div><span className={styles.count}>{assets.length} / 50</span></header>
             <div className={styles.identityPanel} aria-labelledby="dataset-identity-title">
               <div className={styles.identityHeader}>
                 <strong id="dataset-identity-title">訓練前設定</strong>
                 <p>開始訓練前先設定角色名稱與提示詞觸發詞；觸發詞預設會跟隨角色名稱。</p>
               </div>
               <div className={styles.formGrid}>
                 <label className={styles.field}>
                   <span>角色名稱（提示詞中的觸發名稱）</span>
                   <input id="lora-dataset-character-name" value={config.characterName} aria-invalid={!config.characterName.trim()} aria-describedby="dataset-character-name-help" onChange={(event) => patchCharacterName(event.target.value)} />
                   <small id="dataset-character-name-help">這個名稱會顯示在訓練產物中，也會作為預設觸發詞。</small>
                 </label>
                 <label className={styles.field}>
                   <span>觸發詞</span>
                   <input id="lora-dataset-trigger-words" value={triggerDraft} aria-invalid={Boolean(triggerError)} aria-describedby={triggerError ? "dataset-trigger-words-help dataset-trigger-words-error" : "dataset-trigger-words-help"} onChange={(event) => patchTriggerDraft(event.target.value)} placeholder={config.characterName || "my_character"} />
                   <small id="dataset-trigger-words-help">生成提示詞時使用；可用逗號分隔多個觸發詞。</small>
                   {triggerError && <p id="dataset-trigger-words-error" className={styles.inlineError} role="alert">{triggerError}</p>}
                 </label>
               </div>
             </div>
             <div className={styles.assetGrid}>
              {assets.map((asset) => <article key={assetKey(asset)} className={styles.assetCard}>
                {/* eslint-disable-next-line @next/next/no-img-element -- Dynamic local bridge asset. */}
                <img src={assetUrl(asset)} alt="" />
                <div><strong title={asset.name}>{asset.name}</strong><button type="button" onClick={() => setAssets((items) => items.filter((item) => assetKey(item) !== assetKey(asset)))} aria-label={`移除 ${asset.name}`}>移除</button></div>
              </article>)}
              {!assets.length && <div className={styles.empty}><strong>尚未選擇圖片</strong><span>從素材庫挑選，或上傳本機 JPG、PNG、WebP。</span></div>}
            </div>
            <label className={styles.field}>
              <span>上傳到 ComfyUI/input</span>
              <select
                aria-label="LoRA 上傳到 input 資料夾"
                value={uploadFolderMode === "new" ? NEW_UPLOAD_FOLDER : uploadFolder}
                onChange={(event) => {
                  if (event.target.value === NEW_UPLOAD_FOLDER) {
                    setUploadFolderMode("new");
                  } else {
                    setUploadFolderMode("existing");
                    setUploadFolder(event.target.value);
                  }
                }}
                disabled={busy === "upload"}
              >
                <option value="">ComfyUI/input（根目錄）</option>
                {inputFolders.map((folder) => <option key={folder.path} value={folder.path}>{folder.path}</option>)}
                <option value={NEW_UPLOAD_FOLDER}>建立新的資料夾…</option>
              </select>
            </label>
            {uploadFolderMode === "new" && (
              <label className={styles.field}>
                <span>新資料夾名稱</span>
                <input
                  aria-label="LoRA 新資料夾名稱"
                  value={newUploadFolder}
                  onChange={(event) => setNewUploadFolder(event.target.value)}
                  placeholder="例如 training/新角色"
                  disabled={busy === "upload"}
                />
              </label>
            )}
            <div className={styles.actions}>
              <AssetPickerButton triggerId="lora-asset-picker" assetSource="training" kind="image" multiple max={50} selectedKeys={selectedKeys} onSelect={chooseAssets} label="選擇訓練素材" />
              <input ref={uploadRef} className={styles.hiddenInput} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={handleUpload} />
              <button className={styles.secondaryButton} type="button" onClick={() => uploadRef.current?.click()} disabled={busy === "upload"}>{busy === "upload" ? "上傳中…" : "上傳本機圖片"}</button>
            </div>
            <fieldset className={styles.modePicker}><legend>圖片描述檢查模式</legend>
              <label htmlFor="caption-mode-auto"><input id="caption-mode-auto" type="radio" name="caption-mode" value="auto" checked={mode === "auto"} onChange={() => setMode("auto")} />自動<span><small>通過結構驗證後自動執行檢查並排程。</small></span></label>
              <label htmlFor="caption-mode-manual"><input id="caption-mode-manual" type="radio" name="caption-mode" value="manual" checked={mode === "manual"} onChange={() => setMode("manual")} />手動<span><small>逐張編輯、重試並確認圖片描述後再訓練。</small></span></label>
            </fieldset>
                <div className={styles.primaryRow}><span>{healthBlocked ? `${healthBlockReason} 點擊開始後會導向檢查結果。` : "建立後可用網址中的工作編號恢復進度。"}</span><button className={styles.primaryButton} type="button" aria-describedby="lora-health-summary" onClick={beginTraining} disabled={Boolean(busy)}>{busy === "start" ? "建立工作中…" : "開始訓練"}</button></div>
          </section>}

          {stage === "captions" && <section className={styles.panel} aria-labelledby="captions-title">
            <header className={styles.sectionHeader}><div><span>02 / 圖片描述</span><h2 id="captions-title">檢查圖片描述</h2><p>{job?.status === "captioning" ? "Gemma 正在產生描述，完成後會自動更新。" : "修正錯誤或不準確的描述；每張圖片都必須有有效的圖片描述。"}</p></div><span className={styles.count}>{job?.captions.confirmed || 0} / {job?.captions.total || 0}</span></header>
            {busy === "captions" && !captions.length && <p className={styles.muted}>載入圖片描述中…</p>}
            <div className={styles.captionList}>{captions.map((record) => {
              const fieldId = `caption-${record.imageId}`; const errorId = `${fieldId}-error`; const itemBusy = busy === `caption-${record.imageId}`;
              return <article key={record.imageId} className={styles.captionCard}>
                <div className={styles.captionMeta}><strong>{record.imageFile}</strong><span data-status={record.status}>{jobStatusLabel(record.status, "lora")}</span><small>嘗試 {record.attempts} 次 · {record.model}</small></div>
                <label htmlFor={fieldId}>圖片描述</label><textarea id={fieldId} value={captionDrafts[record.imageId] ?? record.caption} aria-invalid={record.status === "failed"} aria-describedby={record.error ? errorId : undefined} onChange={(event) => setCaptionDrafts((items) => ({ ...items, [record.imageId]: event.target.value }))} />
                {record.error && <p id={errorId} className={styles.inlineError}>{record.error.message}</p>}
                <div className={styles.cardActions}><button type="button" className={styles.secondaryButton} onClick={() => void saveCaption(record)} disabled={itemBusy}>儲存</button><button type="button" className={styles.textButton} onClick={() => void retryOneCaption(record)} disabled={itemBusy}>重新產生</button></div>
              </article>;
            })}</div>
            <div className={styles.pagination}><button type="button" className={styles.secondaryButton} disabled={captionPage === 1 || busy === "captions"} onClick={() => { if (!job || captionPage === 1) return; const previousPage = captionPage - 1; const previousCursor = captionPageCursors[previousPage - 1]; setCaptionPageCursors((items) => items.slice(0, previousPage)); void loadCaptionPage(job.id, previousCursor || undefined, previousPage); }}>上一頁</button><span>第 {captionPage} 頁</span><button type="button" className={styles.secondaryButton} disabled={!captionCursor || busy === "captions"} onClick={() => { if (!job || !captionCursor) return; setCaptionPageCursors((items) => [...items.slice(0, captionPage), captionCursor]); void loadCaptionPage(job.id, captionCursor, captionPage + 1); }}>下一頁</button></div>
            {job?.captionReviewMode === "manual" && job.status === "caption_review" && <div className={styles.primaryRow}><span>確認後圖片描述將鎖定；仍有失敗項目時伺服器會拒絕。</span><button className={styles.primaryButton} type="button" onClick={confirmCaptionReview} disabled={Boolean(busy)}>確認全部圖片描述</button></div>}
          </section>}

          {stage === "config" && <section className={styles.panel} aria-labelledby="config-title">
            <header className={styles.sectionHeader}><div><span>03 / 設定與檢查</span><h2 id="config-title">確認訓練設定</h2><p>先從簡化設定開始；進階值會由伺服器允許清單與範圍再次驗證。</p></div></header>
            <div className={styles.formGrid}>
              <label className={styles.field}><span>模型系列</span><select value={config.family} onChange={(event) => { const family = event.target.value as LoraFamily; patchConfig("family", family); patchConfig("baseProfile", family === "sdxl" ? "sdxl-base-1.0" : "wai-illustrious"); patchConfig("presetId", family === "sdxl" ? "sdxl-character-balanced" : "illustrious-character-balanced"); }}><option value="sdxl">SDXL</option><option value="illustrious">Illustrious</option></select></label>
              <label className={styles.field}><span>基礎模型設定檔</span><select value={config.baseProfile} onChange={(event) => patchConfig("baseProfile", event.target.value)}>{config.family === "sdxl" ? <option value="sdxl-base-1.0">SDXL Base 1.0</option> : <option value="wai-illustrious">WAI Illustrious</option>}</select></label>
              <label className={styles.field}><span>預設樣式</span><select value={config.presetId} onChange={(event) => patchConfig("presetId", event.target.value)}><option value={`${config.family}-character-balanced`}>角色 · 平衡</option><option value={`${config.family}-style-balanced`}>風格 · 平衡</option></select></label>
              <label className={styles.field}><span>角色名稱</span><input id="lora-character-name" value={config.characterName} aria-invalid={!config.characterName.trim()} aria-describedby="character-name-help" onChange={(event) => patchCharacterName(event.target.value)} /><small id="character-name-help">訓練後的角色顯示名稱；觸發詞預設會跟隨此名稱。</small></label>
              <label className={styles.field}><span>LoRA 檔名</span><input id="lora-output-name" value={config.outputName} aria-invalid={!config.outputName.trim()} aria-describedby="output-name-help" onChange={(event) => patchConfig("outputName", event.target.value)} /><small id="output-name-help">使用英數、連字號或底線；伺服器會產生安全檔名。</small></label>
              <label className={styles.fieldWide}><span>觸發詞</span><input id="trigger-words" value={triggerDraft} aria-invalid={Boolean(triggerError)} aria-describedby={triggerError ? "trigger-words-help trigger-words-error" : "trigger-words-help"} onChange={(event) => patchTriggerDraft(event.target.value)} placeholder={config.characterName || "my_character"} /><small id="trigger-words-help">生成提示詞時使用；預設為角色名稱，可用逗號分隔多個觸發詞。</small>{triggerError && <p id="trigger-words-error" className={styles.inlineError} role="alert">{triggerError}</p>}</label>
            </div>
            <details className={styles.details}><summary>進階設定</summary><div className={styles.advancedGrid}>
              <NumberField label="Rank" value={config.overrides?.rank} min={1} max={256} onChange={(value) => patchOverride("rank", value)} />
              <NumberField label="Alpha" value={config.overrides?.alpha} min={1} max={256} onChange={(value) => patchOverride("alpha", value)} />
              <NumberField label="學習率" value={config.overrides?.learningRate} min={0.000001} max={0.01} step={0.000001} onChange={(value) => patchOverride("learningRate", value)} />
              <NumberField label="訓練輪數" value={config.overrides?.epochs} min={1} max={100} onChange={(value) => patchOverride("epochs", value)} />
              <NumberField label="批次大小" value={config.overrides?.batchSize} min={1} max={16} onChange={(value) => patchOverride("batchSize", value)} />
              <NumberField label={FIELD_LABELS.seed} value={config.overrides?.seed} min={0} max={2147483647} onChange={(value) => patchOverride("seed", value)} />
            </div></details>
            {preflight && <div className={styles.checks} aria-live="polite">{preflight.checks.map((check, index) => <div key={check.id || check.name || index} data-status={check.status}><strong>{check.label || check.name || `檢查 ${index + 1}`}</strong><span>{check.message || check.status}</span></div>)}</div>}
                <div className={styles.primaryRow}><span>{healthBlocked ? `${healthBlockReason} 點擊後會導向檢查結果。` : job ? "訓練前檢查會確認執行環境、圖片描述、檢查點、磁碟與 GPU 狀態。" : "設定會在建立工作時送出；開始前仍可返回訓練資料增減圖片。"}</span>{canQueueJob && <button className={styles.primaryButton} type="button" aria-describedby="lora-health-summary" onClick={job ? checkAndQueue : beginTraining} disabled={Boolean(busy)}>{busy === "preflight" ? "檢查並排程中…" : busy === "start" ? "建立工作中…" : job ? "檢查並開始訓練" : "開始訓練"}</button>}</div>
          </section>}

          {stage === "progress" && <section className={styles.panel} aria-labelledby="progress-title" aria-live="polite">
            <header className={styles.sectionHeader}><div><span>04 / 訓練進度</span><h2 id="progress-title">{jobStatusLabel(job?.status, "lora")}</h2><p>關閉此頁不會中斷工作；使用目前網址可回到同一個工作。</p></div><span className={styles.statusChip} data-status={job?.status}>{jobStatusLabel(job?.status, "lora")}</span></header>
            <div className={styles.progressSummary}><div className={styles.progressNumber}>{hasMeasuredProgress || job?.status === "installing" || job?.status === "completed" ? <>{progress}<span>%</span></> : <span aria-label="訓練進度尚未開始">{progressStateLabel}</span>}</div><div className={styles.progressBody}><div className={styles.progressTrack} role="progressbar" aria-label="訓練完成度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div><dl><div><dt>步數</dt><dd>{job?.training.step ?? "—"} / {job?.training.totalSteps ?? "—"}</dd></div><div><dt>訓練輪數</dt><dd>{job?.training.epoch ?? "—"}</dd></div><div><dt>損失</dt><dd>{job?.training.loss?.toFixed(4) ?? "—"}</dd></div><div><dt>預估剩餘</dt><dd>{formatEta(job?.training.etaSeconds)}</dd></div></dl></div></div>
            <div className={styles.jobError}>{job?.error && <><strong>{job.error.code}</strong><span>{job.error.message}</span>{job.error.field && <small>請檢查：{job.error.field}</small>}</>}</div>
            <div className={styles.actions}>{job && ["queued", "training", "cancelling"].includes(job.status) && <button className={styles.dangerButton} type="button" onClick={cancelJob} disabled={Boolean(busy) || job.status === "cancelling"}>取消訓練</button>}{job && ["failed", "cancelled", "interrupted"].includes(job.status) && <button className={styles.primaryButton} type="button" onClick={retryJob} disabled={Boolean(busy)}>{busy === "retry" ? "建立重試中…" : "重試訓練"}</button>}</div>
          </section>}

          {stage === "artifact" && <section className={styles.panel} aria-labelledby="artifact-title">
            <header className={styles.sectionHeader}><div><span>05 / 模型產物</span><h2 id="artifact-title">LoRA 已可使用</h2><p>模型已驗證並安裝到 ComfyUI 的 trained LoRA 目錄。</p></div><span className={styles.successMark} aria-hidden="true">✓</span></header>
            <dl className={styles.artifactGrid}><Meta label="角色名稱" value={artifact?.displayName || job?.characterName || job?.displayName} /><Meta label="註冊編號" value={artifact?.registryId || job?.artifact?.registryId} /><Meta label="模型系列" value={artifact?.family || job?.training.family} /><Meta label="基礎模型設定檔" value={artifact?.baseProfile || job?.training.baseProfile} /><Meta label="檔案大小" value={formatBytes(artifact?.sizeBytes || job?.artifact?.sizeBytes)} /><Meta label="SHA-256" value={artifact?.sha256 || job?.artifact?.sha256} wide /><Meta label="觸發詞" value={artifact?.triggerWords?.join(", ") || "—"} wide /></dl>
            <details className={styles.details}><summary>來源資訊</summary><pre>{JSON.stringify(artifact?.provenance || job?.provenance || {}, null, 2)}</pre></details>
            <div className={styles.primaryRow}><a className={styles.secondaryButton} href={job ? artifact?.downloadUrl || artifactDownloadUrl(job.id) : undefined}>下載 .safetensors</a><a className={styles.primaryButton} href={`/app/tools/image-to-image${artifact?.registryId || job?.artifact?.registryId ? `?lora=${encodeURIComponent(artifact?.registryId || job?.artifact?.registryId || "")}` : ""}`}>前往以圖生圖</a></div>
          </section>}
        </main>

        <aside className={styles.summary} aria-label="目前工作摘要"><span>目前工作</span><strong>{job ? jobStatusLabel(job.status, "lora") : "尚未建立"}</strong><dl><div><dt>工作編號</dt><dd title={job?.id}>{job?.id || "—"}</dd></div><div><dt>訓練資料</dt><dd>{job?.dataset.imageCount ?? assets.length} 張圖片</dd></div><div><dt>模式</dt><dd>{job?.captionReviewMode === "manual" ? "手動" : "自動"}</dd></div><div><dt>模型系列</dt><dd>{job?.training.family || config.family}</dd></div><div><dt>嘗試次數</dt><dd>{job?.training.attempt ?? "—"}</dd></div></dl>{job && canonicalStage !== stage && <button type="button" className={styles.textButton} onClick={() => setStage(canonicalStage)}>回到目前步驟</button>}</aside>
      </div>
    </div>
  );
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value?: number; min: number; max: number; step?: number; onChange: (value: string) => void }) {
  return <label className={styles.field}><span>{label}</span><input type="number" value={value ?? ""} min={min} max={max} step={step} onChange={(event) => onChange(event.target.value)} /></label>;
}

function Meta({ label, value, wide = false }: { label: string; value?: string | number; wide?: boolean }) {
  return <div className={wide ? styles.wideMeta : ""}><dt>{label}</dt><dd title={String(value || "—")}>{value || "—"}</dd></div>;
}
