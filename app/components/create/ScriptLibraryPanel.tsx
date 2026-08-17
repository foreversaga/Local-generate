"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./ScriptLibraryPanel.module.css";

const BRIDGE_URL = "/app";

type ScriptRecord = {
  id: string;
  name: string;
  prompt: string;
  negativePrompt: string;
  updatedAt: string;
};

type Props = {
  prompt: string;
  negativePrompt: string;
  onApply: (script: Pick<ScriptRecord, "prompt" | "negativePrompt">) => void;
};

function errorMessage(value: unknown) {
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") return value.error;
  return "劇本操作失敗，請稍後再試。";
}

export function ScriptLibraryPanel({ prompt, negativePrompt, onApply }: Props) {
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selected = useMemo(() => scripts.find((script) => script.id === selectedId) || null, [scripts, selectedId]);

  async function loadScripts() {
    try {
      const response = await fetch(`${BRIDGE_URL}/api/scripts`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw payload;
      setScripts(Array.isArray(payload.scripts) ? payload.scripts : []);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadScripts(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function chooseScript(id: string) {
    setSelectedId(id);
    setName(scripts.find((script) => script.id === id)?.name || "");
    setMessage("");
    setError("");
  }

  function startNew() {
    setSelectedId("");
    setName("");
    setMessage("請輸入名稱後儲存目前提示詞。" );
    setError("");
  }

  async function saveScript() {
    if (!name.trim()) {
      setError("請先輸入劇本名稱。");
      return;
    }
    if (!prompt.trim()) {
      setError("提示詞不可空白。");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(selectedId ? `${BRIDGE_URL}/api/scripts/${encodeURIComponent(selectedId)}` : `${BRIDGE_URL}/api/scripts`, {
        method: selectedId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt, negativePrompt }),
      });
      const payload = await response.json();
      if (!response.ok) throw payload;
      await loadScripts();
      setSelectedId(payload.script.id);
      setName(payload.script.name);
      setMessage(selectedId ? "劇本已更新。" : "劇本已儲存。" );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  function applyScript() {
    if (!selected) return;
    onApply({ prompt: selected.prompt, negativePrompt: selected.negativePrompt });
    setMessage(`已套用「${selected.name}」。`);
    setError("");
  }

  async function deleteScript() {
    if (!selected || !window.confirm(`確定刪除劇本「${selected.name}」？`)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/scripts/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw payload;
      setSelectedId("");
      setName("");
      await loadScripts();
      setMessage("劇本已刪除。" );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="script-library-title">
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>PROMPT LIBRARY</span>
          <strong id="script-library-title">劇本庫</strong>
        </div>
        <button type="button" className={styles.ghostButton} onClick={startNew} disabled={busy}>新增劇本</button>
      </div>
      <div className={styles.controls}>
        <label className={styles.field}>
          <span>已儲存劇本</span>
          <select value={selectedId} onChange={(event) => chooseScript(event.target.value)} disabled={busy}>
            <option value="">選擇劇本…</option>
            {scripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}
          </select>
        </label>
        <button type="button" className={styles.applyButton} onClick={applyScript} disabled={!selected || busy}>套用</button>
      </div>
      <div className={styles.controls}>
        <label className={styles.field}>
          <span>劇本名稱</span>
          <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="例如：雨夜街頭追逐" disabled={busy} />
        </label>
        <button type="button" className={styles.saveButton} onClick={() => void saveScript()} disabled={busy || !name.trim() || !prompt.trim()}>{busy ? "處理中…" : selected ? "更新" : "儲存"}</button>
      </div>
      {selected && <div className={styles.metaRow}><span>更新後會覆蓋所選劇本</span><button type="button" onClick={() => void deleteScript()} disabled={busy}>刪除</button></div>}
      <p className={styles.helper}>儲存目前的提示詞與負面提示詞；套用時會覆蓋這兩個欄位。</p>
      {(message || error) && <p className={error ? styles.error : styles.success} role="status" aria-live="polite">{error || message}</p>}
    </section>
  );
}
