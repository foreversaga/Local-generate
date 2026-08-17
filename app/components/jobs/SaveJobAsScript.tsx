"use client";

import { useRef, useState, type FormEvent } from "react";
import styles from "./JobsWorkspace.module.css";

const BRIDGE_URL = "/app";

type Props = {
  defaultName: string;
  prompt: string;
  negativePrompt: string;
};

function apiError(payload: unknown) {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") return payload.error;
  return "無法儲存劇本，請稍後再試。";
}

export function SaveJobAsScript({ defaultName, prompt, negativePrompt }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName.trim().slice(0, 80));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  function openEditor() {
    setOpen(true);
    setError("");
    setMessage("");
    window.requestAnimationFrame(() => nameRef.current?.focus());
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !prompt.trim() || busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/scripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt, negativePrompt }),
      });
      const payload = await response.json();
      if (!response.ok) throw payload;
      setName(payload.script.name);
      setMessage(`已儲存劇本「${payload.script.name}」。`);
    } catch (reason) {
      setError(apiError(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <button type="button" className={styles.saveScriptButton} onClick={openEditor}>存成劇本</button>;
  }

  return (
    <form className={styles.saveScriptForm} onSubmit={(event) => void save(event)}>
      <label>
        <span>劇本名稱</span>
        <input ref={nameRef} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} aria-describedby="save-job-script-status" />
      </label>
      <div className={styles.saveScriptActions}>
        <button type="submit" disabled={busy || !name.trim()}>{busy ? "儲存中…" : "儲存"}</button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>取消</button>
      </div>
      {(message || error) && <p id="save-job-script-status" className={error ? styles.saveScriptError : styles.saveScriptSuccess} role="status" aria-live="polite">{error || message}</p>}
    </form>
  );
}
