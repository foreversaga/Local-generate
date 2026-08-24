"use client";

import { ChangeEvent } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
    SEEDVR2_BLENDING_METHODS,
    SEEDVR2_DETAIL_PRESETS,
    SEEDVR2_TILING_STRATEGIES,
    type SeedVR2BlendingMethod,
    type SeedVR2DetailPreset,
    type SeedVR2TilingStrategy,
} from "./upscale-client";
import { getSeedVR2Help } from "./seedvr2-help";
import { isSeedVR2DetailDraftDefault, type SeedVR2DetailDraft } from "./seedvr2-detail";
import styles from "./UpscaleWorkspace.module.css";

type Props = {
    locale: "zh-TW" | "en";
    value: SeedVR2DetailDraft;
    disabled: boolean;
    onChange: (value: SeedVR2DetailDraft) => void;
    onPresetChange: (preset: SeedVR2DetailPreset) => void;
    onReset: () => void;
};

export function SeedVR2DetailControls({ locale, value, disabled, onChange, onPresetChange, onReset }: Props) {
    const { t } = useI18n();
    const help = getSeedVR2Help(locale).detail;
    const isDefault = isSeedVR2DetailDraftDefault(value);
    const summary = isDefault
        ? t("upscale.seedvr2.detail.summaryDefault")
        : value.detailPreset === "skin_detail"
            ? t("upscale.seedvr2.detail.summarySkin")
            : t("upscale.seedvr2.detail.summaryCustom");

    function update<Key extends keyof SeedVR2DetailDraft>(key: Key, nextValue: SeedVR2DetailDraft[Key]) {
        onChange({ ...value, [key]: nextValue });
    }

    function updateText(key: keyof SeedVR2DetailDraft) {
        return (event: ChangeEvent<HTMLInputElement>) => update(key, event.target.value as never);
    }

    return (
        <details className={styles.advancedSampling}>
            <summary>
                <span>{t("upscale.seedvr2.detail.title")}</span>
                <small>{summary}</small>
            </summary>
            <div className={styles.advancedSamplingBody}>
                <div className={styles.parameterGrid}>
                    <label className={styles.profileField}>
                        <span>{t("upscale.seedvr2.detail.preset")}</span>
                        <select
                            value={value.detailPreset}
                            onChange={(event) => onPresetChange(event.target.value as SeedVR2DetailPreset)}
                            disabled={disabled}
                        >
                            {SEEDVR2_DETAIL_PRESETS.map((item) => (
                                <option key={item.id} value={item.id}>{t(item.id === "skin_detail" ? "upscale.seedvr2.detail.preset.skin" : "upscale.seedvr2.detail.preset.default")}</option>
                            ))}
                        </select>
                        <small className={styles.fieldHelp} aria-live="polite">{help.presetHelp[value.detailPreset]}</small>
                    </label>
                    <label className={styles.profileField}>
                        <span>Input Noise Scale</span>
                        <input type="number" min="0" max="0.2" step="0.005" value={value.inputNoiseScale} onChange={updateText("inputNoiseScale")} disabled={disabled} />
                        <small className={styles.fieldHelp}>{help.inputNoiseScale}</small>
                    </label>
                    <label className={styles.profileField}>
                        <span>Latent Noise Scale</span>
                        <input type="number" min="0" max="0.2" step="0.001" value={value.latentNoiseScale} onChange={updateText("latentNoiseScale")} disabled={disabled} />
                        <small className={styles.fieldHelp}>{help.latentNoiseScale}</small>
                    </label>
                    <label className={styles.profileField}>
                        <span>Tile Width</span>
                        <input type="number" min="256" max="2048" step="64" value={value.tileWidth} onChange={updateText("tileWidth")} disabled={disabled} />
                        <small className={styles.fieldHelp}>{help.tileWidth}</small>
                    </label>
                    <label className={styles.profileField}>
                        <span>Tile Height</span>
                        <input type="number" min="256" max="2048" step="64" value={value.tileHeight} onChange={updateText("tileHeight")} disabled={disabled} />
                        <small className={styles.fieldHelp}>{help.tileHeight}</small>
                    </label>
                    <label className={styles.profileField}>
                        <span>Tile Padding</span>
                        <input type="number" min="0" max="256" step="1" value={value.tilePadding} onChange={updateText("tilePadding")} disabled={disabled} />
                        <small className={styles.fieldHelp}>{help.tilePadding}</small>
                    </label>
                    <label className={styles.profileField}>
                        <span>Tile Upscale Resolution</span>
                        <input type="number" min="512" max="4096" step="64" value={value.tileUpscaleResolution} onChange={updateText("tileUpscaleResolution")} disabled={disabled} />
                        <small className={styles.fieldHelp}>{help.tileUpscaleResolution}</small>
                    </label>
                    <label className={styles.profileField}>
                        <span>Blending Method</span>
                        <select value={value.blendingMethod} onChange={(event) => update("blendingMethod", event.target.value as SeedVR2BlendingMethod)} disabled={disabled}>
                            {SEEDVR2_BLENDING_METHODS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                        </select>
                        <small className={styles.fieldHelp} aria-live="polite">{help.blendingMethod[value.blendingMethod]}</small>
                    </label>
                    <label className={styles.profileField}>
                        <span>Anti-aliasing Strength</span>
                        <input type="number" min="0" max="1" step="0.05" value={value.antiAliasingStrength} onChange={updateText("antiAliasingStrength")} disabled={disabled} />
                        <small className={styles.fieldHelp}>{help.antiAliasingStrength}</small>
                    </label>
                    <label className={styles.profileField}>
                        <span>Mask Blur</span>
                        <input type="number" min="0" max="64" step="1" value={value.maskBlur} onChange={updateText("maskBlur")} disabled={disabled} />
                        <small className={styles.fieldHelp}>{help.maskBlur}</small>
                    </label>
                    <label className={styles.profileField}>
                        <span>Tiling Strategy</span>
                        <select value={value.tilingStrategy} onChange={(event) => update("tilingStrategy", event.target.value as SeedVR2TilingStrategy)} disabled={disabled}>
                            {SEEDVR2_TILING_STRATEGIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                        </select>
                        <small className={styles.fieldHelp} aria-live="polite">{help.tilingStrategy[value.tilingStrategy]}</small>
                    </label>
                </div>
                <div className={styles.advancedSamplingFooter}>
                    <button type="button" className={styles.textButton} onClick={onReset} disabled={disabled}>{t("upscale.seedvr2.detail.reset")}</button>
                    {!isDefault && <p className={styles.samplingWarning} role="status">{t("upscale.seedvr2.detail.warning")}</p>}
                </div>
            </div>
        </details>
    );
}
