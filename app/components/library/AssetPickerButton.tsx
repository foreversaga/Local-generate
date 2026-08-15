"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { localizedCopy } from "../../lib/ui-copy.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import { assetKey, assetUrl, fetchAssetLibrary, type AssetSource, type StudioAsset, type StudioAssetFolder } from "./asset-client";
import { buildAssetNavigation, pathSegments, sortAssets } from "./asset-navigation";
import styles from "./AssetPickerButton.module.css";

export type AssetPickerConstraints = {
    allowedRoots?: Array<"input" | "output" | "training">;
    allowedKinds?: Array<"image" | "video">;
    multiple?: boolean;
    maxSelection?: number;
    allowFolderSelection?: boolean;
};

type Props = AssetPickerConstraints & {
    /** Backwards-compatible shorthand for a single root. */
    root?: "input" | "output";
    /** Backwards-compatible shorthand for a single kind. */
    kind?: "image" | "video";
    assetSource?: AssetSource;
    /** Backwards-compatible alias for maxSelection. */
    max?: number;
    selectedKeys?: string[];
    label?: string;
    triggerId?: string;
    onSelect: (assets: StudioAsset[]) => void;
};

type PickerRoot = "all" | "input" | "output" | "training";

export function AssetPickerButton({
    kind,
    root,
    assetSource = "library",
    allowedRoots,
    allowedKinds,
    multiple = false,
    maxSelection,
    allowFolderSelection = multiple,
    max,
    selectedKeys = [],
    label: providedLabel,
    triggerId,
    onSelect,
}: Props) {
    const { locale } = useI18n();
    const { ACTION_LABELS, SOURCE_LABELS } = localizedCopy(locale);
    const label = providedLabel || ACTION_LABELS.browseLibrary;
    const rootOptions: Array<{ value: PickerRoot; label: string }> = [
        { value: "all", label: SOURCE_LABELS.all },
        { value: "input", label: SOURCE_LABELS.input },
        { value: "output", label: SOURCE_LABELS.output },
        { value: "training", label: SOURCE_LABELS.training },
    ];
    const roots = useMemo<Array<"input" | "output" | "training">>(() => {
        if (allowedRoots?.length) return allowedRoots;
        if (root) return [root];
        if (assetSource === "training") return ["input", "output", "training"];
        return ["input", "output"];
    }, [allowedRoots, assetSource, root]);
    const kinds = useMemo<Array<"image" | "video">>(() => {
        if (allowedKinds?.length) return allowedKinds;
        return kind ? [kind] : ["image", "video"];
    }, [allowedKinds, kind]);
    const selectionLimit = multiple ? Math.max(1, maxSelection ?? max ?? 1) : 1;
    const [open, setOpen] = useState(false);
    const [assets, setAssets] = useState<StudioAsset[]>([]);
    const [folderRecords, setFolderRecords] = useState<StudioAssetFolder[]>([]);
    const [query, setQuery] = useState("");
    const [currentPath, setCurrentPath] = useState<string[]>([]);
    const [activeRoot, setActiveRoot] = useState<PickerRoot>(roots.length === 1 ? roots[0] : "all");
    const [selected, setSelected] = useState<Set<string>>(new Set(selectedKeys));
    const [preview, setPreview] = useState<StudioAsset | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selectionNotice, setSelectionNotice] = useState("");
    const triggerRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const selectedKeysSignature = JSON.stringify(selectedKeys);
    const availableRootOptions = rootOptions.filter((option) => option.value === "all" ? roots.length > 1 : roots.includes(option.value));
    const sourceLabel = assetSource === "training" ? SOURCE_LABELS.training : "素材選擇器";
    const breadcrumbLabel = SOURCE_LABELS[activeRoot] || SOURCE_LABELS.all;

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
            .catch((reason) => setError(reason instanceof Error ? reason.message : "無法載入素材。"))
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

    const scopedAssets = useMemo(() => assets.filter((asset) => (
        roots.includes(asset.root)
        && (activeRoot === "all" || asset.root === activeRoot)
        && kinds.includes(asset.kind)
    )), [activeRoot, assets, kinds, roots]);
    const scopedFolders = useMemo(() => folderRecords.filter((folder) => (
        roots.includes(folder.root)
        && (activeRoot === "all" || folder.root === activeRoot)
    )), [activeRoot, folderRecords, roots]);
    const navigation = useMemo(() => buildAssetNavigation(scopedAssets, currentPath, scopedFolders, kinds.length === 1 ? kinds[0] : undefined), [currentPath, kinds, scopedAssets, scopedFolders]);
    const visibleAssets = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const candidates = needle ? scopedAssets : navigation.directAssets;
        return sortAssets(candidates.filter((asset) => !needle || asset.name.toLowerCase().includes(needle)));
    }, [navigation.directAssets, query, scopedAssets]);
    const currentFolderKeys = useMemo(() => navigation.directAssets.map(assetKey), [navigation.directAssets]);
    const allCurrentFolderSelected = currentFolderKeys.length > 0 && currentFolderKeys.every((key) => selected.has(key));

    function assetsUnder(path: string[]) {
        return scopedAssets.filter((asset) => {
            const segments = pathSegments(asset.name);
            return path.every((segment, index) => segments[index] === segment) && segments.length > path.length;
        });
    }

    function folderSelectionState(path: string[]) {
        const folderAssets = assetsUnder(path);
        const selectedCount = folderAssets.filter((asset) => selected.has(assetKey(asset))).length;
        return selectedCount === 0 ? "none" : selectedCount === folderAssets.length ? "all" : "partial";
    }

    function openDialog() {
        setLoading(true);
        setCurrentPath([]);
        setQuery("");
        setActiveRoot(roots.length === 1 ? roots[0] : "all");
        setPreview(null);
        setSelectionNotice("");
        setOpen(true);
    }

    function closeDialog() {
        setPreview(null);
        setOpen(false);
        window.setTimeout(() => triggerRef.current?.focus(), 0);
    }

    function changeRoot(nextRoot: PickerRoot) {
        setActiveRoot(nextRoot);
        setCurrentPath([]);
        setQuery("");
        setPreview(null);
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
                if (next.size < selectionLimit) next.add(key);
                else setSelectionNotice(`已達選取上限（${selectionLimit} 項），請先移除已選素材。`);
                return next;
            }
            next.clear();
            next.add(key);
            return next;
        });
    }

    function selectAssets(candidates: StudioAsset[], label: string) {
        const candidateKeys = candidates.map(assetKey);
        setSelected((current) => {
            const next = new Set(current);
            const allSelected = candidateKeys.length > 0 && candidateKeys.every((key) => current.has(key));
            if (allSelected) {
                candidateKeys.forEach((key) => next.delete(key));
                setSelectionNotice(`已取消${label}`);
                return next;
            }
            if (!multiple) {
                const first = candidates[0];
                next.clear();
                if (first) next.add(assetKey(first));
                setSelectionNotice(first ? `已選取 ${first.name}` : "此資料夾沒有符合條件的素材。");
                return next;
            }
            const missing = candidates.filter((asset) => !current.has(assetKey(asset)));
            const available = Math.max(0, selectionLimit - current.size);
            const added = missing.slice(0, available);
            added.forEach((asset) => next.add(assetKey(asset)));
            if (added.length < missing.length) {
                setSelectionNotice(`已加入 ${added.length} 項；已達選取上限（${selectionLimit} 項）。`);
            } else {
                setSelectionNotice(`已選取${label}（${added.length} 項）。`);
            }
            return next;
        });
    }

    function toggleAllCurrentFolder() {
        selectAssets(navigation.directAssets, "目前資料夾素材");
    }

    function toggleFolder(folderPath: string[]) {
        selectAssets(assetsUnder(folderPath), `資料夾 ${folderPath.join("/")}`);
    }

    function confirm() {
        const assetsByKey = new Map(scopedAssets.map((asset) => [assetKey(asset), asset]));
        const chosen = [...selected]
            .map((key) => assetsByKey.get(key))
            .filter((asset): asset is StudioAsset => Boolean(asset))
            .slice(0, selectionLimit);
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
                    <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label="素材選擇器">
                        <header>
                            <div>
                                <span>{sourceLabel}</span>
                                <strong>{multiple ? `最多選取 ${selectionLimit} 項素材` : "選取一項素材"}</strong>
                            </div>
                            <button type="button" onClick={closeDialog} aria-label="關閉素材選擇器">×</button>
                        </header>

                        {availableRootOptions.length > 1 && (
                            <div className={styles.sourceTabs} role="group" aria-label="素材來源">
                                {availableRootOptions.map((option) => (
                                    <button key={option.value} type="button" aria-pressed={activeRoot === option.value || (option.value === "all" && activeRoot === "all")} onClick={() => changeRoot(option.value)}>
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        )}

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
                                    {breadcrumbLabel}
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
                            {multiple && !query.trim() && navigation.directAssets.length > 0 && (
                                <button type="button" className={styles.bulkButton} aria-pressed={allCurrentFolderSelected} onClick={toggleAllCurrentFolder}>
                                    {allCurrentFolderSelected ? "取消全選" : "全選目前資料夾"}
                                </button>
                            )}
                            {query.trim() && <span className={styles.searchStatus}>搜尋全部子資料夾</span>}
                        </div>

                        <label className={styles.search}>
                            <span className="sr-only">搜尋素材</span>
                            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋所有素材…" />
                        </label>

                        <div className={styles.body}>
                            <div className={styles.grid}>
                                {loading && <p>載入中…</p>}
                                {error && <p className={styles.error} role="alert">{error}</p>}
                                {!query.trim() && navigation.folders.map((folder) => {
                                    const folderState = folderSelectionState(folder.path);
                                    const folderAssets = assetsUnder(folder.path);
                                    return (
                                        <article key={`folder:${folder.path.join("/")}`} className={`${styles.folderCard} ${folderState !== "none" ? styles.selected : ""}`}>
                                            <div className={styles.folderHeader}>
                                                {allowFolderSelection && multiple && (
                                                    <input
                                                        type="checkbox"
                                                        aria-label={`選取資料夾 ${folder.path.join("/")}`}
                                                        aria-checked={folderState === "partial" ? "mixed" : folderState === "all"}
                                                        checked={folderState === "all"}
                                                        ref={(node) => { if (node) node.indeterminate = folderState === "partial"; }}
                                                        onChange={() => toggleFolder(folder.path)}
                                                    />
                                                )}
                                                <button type="button" className={styles.folderButton} onClick={() => { setCurrentPath(folder.path); setPreview(null); }} aria-label={`開啟資料夾 ${folder.path.join("/")}`}>
                                                    <span className={styles.folderIcon} aria-hidden="true">資料夾</span>
                                                    <span className={styles.folderCopy}>
                                                        <strong>{folder.path[folder.path.length - 1]}</strong>
                                                        <small>{folderAssets.length || folder.count} 項可選素材{folder.roots.size > 1 ? ` · ${[...folder.roots].map((value) => SOURCE_LABELS[value] || value).join("/")}` : ""}</small>
                                                    </span>
                                                    <span className={styles.folderArrow} aria-hidden="true">›</span>
                                                </button>
                                            </div>
                                        </article>
                                    );
                                })}
                                {visibleAssets.map((asset) => {
                                    const checked = selected.has(assetKey(asset));
                                    return (
                                        <article key={assetKey(asset)} className={`${styles.card} ${checked ? styles.selected : ""}`}>
                                            <button type="button" className={styles.selectButton} aria-pressed={checked} onClick={() => toggle(asset)}>
                                                <span className={styles.thumb}>
                                                    {asset.kind === "image"
                                                        ? <>
                                                            {/* eslint-disable-next-line @next/next/no-img-element -- Bridge asset URLs are dynamic and served without Next image metadata. */}
                                                            <img src={assetUrl(asset)} alt="" />
                                                        </>
                                                        : <video src={assetUrl(asset)} muted playsInline preload="metadata"><track kind="captions" /></video>}
                                                </span>
                                                <span className={styles.copy}>
                                                    <strong title={asset.name}>{asset.name}</strong>
                                                    <small>{SOURCE_LABELS[asset.root] || SOURCE_LABELS.training} · {asset.kind === "image" ? "圖片" : "影片"}</small>
                                                </span>
                                                <span className={styles.check} aria-hidden="true">{checked ? "✓" : ""}</span>
                                            </button>
                                            <button type="button" className={styles.previewButton} onClick={() => setPreview(asset)} aria-label={`預覽 ${asset.name}`}>
                                                {ACTION_LABELS.preview}
                                            </button>
                                        </article>
                                    );
                                })}
                                {!loading && !error && !navigation.folders.length && !visibleAssets.length && <p className={styles.empty}>{query.trim() ? "沒有符合的素材。" : "此資料夾沒有可選取的素材。"}</p>}
                            </div>

                            {preview && (
                                <aside className={styles.preview} aria-label={`預覽 ${preview.name}`}>
                                    <button type="button" onClick={() => setPreview(null)}>{ACTION_LABELS.close}預覽</button>
                                    {preview.kind === "image"
                                        ? <>
                                            {/* eslint-disable-next-line @next/next/no-img-element -- Bridge asset URLs are dynamic and served without Next image metadata. */}
                                            <img src={assetUrl(preview)} alt={preview.name} />
                                        </>
                                        : <video src={assetUrl(preview)} controls playsInline><track kind="captions" /></video>}
                                    <strong>{preview.name}</strong>
                                </aside>
                            )}
                        </div>

                        <footer>
                            <span aria-live="polite">已選取 {selected.size} 項</span>
                            <span className={styles.selectionNotice} role="status" aria-live="polite">{selectionNotice}</span>
                            <button type="button" className={styles.confirm} disabled={!selected.size} onClick={confirm}>{ACTION_LABELS.useSelected}</button>
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
