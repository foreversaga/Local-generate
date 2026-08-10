"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { assetKey, assetUrl, deleteAsset, fetchAssets, uploadAssets, type StudioAsset } from "./asset-client";
import styles from "./LibraryWorkspace.module.css";

export function LibraryWorkspace() {
    const [assets, setAssets] = useState<StudioAsset[]>([]);
    const [root, setRoot] = useState<"all" | "input" | "output">("all");
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [preview, setPreview] = useState<StudioAsset | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const previewTriggerRef = useRef<HTMLElement | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        void refresh();
    }, []);

    useEffect(() => {
        if (!preview) return;

        const previousFocus = previewTriggerRef.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>("button,[href],video")?.focus(), 0);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                closePreview();
                return;
            }
            trapFocus(event, dialogRef.current);
        };
        document.addEventListener("keydown", handleKeyDown);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";

        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            document.body.style.overflow = previousOverflow;
            if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
        };
    }, [preview]);

    const visibleAssets = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return assets
            .filter((asset) => (root === "all" || asset.root === root) && (!needle || asset.name.toLowerCase().includes(needle)))
            .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    }, [assets, query, root]);

    async function refresh() {
        try {
            setAssets(await fetchAssets());
            setError("");
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Unable to load assets.");
        }
    }

    function openPreview(asset: StudioAsset, trigger: HTMLElement) {
        previewTriggerRef.current = trigger;
        setPreview(asset);
    }

    function closePreview() {
        setPreview(null);
    }

    function toggle(asset: StudioAsset) {
        const key = assetKey(asset);
        setSelected((current) => {
            const next = new Set(current);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });
    }

    async function removeSelected() {
        const chosen = assets.filter((asset) => selected.has(assetKey(asset)));
        if (!chosen.length || busy) return;
        setBusy(true);
        setError("");
        try {
            for (const asset of chosen) await deleteAsset(asset);
            setSelected(new Set());
            await refresh();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Delete failed.");
        } finally {
            setBusy(false);
        }
    }

    async function removeAsset(asset: StudioAsset) {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            await deleteAsset(asset);
            setSelected((current) => {
                const next = new Set(current);
                next.delete(assetKey(asset));
                return next;
            });
            if (preview && assetKey(preview) === assetKey(asset)) closePreview();
            await refresh();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Delete failed.");
        } finally {
            setBusy(false);
        }
    }

    async function upload(files: File[]) {
        if (!files.length || busy) return;
        setBusy(true);
        setError("");
        try {
            await uploadAssets(files);
            await refresh();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Upload failed.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={styles.workspace}>
            <section className={styles.toolbar}>
                <div className={styles.tabs} role="group" aria-label="Asset root">
                    {(["all", "input", "output"] as const).map((item) => (
                        <button key={item} type="button" className={root === item ? styles.active : ""} aria-pressed={root === item} onClick={() => setRoot(item)}>
                            {item}
                        </button>
                    ))}
                </div>
                <label className={styles.search}>
                    <span className="sr-only">Search assets</span>
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assets…" />
                </label>
                <label className={styles.upload}>
                    Upload
                    <input
                        className={styles.fileInput}
                        type="file"
                        multiple
                        accept="image/*,video/*"
                        disabled={busy}
                        onChange={(event) => {
                            void upload(Array.from(event.target.files || []));
                            event.target.value = "";
                        }}
                    />
                </label>
                <button type="button" className={styles.delete} disabled={!selected.size || busy} onClick={() => void removeSelected()}>
                    Delete {selected.size ? `(${selected.size})` : ""}
                </button>
            </section>

            {error && <div className={styles.error} role="alert">{error}</div>}
            <div className={styles.meta}>{visibleAssets.length} assets</div>

            <div className={styles.grid}>
                {visibleAssets.map((asset) => {
                    const checked = selected.has(assetKey(asset));
                    return (
                        <article key={assetKey(asset)} className={`${styles.card} ${checked ? styles.selected : ""}`}>
                            <button
                                type="button"
                                className={styles.previewButton}
                                onClick={(event) => openPreview(asset, event.currentTarget)}
                                aria-label={`Preview ${asset.name}`}
                            >
                                {asset.kind === "image"
                                    ? <img src={assetUrl(asset)} alt="" />
                                    : <video src={assetUrl(asset)} muted playsInline preload="metadata" />}
                            </button>
                            <div className={styles.copy}>
                                <label className={styles.checkbox}>
                                    <input type="checkbox" checked={checked} onChange={() => toggle(asset)} />
                                    <span className="sr-only">Select {asset.name}</span>
                                </label>
                                <div>
                                    <strong title={asset.name}>{asset.name}</strong>
                                    <small>{asset.root} · {asset.kind} · {formatBytes(asset.size)}</small>
                                </div>
                            </div>
                            <div className={styles.actions}>
                                <a href={assetUrl(asset)} download>Download</a>
                                <button type="button" onClick={() => void removeAsset(asset)}>Delete</button>
                            </div>
                        </article>
                    );
                })}
            </div>

            {preview && (
                <div className={styles.backdrop} onMouseDown={(event) => event.target === event.currentTarget && closePreview()}>
                    <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label={`Preview ${preview.name}`}>
                        <button type="button" onClick={closePreview} aria-label="Close preview">×</button>
                        {preview.kind === "image"
                            ? <img src={assetUrl(preview)} alt={preview.name} />
                            : <video src={assetUrl(preview)} controls autoPlay playsInline tabIndex={0} />}
                        <strong>{preview.name}</strong>
                        <div className={styles.previewActions}>
                            <a href={assetUrl(preview)} download>Download</a>
                            <button type="button" onClick={() => void removeAsset(preview)} disabled={busy}>Delete</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function trapFocus(event: KeyboardEvent, container: HTMLElement | null) {
    if (event.key !== "Tab" || !container) return;
    const focusable = [...container.querySelectorAll<HTMLElement>("button,[href],video,[tabindex]:not([tabindex='-1'])")]
        .filter((item) => !item.hasAttribute("disabled"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function formatBytes(value: number) {
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
