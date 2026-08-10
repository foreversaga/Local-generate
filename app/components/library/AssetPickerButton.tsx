"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { assetKey, assetUrl, fetchAssets, type StudioAsset } from "./asset-client";
import styles from "./AssetPickerButton.module.css";

type Props = {
    kind?: "image" | "video";
    root?: "input" | "output";
    multiple?: boolean;
    max?: number;
    selectedKeys?: string[];
    label?: string;
    onSelect: (assets: StudioAsset[]) => void;
};

export function AssetPickerButton({
    kind,
    root,
    multiple = false,
    max = 1,
    selectedKeys = [],
    label = "Browse Library",
    onSelect,
}: Props) {
    const [open, setOpen] = useState(false);
    const [assets, setAssets] = useState<StudioAsset[]>([]);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set(selectedKeys));
    const [preview, setPreview] = useState<StudioAsset | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const triggerRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const selectedKeysSignature = JSON.stringify(selectedKeys);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setSelected(new Set(JSON.parse(selectedKeysSignature) as string[]));
        }, 0);
        return () => window.clearTimeout(timer);
    }, [selectedKeysSignature]);

    useEffect(() => {
        if (!open) return;

        void fetchAssets()
            .then((next) => { setAssets(next); setError(""); })
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
    }, [open]);

    const visibleAssets = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return assets
            .filter((asset) => (!root || asset.root === root) && (!kind || asset.kind === kind) && (!needle || asset.name.toLowerCase().includes(needle)))
            .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    }, [assets, kind, query, root]);

    function openDialog() {
        setLoading(true);
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

    function confirm() {
        const limit = multiple ? max : 1;
        const chosen = assets.filter((asset) => selected.has(assetKey(asset))).slice(0, limit);
        onSelect(chosen);
        closeDialog();
    }

    return (
        <>
            <button ref={triggerRef} type="button" className={styles.trigger} aria-haspopup="dialog" aria-expanded={open} onClick={openDialog}>
                {label}
            </button>
            {open && (
                <div className={styles.backdrop} role="presentation" onClick={(event) => event.target === event.currentTarget && closeDialog()}>
                    <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label="Asset picker">
                        <header>
                            <div>
                                <span>Asset Picker</span>
                                <strong>{multiple ? `Select up to ${max}` : "Select one asset"}</strong>
                            </div>
                            <button type="button" onClick={closeDialog} aria-label="Close asset picker">×</button>
                        </header>

                        <label className={styles.search}>
                            <span className="sr-only">Search assets</span>
                            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search recent assets…" />
                        </label>

                        <div className={styles.body}>
                            <div className={styles.grid}>
                                {loading && <p>Loading…</p>}
                                {error && <p className={styles.error} role="alert">{error}</p>}
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
                            <span>{selected.size} selected</span>
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
