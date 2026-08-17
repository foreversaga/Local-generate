"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./LongCreateForm.module.css";

const BRIDGE_URL = "/app";

export type LongScriptDraft = {
  id: string;
  name: string;
  content: string;
  description: string;
  negativePrompt: string;
  duration: number | "";
};

type SavedLongShot = { id?: string; duration: number; prompt?: string; content?: string; description: string };
type SavedLongScript = { id: string; name: string; shots: SavedLongShot[] };
type GeneralScript = { id: string; name: string; prompt: string; negativePrompt: string };

function newId(index: number) {
  return globalThis.crypto?.randomUUID?.() || `script-${Date.now()}-${index}`;
}

export function createLongScript(index: number): LongScriptDraft {
  return { id: newId(index), name: `劇本 ${index + 1}`, content: "", description: "", negativePrompt: "", duration: 5 };
}

function draftFromSavedShot(shot: SavedLongShot, index: number): LongScriptDraft {
  return {
    id: shot.id || newId(index),
    name: `劇本 ${index + 1}`,
    content: shot.prompt || shot.content || "",
    description: shot.description || "",
    negativePrompt: "",
    duration: Number.isFinite(Number(shot.duration)) ? Number(shot.duration) : 5,
  };
}

export function applySavedLongScript(_value: LongScriptDraft[], saved: SavedLongScript): LongScriptDraft[] {
  return saved.shots.map((shot, index) => ({ ...draftFromSavedShot(shot, index), name: `劇本 ${index + 1}` }));
}

export function importGeneralScript(value: LongScriptDraft[], script: GeneralScript): LongScriptDraft[] {
  const imported: LongScriptDraft = {
    id: newId(value.length),
    name: script.name,
    content: script.prompt,
    description: script.name,
    negativePrompt: script.negativePrompt || "",
    duration: 5,
  };
  const emptyIndex = value.findIndex((shot) => !shot.content.trim() && !shot.description.trim());
  if (emptyIndex < 0) return [...value, imported];
  return value.map((shot, index) => index === emptyIndex ? imported : shot);
}

function scriptPayload(value: LongScriptDraft[]) {
  return value.map((script) => ({ id: script.id, duration: Number(script.duration), prompt: script.content, description: script.description }));
}

function errorMessage(payload: unknown) {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") return payload.error;
  if (payload && typeof payload === "object" && "error" in payload && payload.error && typeof payload.error === "object" && "message" in payload.error && typeof payload.error.message === "string") return payload.error.message;
  return "長影片劇本操作失敗，請稍後再試。";
}

