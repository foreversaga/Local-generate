"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { localizedCopy } from "../../lib/ui-copy.mjs";
import { useI18n } from "../../i18n/I18nProvider";
import { assetKey, assetUrl, deleteAsset, deleteAssetFolder, fetchAssetLibrary, uploadAssets, type StudioAsset, type StudioAssetFolder } from "./asset-client";
import { buildAssetNavigation, sortAssets } from "./asset-navigation";
import { ScriptLibraryManager } from "./ScriptLibraryManager";
import { LongScriptLibraryManager } from "./LongScriptLibraryManager";
import styles from "./LibraryWorkspace.module.css";

const NEW_UPLOAD_FOLDER = "__new_upload_folder__";

export function LibraryWorkspace() {
    const { locale } = useI18n();
    const { ACTION_LABELS, SOURCE_LABELS } = localizedCopy(locale);
    const [assets, setAssets] = useState<StudioAsset[]>([]);
    const [folderRecords, setFolderRecords] = useState<StudioAssetFolder[]>([]);
    const [root, setRoot] = useState<"all" | "input" | "output" | "scripts" | "long-scripts">("all");
    const [query, setQuery] = useState("");
    const [currentPath, setCurrentPath] = useState<string[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
    const [pendingUploadFiles, setPendingUploadFiles] = useState<File[]>([]);
    const [uploadFolderMode, setUploadFolderMode] = useState<"existing" | "new">("existing");
    const [uploadFolder, setUploadFolder] = useState("");
    const [newUploadFolder, setNewUploadFolder] = useState("");
    const [preview, setPreview] = useState<StudioAsset | null>(null);
    const [pendingDelete, setPendingDelete] = useState<{ assets: StudioAsset[]; folders: Array<{ root: "input" | "output"; path: string }>; size: number } | null>(null);
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
    const inputFolders = useMemo(() => folderRecords
        .filter((folder) => folder.root === "input")
        .sort((left, right) => left.path.localeCompare(right.path)), [folderRecords]);
    const navigation = useMemo(() => buildAssetNavigation(scopedAssets, currentPath, scopedFolders), [currentPath, scopedAssets, scopedFolders]);

    const visibleAssets = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const candidates = needle ? scopedAssets : navigation.directAssets;
        return sortAssets(candidates.filter((asset) => !needle || asset.name.toLowerCase().includes(needle)));
    }, [navigation.directAssets, query, scopedAssets]);

    function folderAssets(path: string[]) {
        return scopedAssets.filter((asset) => {
            const segments = asset.name.replaceAll("\\", "/").split("/").filter(Boolean);
            return path.every((segment, index) => segments[index] === segment) && segments.length > path.length;
        });
    }

    function folderKey(rootName: StudioAsset["root"], path: string[]) {
        return `${rootName}:${path.join("/")}`;
    }

    function folderSelectionState(path: string[]) {
        const items = folderAssets(path);
        const count = items.filter((asset) => selected.has(assetKey(asset))).length;
        return count === 0 ? "none" : count === items.length ? "all" : "partial";
    }

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

    function requestDelete(assetsToDelete: StudioAsset[], folders: Array<{ root: "input" | "output"; path: string }> = []) {
        const uniqueFolders = [...new Map(folders.map((folder) => [`${folder.root}:${folder.path}`, folder])).values()];
        const folderAssetsToDelete = assets.filter((asset) => uniqueFolders.some((folder) => (
            asset.root === folder.root && (asset.name === folder.path || asset.name.startsWith(`${folder.path}/`))
        )));
        const uniqueAssets = [...new Map([...assetsToDelete, ...folderAssetsToDelete].map((asset) => [assetKey(asset), asset])).values()];
        if ((!uniqueAssets.length && !uniqueFolders.length) || busy) return;
        setPendingDelete({ assets: uniqueAssets, folders: uniqueFolders, size: uniqueAssets.reduce((total, asset) => total + asset.size, 0) });
    }

    function requestDeleteSelected() {
        const chosen = assets.filter((asset) => selected.has(assetKey(asset)));
        const folders = [...selectedFolders].map((key) => {
            const separator = key.indexOf(":");
            const rootName = key.slice(0, separator);
            return rootName === "input" || rootName === "output" ? { root: rootName, path: key.slice(separator + 1) } : null;
        }).filter((folder): folder is { root: "input" | "output"; path: string } => Boolean(folder));
        requestDelete(chosen, folders);
    }

    async function executeDelete() {
        if (!pendingDelete || busy) return;
        setBusy(true);
        setError("");
        try {
            for (const folder of pendingDelete.folders) await deleteAssetFolder(folder.root, folder.path);
            const remainingAssets = pendingDelete.assets.filter((asset) => !pendingDelete.folders.some((folder) => (
                asset.root === folder.root && (asset.name === folder.path || asset.name.startsWith(`${folder.path}/`))
            )));
            for (const asset of remainingAssets) await deleteAsset(asset);
            setSelected(new Set());
            setSelectedFolders(new Set());
            setPendingDelete(null);
            await refresh();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "刪除素材失敗。");
        } finally {
            setBusy(false);
        }
    }

    function openUploadDialog(files: File[]) {
        if (!files.length || busy) return;
        const currentFolder = root === "input" ? currentPath.join("/") : "";
        setUploadFolder(inputFolders.some((folder) => folder.path === currentFolder) ? currentFolder : "");
        setUploadFolderMode("existing");
        setNewUploadFolder("");
        setError("");
        setPendingUploadFiles(files);
    }

    function closeUploadDialog() {
        if (busy) return;
        setPendingUploadFiles([]);
        setUploadFolderMode("existing");
        setUploadFolder("");
        setNewUploadFolder("");
    }

    async function upload(files: File[], targetFolder: string) {
        if (!files.length || busy) return;
        setBusy(true);
        setError("");
        try {
            await uploadAssets(files, targetFolder);
            setPendingUploadFiles([]);
            setUploadFolderMode("existing");
            setUploadFolder("");
            setNewUploadFolder("");
            setRoot("input");
            setCurrentPath(folderPathSegments(targetFolder));
            setQuery("");
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
                    {(["all", "input", "output", "scripts", "long-scripts"] as const).map((item) => (
                        <button key={item} type="button" className={root === item ? styles.active : ""} aria-pressed={root === item} onClick={() => { setRoot(item); setCurrentPath([]); setQuery(""); }}>
                            {item === "scripts" ? "劇本" : item === "long-scripts" ? "長影片劇本" : SOURCE_LABELS[item] || item}
                        </button>
                    ))}
                </div>
                {root === "scripts" ? <p className={styles.scriptCategoryCopy}>管理 Single 與通用流程可套用的提示詞。</p> : root === "long-scripts" ? <p className={styles.scriptCategoryCopy}>管理只在長影片模式使用的多分鏡劇本。</p> : <>
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
                                openUploadDialog(Array.from(event.target.files || []));
                                event.target.value = "";
                            }}
                        />
                    </label>
                    <button type="button" className={styles.delete} disabled={(!selected.size && !selectedFolders.size) || busy} onClick={requestDeleteSelected}>
                        刪除{selected.size + selectedFolders.size ? `（${selected.size + selectedFolders.size}）` : ""}
                    </button>
                </>}
            </section>

            {error && <div className={styles.error} role="alert">{error}</div>}
            {root === "scripts" ? <ScriptLibraryManager /> : root === "long-scripts" ? <LongScriptLibraryManager /> : <>
            {pendingUploadFiles.length > 0 && (
                <div className={styles.backdrop} role="presentation" onClick={(event) => event.target === event.currentTarget && closeUploadDialog()}>
                    <div className={`${styles.confirmDialog} ${styles.uploadDialog}`} role="dialog" aria-modal="true" aria-labelledby="upload-assets-title">
                        <h2 id="upload-assets-title">上傳素材</h2>
                        <p>選擇要寫入的 ComfyUI/input 資料夾；也可以建立新的資料夾。</p>
                        <div className={styles.uploadFiles} aria-label="待上傳檔案">
                            {pendingUploadFiles.map((file, index) => <span key={`${file.name}-${index}`}>{file.name}</span>)}
                        </div>
                        <label className={styles.uploadField}>
                            <span>上傳到資料夾</span>
                            <select
                                aria-label="上傳到 input 資料夾"
                                value={uploadFolderMode === "new" ? NEW_UPLOAD_FOLDER : uploadFolder}
                                onChange={(event) => {
                                    if (event.target.value === NEW_UPLOAD_FOLDER) {
                                        setUploadFolderMode("new");
                                    } else {
                                        setUploadFolderMode("existing");
                                        setUploadFolder(event.target.value);
                                    }
                                }}
                                disabled={busy}
                            >
                                <option value="">ComfyUI/input（根目錄）</option>
                                {inputFolders.map((folder) => <option key={folder.path} value={folder.path}>{folder.path}</option>)}
                                <option value={NEW_UPLOAD_FOLDER}>建立新的資料夾…</option>
                            </select>
                        </label>
                        {uploadFolderMode === "new" && (
                            <label className={styles.uploadField}>
                                <span>新資料夾名稱</span>
                                <input
                                    aria-label="新資料夾名稱"
                                    value={newUploadFolder}
                                    onChange={(event) => setNewUploadFolder(event.target.value)}
                                    placeholder="例如 training/新角色"
                                    disabled={busy}
                                />
                            </label>
                        )}
                        {error && <p className={styles.error} role="alert">{error}</p>}
                        <div className={styles.previewActions}>
                            <button type="button" onClick={closeUploadDialog} disabled={busy}>取消</button>
                            <button
                                type="button"
                                onClick={() => void upload(pendingUploadFiles, uploadFolderMode === "new" ? newUploadFolder.trim() : uploadFolder)}
                                disabled={busy || (uploadFolderMode === "new" && !newUploadFolder.trim())}
                            >
                                {busy ? "上傳中…" : `上傳 ${pendingUploadFiles.length} 個檔案`}
                            </button>
                        </div>
                    </div>
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
                {!query.trim() && navigation.folders.map((folder) => {
                    const folderState = folderSelectionState(folder.path);
                    const folderRoots = [...folder.roots].filter((value): value is "input" | "output" => value === "input" || value === "output");
                    const folderSelected = folderRoots.length > 0 && folderRoots.every((value) => selectedFolders.has(folderKey(value, folder.path)));
                    return (
                    <article key={`folder:${folder.path.join("/")}`} className={`${styles.folderCard} ${folderState !== "none" ? styles.selected : ""}`}>
                        <div className={styles.folderHeader}>
                            {folderRoots.length > 0 && (
                                <input
                                    type="checkbox"
                                    aria-label={`選取資料夾 ${folder.path.join("/")}`}
                                    aria-checked={folderSelected ? "true" : folderState === "partial" ? "mixed" : "false"}
                                    checked={folderSelected}
                                    ref={(node) => { if (node) node.indeterminate = folderState === "partial" || (folderRoots.some((value) => selectedFolders.has(folderKey(value, folder.path))) && !folderSelected); }}
                                    onChange={() => {
                                        const next = new Set(selectedFolders);
                                        if (folderSelected) folderRoots.forEach((value) => next.delete(folderKey(value, folder.path)));
                                        else folderRoots.forEach((value) => next.add(folderKey(value, folder.path)));
                                        setSelectedFolders(next);
                                        setSelected((current) => {
                                            const updated = new Set(current);
                                            folderAssets(folder.path).forEach((asset) => {
                                                if (folderRoots.includes(asset.root as "input" | "output")) {
                                                    if (folderSelected) updated.delete(assetKey(asset));
                                                    else updated.add(assetKey(asset));
                                                }
                                            });
                                            return updated;
                                        });
                                    }}
                                />
                            )}
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
                        </div>
                    </article>
                    );
                })}
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
                                    <small>{SOURCE_LABELS[asset.root] || asset.root} · {asset.kind === "image" ? "圖片" : "影片"} · {formatBytes(asset.size)}</small>
                                </div>
                            </div>
                            <div className={styles.actions}>
                                <a href={assetUrl(asset)} download>{ACTION_LABELS.downloadResult}</a>
                                <button type="button" onClick={() => requestDelete([asset])}>刪除</button>
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
                            <button type="button" onClick={() => requestDelete([preview])} disabled={busy}>刪除</button>
                        </div>
                    </div>
                </div>
            )}

            {pendingDelete && (
                <div className={styles.backdrop} role="presentation">
                    <div className={styles.confirmDialog} role="alertdialog" aria-modal="true" aria-labelledby="delete-assets-title">
                        <h2 id="delete-assets-title">確定刪除？</h2>
                        <p>{pendingDelete.folders.length} 個資料夾 · {pendingDelete.assets.length} 個檔案 · {formatBytes(pendingDelete.size)}</p>
                        {pendingDelete.folders.length > 0 && <p className={styles.deleteWarning}>此操作會刪除所有子資料夾內容。</p>}
                        {error && <p className={styles.error} role="alert">{error}</p>}
                        <div className={styles.previewActions}>
                            <button type="button" onClick={() => setPendingDelete(null)} disabled={busy}>取消</button>
                            <button type="button" onClick={() => void executeDelete()} disabled={busy}>刪除 {pendingDelete.assets.length} 個檔案</button>
                        </div>
                    </div>
                </div>
            )}
            </>}
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

function folderPathSegments(value: string) {
    return value.trim().replaceAll("\\", "/").split("/").filter(Boolean);
}
