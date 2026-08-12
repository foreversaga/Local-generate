"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ACTION_LABELS, SOURCE_LABELS } from "../../lib/ui-copy.mjs";
import { assetKey, assetUrl, deleteAsset, fetchAssetLibrary, uploadAssets, type StudioAsset, type StudioAssetFolder } from "./asset-client";
import { buildAssetNavigation, sortAssets } from "./asset-navigation";
import styles from "./LibraryWorkspace.module.css";

export function LibraryWorkspace() {
    const [assets, setAssets] = useState<StudioAsset[]>([]);
    const [folderRecords, setFolderRecords] = useState<StudioAssetFolder[]>([]);
    const [root, setRoot] = useState<"all" | "input" | "output">("all");
    const [query, setQuery] = useState("");
    const [currentPath, setCurrentPath] = useState<string[]>([]);
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

    const scopedAssets = useMemo(() => assets.filter((asset) => root === "all" || asset.root === root), [assets, root]);
    const scopedFolders = useMemo(() => folderRecords.filter((folder) => root === "all" || folder.root === root), [folderRecords, root]);
    const navigation = useMemo(() => buildAssetNavigation(scopedAssets, currentPath, scopedFolders), [currentPath, scopedAssets, scopedFolders]);

    const visibleAssets = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const candidates = needle ? scopedAssets : navigation.directAssets;
        return sortAssets(candidates.filter((asset) => !needle || asset.name.toLowerCase().includes(needle)));
    }, [navigation.directAssets, query, scopedAssets]);

    async function refresh() {
        try {
            const library = await fetchAssetLibrary();
            setAssets(library.assets);
            setFolderRecords(library.folders);
            setError("");
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "無法載入素材。");
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
            if (next.has(key)) next.delete(key);
            else next.add(key);
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
            setError(reason instanceof Error ? reason.message : "刪除素材失敗。");
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
            setError(reason instanceof Error ? reason.message : "刪除素材失敗。");
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
            setError(reason instanceof Error ? reason.message : "上傳素材失敗。");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={styles.workspace}>
            <section className={styles.toolbar}>
                <div className={styles.tabs} role="group" aria-label="素材分類">
                    {(["all", "input", "output"] as const).map((item) => (
                        <button key={item} type="button" className={root === item ? styles.active : ""} aria-pressed={root === item} onClick={() => { setRoot(item); setCurrentPath([]); setQuery(""); }}>
                            {SOURCE_LABELS[item] || item}
                        </button>
                    ))}
                </div>
                <label className={styles.search}>
                    <span className="sr-only">搜尋素材</span>
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋素材…" />
                </label>
                <label className={styles.upload}>
                    上傳素材
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
                    刪除{selected.size ? `（${selected.size}）` : ""}
                </button>
            </section>

            {error && <div className={styles.error} role="alert">{error}</div>}
            <div className={styles.navigation}>
                <button
                    type="button"
                    className={styles.backButton}
                    onClick={() => setCurrentPath((path) => path.slice(0, -1))}
                    disabled={!currentPath.length || Boolean(query.trim())}
                    aria-label="返回上一層資料夾"
                >
                    {ACTION_LABELS.back}
                </button>
                <nav className={styles.breadcrumbs} aria-label="目前素材資料夾">
                    <button type="button" className={styles.breadcrumb} onClick={() => setCurrentPath([])} aria-current={!currentPath.length ? "page" : undefined}>
                        {SOURCE_LABELS[root] || "全部素材"}
                    </button>
                    {currentPath.map((segment, index) => {
                        const path = currentPath.slice(0, index + 1);
                        const isCurrent = index === currentPath.length - 1;
                        return (
                            <span key={path.join("/")} className={styles.breadcrumbItem}>
                                <span aria-hidden="true">/</span>
                                <button type="button" className={styles.breadcrumb} onClick={() => setCurrentPath(path)} aria-current={isCurrent ? "page" : undefined} disabled={Boolean(query.trim())}>
                                    {segment}
                                </button>
                            </span>
                        );
                    })}
                </nav>
                {query.trim() && <span className={styles.searchStatus}>搜尋全部資料夾</span>}
            </div>
            <div className={styles.meta}>{visibleAssets.length} 項素材{navigation.folders.length && !query.trim() ? ` · ${navigation.folders.length} 個資料夾` : ""}</div>

            <div className={styles.grid}>
                {!query.trim() && navigation.folders.map((folder) => (
                    <article key={`folder:${folder.path.join("/")}`} className={styles.folderCard}>
                        <button
                            type="button"
                            className={styles.folderButton}
                            onClick={() => { setCurrentPath(folder.path); setPreview(null); }}
                            aria-label={`開啟資料夾 ${folder.path.join("/")}`}
                        >
                            <span className={styles.folderIcon} aria-hidden="true">資料夾</span>
                            <span className={styles.folderCopy}>
                                <strong>{folder.path[folder.path.length - 1]}</strong>
                                <small>{folder.count} 項素材{folder.roots.size > 1 ? ` · ${[...folder.roots].map((value) => SOURCE_LABELS[value] || value).join("／")}` : ""}</small>
                            </span>
                            <span className={styles.folderArrow} aria-hidden="true">→</span>
                        </button>
                    </article>
                ))}
                {visibleAssets.map((asset) => {
                    const checked = selected.has(assetKey(asset));
                    return (
                        <article key={assetKey(asset)} className={`${styles.card} ${checked ? styles.selected : ""}`}>
                            <button
                                type="button"
                                className={styles.previewButton}
                                onClick={(event) => openPreview(asset, event.currentTarget)}
                                aria-label={`預覽 ${asset.name}`}
                            >
                                {asset.kind === "image"
                                    ? <>
                                        {/* eslint-disable-next-line @next/next/no-img-element -- Bridge asset URLs are dynamic and served without Next image metadata. */}
                                        <img src={assetUrl(asset)} alt="" />
                                    </>
                                    : <video src={assetUrl(asset)} muted playsInline preload="metadata">
                                        <track kind="captions" />
                                    </video>}
                            </button>
                            <div className={styles.copy}>
                                <label className={styles.checkbox}>
                                    <input type="checkbox" checked={checked} onChange={() => toggle(asset)} />
                                    <span className="sr-only">選取 {asset.name}</span>
                                </label>
                                <div>
                                    <strong title={asset.name}>{asset.name}</strong>
                                    <small>{asset.root} · {asset.kind} · {formatBytes(asset.size)}</small>
                                </div>
                            </div>
                            <div className={styles.actions}>
                                <a href={assetUrl(asset)} download>{ACTION_LABELS.downloadResult}</a>
                                <button type="button" onClick={() => void removeAsset(asset)}>刪除</button>
                            </div>
                        </article>
                    );
                })}
                {!visibleAssets.length && !navigation.folders.length && !error && <p className={styles.empty}>此資料夾沒有素材。</p>}
            </div>

            {preview && (
                <div className={styles.backdrop} role="presentation" onClick={(event) => event.target === event.currentTarget && closePreview()}>
                    <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label={`預覽 ${preview.name}`}>
                        <button type="button" onClick={closePreview} aria-label="關閉預覽">×</button>
                        {preview.kind === "image"
                            ? <>
                                {/* eslint-disable-next-line @next/next/no-img-element -- Bridge asset URLs are dynamic and served without Next image metadata. */}
                                <img src={assetUrl(preview)} alt={preview.name} />
                            </>
                            : <video src={assetUrl(preview)} controls autoPlay playsInline tabIndex={0}>
                                <track kind="captions" />
                            </video>}
                        <strong>{preview.name}</strong>
                        <div className={styles.previewActions}>
                            <a href={assetUrl(preview)} download>{ACTION_LABELS.downloadResult}</a>
                            <button type="button" onClick={() => void removeAsset(preview)} disabled={busy}>刪除</button>
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
