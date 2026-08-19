"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent } from "react";
import {
    assetKey,
    assetUrl,
    fetchAssets,
    uploadAssets,
    type StudioAsset,
} from "../library/asset-client";
import { WORKSPACE_ASSET_DRAG_TYPE } from "./workspace-asset-dnd";
import styles from "./AssetDock.module.css";

type ProjectAsset = { key: string; role?: string };
type AssetDockProps = {
    locale: string;
    projectAssets: ProjectAsset[];
    onAddAsset: (asset: StudioAsset) => void;
};

type RootFilter = "all" | "input" | "output";

export function AssetDock({ locale, projectAssets, onAddAsset }: AssetDockProps) {
    const zh = locale.toLowerCase().startsWith("zh");
    const copy = assetDockCopy(zh);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [assets, setAssets] = useState<StudioAsset[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState("");
    const [query, setQuery] = useState("");
    const [root, setRoot] = useState<RootFilter>("all");

    useEffect(() => {
        let active = true;
        void fetchAssets()
            .then((items) => {
                if (!active) return;
                setAssets(items);
                setError("");
            })
            .catch((reason) => {
                if (active) setError(reason instanceof Error ? reason.message : copy.loadError);
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => { active = false; };
    }, [copy.loadError]);

    const projectAssetKeys = useMemo(() => new Set(projectAssets.map((asset) => asset.key)), [projectAssets]);
    const visibleAssets = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return assets
            .filter((asset) => (root === "all" || asset.root === root)
                && (!needle || asset.name.toLowerCase().includes(needle)))
            .sort((left, right) => Date.parse(right.modified) - Date.parse(left.modified));
    }, [assets, query, root]);

    async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        if (!files.length) return;
        setUploading(true);
        setError("");
        try {
            const uploaded = await uploadAssets(files);
            setAssets((current) => mergeAssets(current, uploaded));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : copy.uploadError);
        } finally {
            setUploading(false);
        }
    }

    function handleDragStart(event: ReactDragEvent<HTMLElement>, asset: StudioAsset) {
        event.dataTransfer.setData(WORKSPACE_ASSET_DRAG_TYPE, JSON.stringify(asset));
        event.dataTransfer.effectAllowed = "copy";
    }

    return (
        <aside className={styles.dock} aria-label={copy.title}>
            <header className={styles.header}>
                <div>
                    <span>ASSETS</span>
                    <h2>{copy.title}</h2>
                </div>
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                    {uploading ? copy.uploading : copy.upload}
                </button>
                <input
                    ref={fileInputRef}
                    className={styles.hiddenInput}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    onChange={handleUpload}
                />
            </header>

            <div className={styles.filters}>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.search} aria-label={copy.search} />
                <div className={styles.rootTabs}>
                    {(["all", "input", "output"] as const).map((option) => (
                        <button key={option} type="button" aria-pressed={root === option} onClick={() => setRoot(option)}>
                            {rootLabel(option, zh)}
                        </button>
                    ))}
                </div>
            </div>

            {error && <div className={styles.error} role="alert">{error}</div>}
            {loading && <div className={styles.state}>{copy.loading}</div>}

            {!loading && (
                <div className={styles.grid}>
                    {visibleAssets.map((asset) => {
                        const key = assetKey(asset);
                        const inProject = projectAssetKeys.has(key);
                        return (
                            <article key={key} className={styles.asset} draggable onDragStart={(event) => handleDragStart(event, asset)}>
                                <div className={styles.preview}>
                                    {asset.kind === "image"
                                        ? <img src={assetUrl(asset)} alt="" loading="lazy" />
                                        : <video src={assetUrl(asset)} preload="metadata" muted />}
                                    <span>{asset.kind === "image" ? "IMG" : "VID"}</span>
                                </div>
                                <div className={styles.assetInfo}>
                                    <strong title={asset.name}>{fileName(asset.name)}</strong>
                                    <small>{asset.root} · {formatSize(asset.size)}</small>
                                </div>
                                <button type="button" onClick={() => onAddAsset(asset)} disabled={inProject}>
                                    {inProject ? copy.added : copy.add}
                                </button>
                            </article>
                        );
                    })}
                    {!visibleAssets.length && <div className={styles.state}>{copy.empty}</div>}
                </div>
            )}

            <p className={styles.hint}>{copy.hint}</p>
        </aside>
    );
}

function mergeAssets(current: StudioAsset[], incoming: StudioAsset[]) {
    const byKey = new Map(current.map((asset) => [assetKey(asset), asset]));
    for (const asset of incoming) byKey.set(assetKey(asset), asset);
    return [...byKey.values()];
}

function fileName(name: string) {
    return name.split("/").filter(Boolean).at(-1) || name;
}

function formatSize(bytes: number) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function rootLabel(root: RootFilter, zh: boolean) {
    if (root === "all") return zh ? "全部" : "All";
    if (root === "input") return "Input";
    return "Output";
}

function assetDockCopy(zh: boolean) {
    return zh
        ? {
            title: "素材",
            upload: "上傳",
            uploading: "上傳中…",
            search: "搜尋素材",
            add: "加入 Canvas",
            added: "已加入",
            loading: "載入素材中…",
            empty: "沒有符合的素材。",
            hint: "可直接拖曳圖片或影片到 Canvas；專案只保存 Library 引用，不複製檔案。",
            loadError: "無法讀取 Library。",
            uploadError: "素材上傳失敗。",
        }
        : {
            title: "Assets",
            upload: "Upload",
            uploading: "Uploading…",
            search: "Search assets",
            add: "Add to Canvas",
            added: "Added",
            loading: "Loading assets…",
            empty: "No matching assets.",
            hint: "Drag images or videos directly onto the Canvas. Projects store Library references instead of copying files.",
            loadError: "Unable to load Library.",
            uploadError: "Asset upload failed.",
        };
}