export function LongScriptComposer({ value, disabled, error, onChange }: { value: LongScriptDraft[]; disabled?: boolean; error?: string; onChange: (value: LongScriptDraft[]) => void }) {
  const [library, setLibrary] = useState<SavedLongScript[]>([]);
  const [generalLibrary, setGeneralLibrary] = useState<GeneralScript[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedGeneralId, setSelectedGeneralId] = useState("");
  const [libraryName, setLibraryName] = useState("");
  const [loading, setLoading] = useState(true);
  const [generalLoading, setGeneralLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [generalError, setGeneralError] = useState("");
  const [message, setMessage] = useState("");
  const totalDuration = useMemo(() => value.reduce((total, script) => total + (Number(script.duration) || 0), 0), [value]);

  async function refresh(preferredId = "") {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/long-scripts`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw payload;
      const scripts = Array.isArray(payload.scripts) ? payload.scripts as SavedLongScript[] : [];
      setLibrary(scripts);
      if (preferredId) {
        const preferred = scripts.find((script) => script.id === preferredId);
        if (preferred) setLibraryName(preferred.name);
      }
      setLibraryError("");
    } catch (reason) {
      setLibraryError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  async function refreshGeneralScripts() {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/scripts`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw payload;
      setGeneralLibrary(Array.isArray(payload.scripts) ? payload.scripts as GeneralScript[] : []);
      setGeneralError("");
    } catch (reason) {
      setGeneralError(errorMessage(reason));
    } finally {
      setGeneralLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void Promise.all([refresh(), refreshGeneralScripts()]); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function patch(index: number, next: Partial<LongScriptDraft>) {
    onChange(value.map((script, itemIndex) => itemIndex === index ? { ...script, ...next } : script));
    setMessage("");
  }

  function move(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    setMessage("");
  }

  function addShot() {
    onChange([...value, createLongScript(value.length)]);
    setMessage("");
  }

  function removeShot(index: number) {
    if (value.length <= 2 || disabled) return;
    if (!window.confirm(`確定刪除分鏡 ${index + 1}？此變更只會影響目前編輯內容。`)) return;
    onChange(value.filter((_, itemIndex) => itemIndex !== index));
    setMessage("");
  }

  function chooseSaved(id: string) {
    const saved = library.find((script) => script.id === id);
    if (!saved) return;
    setSelectedId(saved.id);
    setLibraryName(saved.name);
    onChange(applySavedLongScript(value, saved));
    setMessage(`已載入「${saved.name}」，可直接調整每個分鏡。`);
    setLibraryError("");
  }

  function startNew() {
    setSelectedId("");
    setLibraryName("");
    onChange([createLongScript(0), createLongScript(1)]);
    setMessage("已建立兩個空白分鏡，填寫後可保存為長影片劇本。" );
    setLibraryError("");
  }

  function addGeneralScript() {
    const script = generalLibrary.find((item) => item.id === selectedGeneralId);
    if (!script || disabled || busy) return;
    onChange(importGeneralScript(value, script));
    setMessage(`已將一般劇本「${script.name}」匯入為分鏡，可繼續調整秒數、提示詞與描述。`);
    setLibraryError("");
    setGeneralError("");
  }

  async function saveScript() {
    if (busy || disabled) return;
    if (!libraryName.trim()) { setLibraryError("請先輸入長影片劇本名稱。" ); return; }
    if (value.length < 2 || value.some((script) => !script.content.trim() || !script.description.trim() || !Number.isFinite(Number(script.duration)))) {
      setLibraryError("至少需要兩個完整分鏡，且每格都要有秒數、提示詞與分鏡描述。" );
      return;
    }
    setBusy(true);
    setLibraryError("");
    setMessage("");
    try {
      const response = await fetch(selectedId ? `${BRIDGE_URL}/api/long-scripts/${encodeURIComponent(selectedId)}` : `${BRIDGE_URL}/api/long-scripts`, {
        method: selectedId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: libraryName, shots: scriptPayload(value) }),
      });
      const payload = await response.json();
      if (!response.ok) throw payload;
      setSelectedId(payload.script.id);
      setLibraryName(payload.script.name);
      await refresh(payload.script.id);
      setMessage(selectedId ? "長影片劇本已更新。" : "長影片劇本已保存。" );
    } catch (reason) {
      setLibraryError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function deleteScript() {
    const saved = library.find((script) => script.id === selectedId);
    if (!saved || busy || disabled || !window.confirm(`確定刪除長影片劇本「${saved.name}」？`)) return;
    setBusy(true);
    setLibraryError("");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/long-scripts/${encodeURIComponent(saved.id)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw payload;
      startNew();
      await refresh();
      setMessage("長影片劇本已刪除。" );
    } catch (reason) {
      setLibraryError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <div className={styles.scriptComposer}>
    <div className={styles.scriptToolbar}>
      <div><strong>長影片劇本</strong><p>每個分鏡固定對應一支影片；保存後可從此頁或素材庫再次載入。</p></div>
      <div className={styles.scriptToolbarActions}><button type="button" onClick={startNew} disabled={disabled || busy}>新建長劇本</button><button type="button" onClick={addShot} disabled={disabled || busy}>新增分鏡</button></div>
    </div>
    <div className={styles.scriptLibraryRow}>
      <label className={styles.scriptLibrarySelect}><span>已保存的長影片劇本</span><select value={selectedId} onChange={(event) => chooseSaved(event.target.value)} disabled={disabled || busy}><option value="">選擇後載入…</option>{library.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}</select></label>
      <label className={styles.scriptLibraryName}><span>劇本名稱</span><input value={libraryName} maxLength={80} onChange={(event) => setLibraryName(event.target.value)} placeholder="例如：雨夜車站追逐" disabled={disabled || busy} /></label>
      <div className={styles.scriptLibraryActions}><button type="button" onClick={() => void saveScript()} disabled={disabled || busy || !libraryName.trim()}>{busy ? "保存中…" : selectedId ? "更新長劇本" : "保存長劇本"}</button>{selectedId && <button type="button" onClick={() => void deleteScript()} disabled={disabled || busy}>刪除</button>}</div>
    </div>
    <div className={styles.scriptImportPanel}>
      <div><strong>從一般劇本匯入</strong><p>一般劇本只作為分鏡來源；匯入後仍保存於目前長影片或獨立長影片劇本。</p></div>
      <div className={styles.scriptImportControls}>
        <label className={styles.scriptLibrarySelect}><span>一般劇本</span><select value={selectedGeneralId} onChange={(event) => setSelectedGeneralId(event.target.value)} disabled={disabled || busy || generalLoading}><option value="">{generalLoading ? "一般劇本載入中…" : "選擇要匯入的劇本…"}</option>{generalLibrary.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}</select></label>
        <button type="button" onClick={addGeneralScript} disabled={disabled || busy || !selectedGeneralId}>匯入為分鏡</button>
      </div>
      {!generalLoading && !generalLibrary.length && !generalError && <p className={styles.scriptImportHint}>尚未建立一般劇本，可先在單影片或素材庫新增。</p>}
      {generalError && <p className={styles.inlineError} role="alert">{generalError}</p>}
    </div>
    <div className={styles.scriptSummary} aria-live="polite"><strong>{value.length} 個分鏡</strong><span>總長 {totalDuration.toFixed(1)} 秒</span>{loading && <span>劇本庫載入中…</span>}</div>
    {(libraryError || message) && <p className={libraryError ? styles.inlineError : styles.scriptSuccess} role={libraryError ? "alert" : "status"} aria-live="polite">{libraryError || message}</p>}
    {value.map((script, index) => <article className={styles.scriptCard} key={script.id}>
      <div className={styles.scriptCardHeading}><strong>分鏡 {index + 1}</strong><div><button type="button" aria-label={`上移分鏡 ${index + 1}`} onClick={() => move(index, -1)} disabled={disabled || busy || index === 0}>↑</button><button type="button" aria-label={`下移分鏡 ${index + 1}`} onClick={() => move(index, 1)} disabled={disabled || busy || index === value.length - 1}>↓</button><button type="button" onClick={() => removeShot(index)} disabled={disabled || busy || value.length <= 2}>刪除</button></div></div>
      <div className={styles.scriptMeta}><label><span>分鏡標題</span><input id={`long-script-${index}-name`} value={script.name} maxLength={80} onChange={(event) => patch(index, { name: event.target.value })} disabled={disabled || busy} /></label><label><span>影片長度（秒）</span><input id={`long-script-${index}-duration`} type="number" min={0.5} max={60} step={0.5} value={script.duration} onChange={(event) => patch(index, { duration: event.target.value === "" ? "" : Number(event.target.value) })} disabled={disabled || busy} /></label></div>
      <label><span>分鏡描述</span><textarea id={`long-script-${index}-description`} value={script.description} onChange={(event) => patch(index, { description: event.target.value })} placeholder="描述這一格的場景、動作、構圖與鏡頭…" disabled={disabled || busy} /></label>
      <label><span>提示詞</span><textarea id={`long-script-${index}-content`} value={script.content} onChange={(event) => patch(index, { content: event.target.value })} placeholder="寫角色、場景、事件、對話、聲音與想要的鏡頭效果…" disabled={disabled || busy} /></label>
      <label><span>此分鏡限制（選填）</span><textarea className={styles.scriptNegative} value={script.negativePrompt} onChange={(event) => patch(index, { negativePrompt: event.target.value })} placeholder="只填這一段特有的限制…" disabled={disabled || busy} /></label>
    </article>)}
    {error && <p className={styles.inlineError}>{error}</p>}
  </div>;
}
