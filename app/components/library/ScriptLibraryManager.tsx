"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import styles from "./ScriptLibraryManager.module.css";

const BRIDGE_URL = "/app";

type ScriptRecord = {
    id: string;
    name: string;
    prompt: string;
    negativePrompt: string;
    createdAt: string;
    updatedAt: string;
};

type Draft = {
    id: string;
    name: string;
    prompt: string;
    negativePrompt: string;
};

const EMPTY_DRAFT: Draft = { id: "", name: "", prompt: "", negativePrompt: "" };

function responseError(payload: unknown) {
    if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") return payload.error;
    return "劇本操作失敗，請稍後再試。";
}

function draftFromScript(script: ScriptRecord): Draft {
    return { id: script.id, name: script.name, prompt: script.prompt, negativePrompt: script.negativePrompt };
}

export function ScriptLibraryManager() {
    const [scripts, setScripts] = useState<ScriptRecord[]>([]);
    const [query, setQuery] = useState("");
    const [draft, setDraft] = useState<Draft | null>(null);
    const [pendingDelete, setPendingDelete] = useState<ScriptRecord | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const nameRef = useRef<HTMLInputElement>(null);

    async function refresh(preferredId = "") {
        try {
            const response = await fetch(`${BRIDGE_URL}/api/scripts`, { cache: "no-store" });
            const payload = await response.json();
            if (!response.ok) throw payload;
            const next = Array.isArray(payload.scripts) ? payload.scripts as ScriptRecord[] : [];
            setScripts(next);
            if (preferredId) {
                const selected = next.find((script) => script.id === preferredId);
                if (selected) setDraft(draftFromScript(selected));
            }
            setError("");
        } catch (reason) {
            setError(responseError(reason));
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        const timer = window.setTimeout(() => { void refresh(); }, 0);
        return () => window.clearTimeout(timer);
    }, []);

    const visibleScripts = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return scripts;
        return scripts.filter((script) => `${script.name} ${script.prompt} ${script.negativePrompt}`.toLowerCase().includes(needle));
    }, [query, scripts]);

    function startNew() {
        setDraft({ ...EMPTY_DRAFT });
        setError("");
        setMessage("");
        window.requestAnimationFrame(() => nameRef.current?.focus());
    }

    function edit(script: ScriptRecord) {
        setDraft(draftFromScript(script));
        setError("");
        setMessage("");
        window.requestAnimationFrame(() => nameRef.current?.focus());
    }

    function update(field: keyof Omit<Draft, "id">, value: string) {
        setDraft((current) => current ? { ...current, [field]: value } : current);
        setMessage("");
    }

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!draft || busy || !draft.name.trim() || !draft.prompt.trim()) return;
        setBusy(true);
        setError("");
        setMessage("");
        try {
            const response = await fetch(draft.id ? `${BRIDGE_URL}/api/scripts/${encodeURIComponent(draft.id)}` : `${BRIDGE_URL}/api/scripts`, {
                method: draft.id ? "PUT" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: draft.name, prompt: draft.prompt, negativePrompt: draft.negativePrompt }),
            });
            const payload = await response.json();
            if (!response.ok) throw payload;
            await refresh(payload.script.id);
            setMessage(draft.id ? "劇本已更新。" : "劇本已新增。" );
        } catch (reason) {
            setError(responseError(reason));
        } finally {
            setBusy(false);
        }
    }

    async function remove() {
        if (!pendingDelete || busy) return;
        setBusy(true);
        setError("");
        setMessage("");
        try {
            const response = await fetch(`${BRIDGE_URL}/api/scripts/${encodeURIComponent(pendingDelete.id)}`, { method: "DELETE" });
            const payload = await response.json();
            if (!response.ok) throw payload;
            if (draft?.id === pendingDelete.id) setDraft(null);
            setPendingDelete(null);
            await refresh();
            setMessage("劇本已刪除。" );
        } catch (reason) {
            setError(responseError(reason));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className={styles.manager} aria-labelledby="script-library-heading">
            <div className={styles.header}>
                <div>
                    <span>劇本素材</span>
                    <h2 id="script-library-heading">劇本庫</h2>
                    <p>集中管理影片建立時可套用的提示詞與負面提示詞。</p>
                </div>
                <button type="button" className={styles.newButton} onClick={startNew}>新增劇本</button>
            </div>

            <label className={styles.search}>
                <span className="sr-only">搜尋劇本</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋劇本名稱或提示詞…" />
            </label>

            {(error || message) && <p className={error ? styles.error : styles.success} role={error ? "alert" : "status"} aria-live="polite">{error || message}</p>}

            <div className={styles.content}>
                <div className={styles.list} aria-label="劇本清單">
                    <div className={styles.listMeta}>{loading ? "載入中…" : `${visibleScripts.length} 個劇本`}</div>
                    {visibleScripts.map((script) => (
                        <article key={script.id} className={`${styles.card} ${draft?.id === script.id ? styles.selected : ""}`}>
                            <button type="button" className={styles.cardMain} onClick={() => edit(script)} aria-label={`編輯劇本 ${script.name}`}>
                                <strong>{script.name}</strong>
                                <span>{script.prompt}</span>
                                <small>更新於 {formatDate(script.updatedAt)}</small>
                            </button>
                            <button type="button" className={styles.deleteButton} onClick={() => setPendingDelete(script)} aria-label={`刪除劇本 ${script.name}`}>刪除</button>
                        </article>
                    ))}
                    {!loading && !visibleScripts.length && <p className={styles.empty}>{query.trim() ? "找不到符合的劇本。" : "尚未建立劇本。"}</p>}
                </div>

                <div className={styles.editorColumn}>
                    {draft ? (
                        <form className={styles.editor} onSubmit={(event) => void save(event)}>
                            <div className={styles.editorHeading}>
                                <div><span>{draft.id ? "編輯劇本" : "新增劇本"}</span><strong>{draft.id ? draft.name || "未命名" : "建立可重複使用的提示詞"}</strong></div>
                                <button type="button" onClick={() => setDraft(null)} disabled={busy}>關閉</button>
                            </div>
                            <label>
                                <span>劇本名稱</span>
                                <input ref={nameRef} value={draft.name} maxLength={80} onChange={(event) => update("name", event.target.value)} required />
                                <small>{draft.name.length} / 80</small>
                            </label>
                            <label>
                                <span>提示詞</span>
                                <textarea value={draft.prompt} maxLength={50000} rows={16} onChange={(event) => update("prompt", event.target.value)} required spellCheck={false} />
                                <small>{draft.prompt.length} / 50000</small>
                            </label>
                            <label>
                                <span>負面提示詞</span>
                                <textarea value={draft.negativePrompt} maxLength={20000} rows={7} onChange={(event) => update("negativePrompt", event.target.value)} spellCheck={false} />
                                <small>{draft.negativePrompt.length} / 20000</small>
                            </label>
                            <button type="submit" className={styles.saveButton} disabled={busy || !draft.name.trim() || !draft.prompt.trim()}>{busy ? "儲存中…" : draft.id ? "儲存變更" : "新增劇本"}</button>
                        </form>
                    ) : (
                        <div className={styles.editorEmpty}><strong>選擇一個劇本開始編輯</strong><p>也可以新增空白劇本，再填入提示詞與負面提示詞。</p><button type="button" onClick={startNew}>新增劇本</button></div>
                    )}
                </div>
            </div>

            {pendingDelete && (
                <div className={styles.backdrop} role="presentation">
                    <div className={styles.confirmDialog} role="alertdialog" aria-modal="true" aria-labelledby="delete-script-title">
                        <h2 id="delete-script-title">刪除劇本？</h2>
                        <p>「{pendingDelete.name}」將從本機劇本庫永久移除。</p>
                        <div>
                            <button type="button" onClick={() => setPendingDelete(null)} disabled={busy}>取消</button>
                            <button type="button" className={styles.confirmDelete} onClick={() => void remove()} disabled={busy}>{busy ? "刪除中…" : "確認刪除"}</button>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}

function formatDate(value: string) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" });
}
