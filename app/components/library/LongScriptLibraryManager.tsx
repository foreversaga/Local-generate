"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import styles from "./LongScriptLibraryManager.module.css";

const BRIDGE_URL = "/app";

type LongShot = { id?: string; duration: number; prompt: string; description: string };
type LongScriptRecord = { id: string; name: string; shots: LongShot[]; createdAt: string; updatedAt: string };
type Draft = { id: string; name: string; shots: LongShot[] };

function emptyShot(index: number): LongShot {
    return { id: `shot-${Date.now()}-${index}`, duration: 5, prompt: "", description: "" };
}

function emptyDraft(): Draft {
    return { id: "", name: "", shots: [emptyShot(0), emptyShot(1)] };
}

function draftFromRecord(record: LongScriptRecord): Draft {
    return { id: record.id, name: record.name, shots: record.shots.map((shot) => ({ ...shot, prompt: shot.prompt || "", description: shot.description || "" })) };
}

function errorMessage(payload: unknown) {
    if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") return payload.error;
    if (payload && typeof payload === "object" && "error" in payload && payload.error && typeof payload.error === "object" && "message" in payload.error && typeof payload.error.message === "string") return payload.error.message;
    return "長影片劇本操作失敗，請稍後再試。";
}

function totalDuration(shots: LongShot[]) {
    return shots.reduce((total, shot) => total + (Number(shot.duration) || 0), 0);
}

function shotComplete(shot: LongShot) {
    return Boolean(shot.prompt.trim() && shot.description.trim() && Number.isFinite(Number(shot.duration)));
}

