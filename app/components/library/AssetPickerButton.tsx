"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { assetKey, assetUrl, fetchAssetLibrary, type AssetSource, type StudioAsset, type StudioAssetFolder } from "./asset-client";
import { buildAssetNavigation, sortAssets } from "./asset-navigation";
import styles from "./AssetPickerButton.module.css";

type Props = {
    kind?: "image" | "video";
    root?: "input" | "output";
    assetSource?: AssetSource;
    multiple?: boolean;
    max?: number;
    selectedKeys?: string[];
    label?: string;
    triggerId?: string;
    onSelect: (assets: StudioAsset[]) => void;
};

export function AssetPickerButton({
    kind,
    root,
    assetSource = "library",
    multiple = false,
    max = 1,
    selectedKeys = [],
    label = "Browse Library",
    triggerId,
    onSelect,
}: Props) {
    const [open, setOpen] = useState(false);
    const [assets, setAssets] = useState<StudioAsset[]>([]);
    const [folderRecords, setFolderRecords] = useState<StudioAssetFolder[]>([]);
    const [query, setQuery] = useState("");
    const [currentPath, setCurrentPath] = useState<string[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set(selectedKeys));
    const [preview, setPreview] = useState<StudioAsset | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selectionNotice, setSelectionNotice] = useState("");
    const triggerRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const selectedKeysSignature = JSON.stringify(selectedKeys);
    const sourceLabel = assetSource === "training" ? "訓練素材（專案 input）" : "Asset Picker";
    const breadcrumbLabel = assetSource === "training" ? "訓練素材" : root ?? "All assets";

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setSelected(new Set(JSON.parse(selectedKeysSignature) as string[]));
        }, 0);
        return () => window.clearTimeout(timer);
    }, [selectedKeysSignature]);

    useEffect(() => {
        if (!open) return;

        void fetchAssetLibrary(assetSource)
            .then((next) => { setAssets(next.assets); setFolderRecords(next.folders); setError(""); })
            .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load assets."))
            .finally(() => setLoading(false));

        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>("input,button")?.focus(), 0);

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                closeDialog();
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
    }, [assetSource, open]);

    const scopedAssets = useMemo(() => assets.filter((asset) => (!root || asset.root === root) && (!kind || asset.kind === kind)), [assets, kind, root]);
    const scopedFolders = useMemo(() => folderRecords.filter((folder) => !root || folder.root === root), [folderRecords, root]);
    const navigation = useMemo(() => buildAssetNavigation(scopedAssets, currentPath, scopedFolders, kind), [currentPath, kind, scopedAssets, scopedFolders]);

    const visibleAssets = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const candidates = needle ? scopedAssets : navigation.directAssets;
        return sortAssets(candidates.filter((asset) => !needle || asset.name.toLowerCase().includes(needle)));
    }, [navigation.directAssets, query, scopedAssets]);
    const currentFolderKeys = useMemo(() => navigation.directAssets.map(assetKey), [navigation.directAssets]);
    const allCurrentFolderSelected = currentFolderKeys.length > 0 && currentFolderKeys.every((key) => selected.has(key));

    function openDialog() {
        setLoading(true);
        setCurrentPath([]);
        setQuery("");
        setPreview(null);
        setSelectionNotice("");
        setOpen(true);
    }

    function closeDialog() {
        setPreview(null);
        setOpen(false);
        window.setTimeout(() => triggerRef.current?.focus(), 0);
    }

    function toggle(asset: StudioAsset) {
        const key = assetKey(asset);
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(key)) {
                next.delete(key);
                return next;
            }
            if (multiple) {
                if (next.size < max) next.add(key);
                return next;
            }
            next.clear();
            next.add(key);
            return next;
        });
    }

    function toggleAllCurrentFolder() {
        const current = selected;
        const next = new Set(current);
        const allSelected = currentFolderKeys.length > 0 && currentFolderKeys.every((key) => current.has(key));

        if (allSelected) {
            currentFolderKeys.forEach((key) => next.delete(key));
            setSelectionNotice("已取消全選圖片");
        } else {
            const limit = Math.max(0, max);
            const available = Math.max(0, limit - current.size);
            const missingKeys = currentFolderKeys.filter((key) => !current.has(key));
            if (available === 0) {
                setSelectionNotice(`已達選取上限（${limit} 張），無法新增圖片`);
            } else {
                const keysToAdd = missingKeys.slice(0, available);
                keysToAdd.forEach((key) => next.add(key));
                if (keysToAdd.length < missingKeys.length) {
                    setSelectionNotice(`已加入 ${keysToAdd.length} 張圖片；已達選取上限（${limit} 張）`);
                } else if (next.size >= limit) {
                    setSelectionNotice(`已全選目前資料夾圖片；已達選取上限（${limit} 張）`);
                } else {
                    setSelectionNotice(`已全選目前資料夾圖片（加入 ${keysToAdd.length} 張）`);
                }
            }
        }
        setSelected(next);
    }

    function confirm() {
        const limit = multiple ? max : 1;
        const chosen = scopedAssets.filter((asset) => selected.has(assetKey(asset))).slice(0, limit);
        onSelect(chosen);
        closeDialog();
    }

    return (
        <>
            <button id={triggerId} ref={triggerRef} type="button" className={styles.trigger} aria-haspopup="dialog" aria-expanded={open} onClick={openDialog}>
                {label}
            </button>
            {open && (
                <div className={styles.backdrop} role="presentation" onClick={(event) => event.target === event.currentTarget && closeDialog()}>
                    <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label="Asset picker">
                        <header>
                            <div>
                                <span>{sourceLabel}</span>
                                <strong>{multiple ? `Select up to ${max}` : "Select one asset"}</strong>
                            </div>
                            <button type="button" onClick={closeDialog} aria-label="Close asset picker">×</button>
                        </header>

                        <div className={styles.navigation}>
                            <button
                                type="button"
                                className={styles.backButton}
                                onClick={() => setCurrentPath((path) => path.slice(0, -1))}
                                disabled={!currentPath.length || Boolean(query.trim())}
                                aria-label="Back to parent folder"
                            >
                                Back
                            </button>
                            <nav className={styles.breadcrumbs} aria-label="Current asset folder">
                                <button
                                    type="button"
                                    className={styles.breadcrumb}
                                    onClick={() => setCurrentPath([])}
                                    aria-current={!currentPath.length ? "page" : undefined}
                                >
                                    {breadcrumbLabel}
                                </button>
                                {currentPath.map((segment, index) => {
                                    const path = currentPath.slice(0, index + 1);
                                    const isCurrent = index === currentPath.length - 1;
                                    return (
                                        <span key={path.join("/")} className={styles.breadcrumbItem}>
                                            <span aria-hidden="true">/</span>
                                            <button
                                                type="button"
                                                className={styles.breadcrumb}
                                                onClick={() => setCurrentPath(path)}
                                                aria-current={isCurrent ? "page" : undefined}
                                                disabled={Boolean(query.trim())}
                                            >
                                                {segment}
                                            </button>
                                        </span>
                                    );
                                })}
                            </nav>
                            {multiple && !query.trim() && navigation.directAssets.length > 0 && (
                                <button
                                    type="button"
                                    className={styles.bulkButton}
                                    aria-pressed={allCurrentFolderSelected}
                                    onClick={toggleAllCurrentFolder}
                                >
                                    {allCurrentFolderSelected ? "取消全選圖片" : "全選圖片"}
                                </button>
                            )}
                            {query.trim() && <span className={styles.searchStatus}>Searching all folders</span>}
                        </div>

                        <label className={styles.search}>
                            <span className="sr-only">Search assets</span>
                            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search recent assets…" />
                        </label>

                        <div className={styles.body}>
                            <div className={styles.grid}>
                                {loading && <p>Loading…</p>}
                                {error && <p className={styles.error} role="alert">{error}</p>}
                                {!query.trim() && navigation.folders.map((folder) => (
                                    <article key={`folder:${folder.path.join("/")}`} className={styles.folderCard}>
                                        <button
                                            type="button"
                                            className={styles.folderButton}
                                            onClick={() => { setCurrentPath(folder.path); setPreview(null); }}
                                            aria-label={`Open folder ${folder.path.join("/")}`}
                                        >
                                            <span className={styles.folderIcon} aria-hidden="true">Folder</span>
                                            <span className={styles.folderCopy}>
                                                <strong>{folder.path[folder.path.length - 1]}</strong>
                                                <small>{folder.count} selectable {folder.count === 1 ? "asset" : "assets"}{folder.roots.size > 1 ? ` · ${[...folder.roots].join("/")}` : ""}</small>
                                            </span>
                                            <span className={styles.folderArrow} aria-hidden="true">›</span>
                                        </button>
                                    </article>
                                ))}
                                {visibleAssets.map((asset) => {
                                    const checked = selected.has(assetKey(asset));
                                    return (
                                        <article key={assetKey(asset)} className={`${styles.card} ${checked ? styles.selected : ""}`}>
                                            <button
                                                type="button"
                                                className={styles.selectButton}
                                                aria-pressed={checked}
                                                onClick={() => toggle(asset)}
                                            >
                                                <span className={styles.thumb}>
                                                    {asset.kind === "image"
                                                        ? <>
                                                            {/* eslint-disable-next-line @next/next/no-img-element -- Bridge asset URLs are dynamic and served without Next image metadata. */}
                                                            <img src={assetUrl(asset)} alt="" />
                                                        </>
                                                        : <video src={assetUrl(asset)} muted playsInline preload="metadata">
                                                            <track kind="captions" />
                                                        </video>}
                                                </span>
                                                <span className={styles.copy}>
                                                    <strong title={asset.name}>{asset.name}</strong>
                                                    <small>{asset.root} · {asset.kind}</small>
                                                </span>
                                                <span className={styles.check} aria-hidden="true">{checked ? "✓" : ""}</span>
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.previewButton}
                                                onClick={() => setPreview(asset)}
                                                aria-label={`Preview ${asset.name}`}
                                            >
                                                Preview
                                            </button>
                                        </article>
                                    );
                                })}
                                {!loading && !error && !navigation.folders.length && !visibleAssets.length && (
                                    <p className={styles.empty}>
                                        {query.trim() ? "No matching assets." : "This folder has no selectable assets."}
                                    </p>
                                )}
                            </div>

                            {preview && (
                                <aside className={styles.preview} aria-label={`Preview ${preview.name}`}>
                                    <button type="button" onClick={() => setPreview(null)}>Close preview</button>
                                    {preview.kind === "image"
                                        ? <>
                                            {/* eslint-disable-next-line @next/next/no-img-element -- Bridge asset URLs are dynamic and served without Next image metadata. */}
                                            <img src={assetUrl(preview)} alt={preview.name} />
                                        </>
                                        : <video src={assetUrl(preview)} controls playsInline>
                                            <track kind="captions" />
                                        </video>}
                                    <strong>{preview.name}</strong>
                                </aside>
                            )}
                        </div>

                        <footer>
                            <span aria-live="polite">{selected.size} selected</span>
                            <span className={styles.selectionNotice} role="status" aria-live="polite">{selectionNotice}</span>
                            <button type="button" className={styles.confirm} disabled={!selected.size} onClick={confirm}>Use selected</button>
                        </footer>
                    </div>
                </div>
            )}
        </>
    );
}

function trapFocus(event: KeyboardEvent, container: HTMLElement | null) {
    if (event.key !== "Tab" || !container) return;
    const focusable = [...container.querySelectorAll<HTMLElement>("button,input,[href],select,textarea,[tabindex]:not([tabindex='-1'])")]
        .filter((item) => !item.hasAttribute("disabled") && item.getAttribute("aria-hidden") !== "true");
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