export function LongScriptLibraryManager() {
    const [scripts, setScripts] = useState<LongScriptRecord[]>([]);
    const [query, setQuery] = useState("");
    const [draft, setDraft] = useState<Draft | null>(null);
    const [expandedShot, setExpandedShot] = useState<number | null>(null);
    const [pendingDelete, setPendingDelete] = useState<LongScriptRecord | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const nameRef = useRef<HTMLInputElement>(null);

    async function refresh(preferredId = "") {
        try {
            const response = await fetch(`${BRIDGE_URL}/api/long-scripts`, { cache: "no-store" });
            const payload = await response.json();
            if (!response.ok) throw payload;
            const next = Array.isArray(payload.scripts) ? payload.scripts as LongScriptRecord[] : [];
            setScripts(next);
            if (preferredId) {
                const selected = next.find((script) => script.id === preferredId);
                if (selected) {
                    setDraft(draftFromRecord(selected));
                    setExpandedShot(0);
                }
            }
            setError("");
        } catch (reason) {
            setError(errorMessage(reason));
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
        return scripts.filter((script) => `${script.name} ${script.shots.map((shot) => `${shot.prompt} ${shot.description}`).join(" ")}`.toLowerCase().includes(needle));
    }, [query, scripts]);

    function startNew() {
        setDraft(emptyDraft());
        setExpandedShot(0);
        setError("");
        setMessage("");
        window.requestAnimationFrame(() => nameRef.current?.focus());
    }

    function edit(script: LongScriptRecord) {
        setDraft(draftFromRecord(script));
        setExpandedShot(0);
        setError("");
        setMessage("");
        window.requestAnimationFrame(() => nameRef.current?.focus());
    }

    function closeEditor() {
        setDraft(null);
        setExpandedShot(null);
    }

    function updateShot(index: number, patch: Partial<LongShot>) {
        setDraft((current) => current ? { ...current, shots: current.shots.map((shot, shotIndex) => shotIndex === index ? { ...shot, ...patch } : shot) } : current);
        setMessage("");
    }

    function addShot() {
        if (!draft) return;
        const index = draft.shots.length;
        setDraft({ ...draft, shots: [...draft.shots, emptyShot(index)] });
        setExpandedShot(index);
    }

    function removeShot(index: number) {
        if (!draft || draft.shots.length <= 2 || !window.confirm(`確定刪除分鏡 ${index + 1}？`)) return;
        const nextShots = draft.shots.filter((_, shotIndex) => shotIndex !== index);
        setDraft({ ...draft, shots: nextShots });
        if (expandedShot === index) setExpandedShot(Math.min(index, nextShots.length - 1));
        else if (expandedShot !== null && expandedShot > index) setExpandedShot(expandedShot - 1);
    }

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!draft || busy || !draft.name.trim()) return;
        const invalidIndex = draft.shots.findIndex((shot) => !shotComplete(shot));
        if (draft.shots.length < 2 || invalidIndex >= 0) {
            if (invalidIndex >= 0) setExpandedShot(invalidIndex);
            setError("至少需要兩個完整分鏡，且每格都要有秒數、提示詞與分鏡描述。" );
            return;
        }
        setBusy(true);
        setError("");
        setMessage("");
        try {
            const response = await fetch(draft.id ? `${BRIDGE_URL}/api/long-scripts/${encodeURIComponent(draft.id)}` : `${BRIDGE_URL}/api/long-scripts`, {
                method: draft.id ? "PUT" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: draft.name, shots: draft.shots.map(({ id, duration, prompt, description }) => ({ id, duration: Number(duration), prompt, description })) }),
            });
            const payload = await response.json();
            if (!response.ok) throw payload;
            await refresh(payload.script.id);
            setMessage(draft.id ? "長影片劇本已更新。" : "長影片劇本已新增。" );
        } catch (reason) {
            setError(errorMessage(reason));
        } finally {
            setBusy(false);
        }
    }

    async function remove() {
        if (!pendingDelete || busy) return;
        setBusy(true);
        setError("");
        try {
            const response = await fetch(`${BRIDGE_URL}/api/long-scripts/${encodeURIComponent(pendingDelete.id)}`, { method: "DELETE" });
            const payload = await response.json();
            if (!response.ok) throw payload;
            if (draft?.id === pendingDelete.id) closeEditor();
            setPendingDelete(null);
            await refresh();
            setMessage("長影片劇本已刪除。" );
        } catch (reason) {
            setError(errorMessage(reason));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className={styles.manager} aria-labelledby="long-script-library-heading">
            <div className={styles.header}>
                <div><span>長影片專用</span><h2 id="long-script-library-heading">長影片劇本庫</h2><p>管理由多個分鏡組成的長影片劇本。</p></div>
                <button type="button" className={styles.newButton} onClick={startNew}>新增長影片劇本</button>
            </div>
            <label className={styles.search}><span className="sr-only">搜尋長影片劇本</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋名稱、提示詞或分鏡描述…" /></label>
            {(error || message) && <p className={error ? styles.error : styles.success} role={error ? "alert" : "status"} aria-live="polite">{error || message}</p>}
            <div className={styles.content}>
                <div className={styles.list} aria-label="長影片劇本清單">
                    <div className={styles.listMeta}>{loading ? "載入中…" : `${visibleScripts.length} 個長影片劇本`}</div>
                    {visibleScripts.map((script) => (
                        <article key={script.id} className={`${styles.card} ${draft?.id === script.id ? styles.selected : ""}`}>
                            <button type="button" className={styles.cardMain} onClick={() => edit(script)} aria-label={`編輯長影片劇本 ${script.name}`}>
                                <strong>{script.name}</strong>
                                <span>{script.shots.length} 個分鏡 · {totalDuration(script.shots).toFixed(1)} 秒</span>
                                <small>{script.shots[0]?.description || "尚未填寫分鏡描述"}</small>
                            </button>
                            <button type="button" className={styles.deleteButton} onClick={() => setPendingDelete(script)} aria-label={`刪除長影片劇本 ${script.name}`}>刪除</button>
                        </article>
                    ))}
                    {!loading && !visibleScripts.length && <p className={styles.empty}>{query.trim() ? "找不到符合的長影片劇本。" : "尚未建立長影片劇本。"}</p>}
                </div>

                <div className={styles.editorColumn}>
                    {draft ? (
                        <form className={styles.editor} onSubmit={(event) => void save(event)}>
                            <div className={styles.editorHeading}>
                                <div><span>{draft.id ? "編輯長影片劇本" : "新增長影片劇本"}</span><strong>{draft.name || "未命名長影片劇本"}</strong></div>
                                <button type="button" onClick={closeEditor} disabled={busy}>關閉</button>
                            </div>
                            <label><span>劇本名稱</span><input ref={nameRef} value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /><small>{draft.name.length} / 80</small></label>
                            <div className={styles.shotToolbar}><strong>{draft.shots.length} 個分鏡 · {totalDuration(draft.shots).toFixed(1)} 秒</strong><button type="button" onClick={addShot} disabled={busy}>新增分鏡</button></div>

                            <div className={styles.shotList}>
                                {draft.shots.map((shot, index) => {
                                    const expanded = expandedShot === index;
                                    const complete = shotComplete(shot);
                                    return (
                                        <article className={`${styles.shotCard} ${expanded ? styles.shotCardExpanded : ""}`} key={shot.id || index}>
                                            <div className={styles.shotSummary}>
                                                <button type="button" className={styles.shotToggle} aria-expanded={expanded} aria-controls={`long-shot-${index}`} onClick={() => setExpandedShot(expanded ? null : index)}>
                                                    <strong>分鏡 {index + 1}</strong>
                                                    <span>{Number.isFinite(Number(shot.duration)) ? `${Number(shot.duration).toFixed(1)} 秒` : "秒數未設定"}</span>
                                                    <small className={complete ? styles.shotComplete : styles.shotIncomplete}>{complete ? "完成" : "未完成"}</small>
                                                    <span aria-hidden="true">{expanded ? "−" : "+"}</span>
                                                </button>
                                                <button type="button" className={styles.shotDelete} onClick={() => removeShot(index)} disabled={busy || draft.shots.length <= 2}>刪除</button>
                                            </div>
                                            {expanded && (
                                                <div id={`long-shot-${index}`} className={styles.shotFields}>
                                                    <div className={styles.shotMeta}>
                                                        <label><span>秒數</span><input type="number" min={0.5} max={60} step={0.5} value={shot.duration} onChange={(event) => updateShot(index, { duration: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
                                                        <span>分鏡時間會依順序累加</span>
                                                    </div>
                                                    <label><span>分鏡描述</span><textarea value={shot.description} onChange={(event) => updateShot(index, { description: event.target.value })} placeholder="場景、動作、構圖與鏡頭…" /></label>
                                                    <label><span>提示詞</span><textarea value={shot.prompt} onChange={(event) => updateShot(index, { prompt: event.target.value })} placeholder="送給 H3 的此段提示詞…" /></label>
                                                </div>
                                            )}
                                        </article>
                                    );
                                })}
                            </div>

                            <button type="submit" className={styles.saveButton} disabled={busy || !draft.name.trim()}>{busy ? "儲存中…" : draft.id ? "儲存變更" : "新增長影片劇本"}</button>
                        </form>
                    ) : (
                        <div className={styles.editorEmpty}><strong>選擇長影片劇本開始編輯</strong><p>也可以新增空白長影片劇本，再逐格填寫內容。</p><button type="button" onClick={startNew}>新增長影片劇本</button></div>
                    )}
                </div>
            </div>
            {pendingDelete && <div className={styles.backdrop} role="presentation"><div className={styles.confirmDialog} role="alertdialog" aria-modal="true" aria-labelledby="delete-long-script-title"><h2 id="delete-long-script-title">刪除長影片劇本？</h2><p>「{pendingDelete.name}」及其 {pendingDelete.shots.length} 個分鏡將永久移除。</p><div><button type="button" onClick={() => setPendingDelete(null)} disabled={busy}>取消</button><button type="button" className={styles.confirmDelete} onClick={() => void remove()} disabled={busy}>{busy ? "刪除中…" : "確認刪除"}</button></div></div></div>}
        </section>
    );
}
