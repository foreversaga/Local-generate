"use client";

import { CAMERA_OPTION_VALUES, normalizeRef2VCameraPlan } from "../../lib/ref2v-camera-plan.mjs";
import styles from "./SinglePromptAssistant.module.css";

export type CameraShot = {
  id: string; startMs: number; pictureRefs: number[]; videoReference: boolean; pictureRole: string;
  size: string; angle: string; primaryMotion: string; secondaryMotion: string; amplitude: string;
  speed: string; transition: string; composition: string; purpose: string;
};
export type CameraPlan = {
  version: number; videoPolicy: string;
  global: { style: string; composition: string; transition: string; imperfections: string[]; avoidances: string[] };
  shots: CameraShot[];
};

type Props = {
  locale: string; duration: number; referenceCount: number; hasVideo: boolean;
  value: CameraPlan; onChange: (value: CameraPlan) => void;
};

const LABELS = {
  "zh-TW": {
    title: "鏡頭規劃", summary: "把構圖、景別與運鏡直接編入 Ref2VA 提示詞。", global: "全域設定", shots: "逐鏡頭",
    style: "拍攝風格", videoPolicy: "參考影片用法", defaultComposition: "預設構圖", defaultTransition: "預設轉場",
    imperfectionsLabel: "真實鏡頭特徵", avoidancesLabel: "避免的鏡頭問題", addShot: "新增鏡頭", shot: "鏡頭", starts: "開始時間（秒）",
    references: "使用的參考素材", pictureRole: "圖片參考用途", size: "景別", angle: "視角", composition: "構圖",
    primaryMotion: "主要運鏡", secondaryMotion: "疊加運鏡", amplitude: "運鏡幅度", speed: "運鏡速度", transition: "進場轉場",
    purpose: "鏡頭意圖（選填）", purposePlaceholder: "例如：先交代環境，再把注意力帶到人物表情。", useVideo: "套用參考影片策略",
    remove: "刪除", moveEarlier: "往前移", moveLater: "往後移", noPictures: "加入參考圖片後可指定每個鏡頭使用的圖片。",
    styles: { auto: "自動", smartphone: "手機實拍", documentary: "紀錄片", real_camera: "電影實拍" },
    videoPolicies: { none: "不採用", weak_camera: "弱參考運鏡與節奏", preserve_camera_cuts: "保留運鏡與剪接", camera_only: "只參考運鏡", pacing_only: "只參考節奏" },
    compositions: { auto: "自動", centered: "置中構圖", thirds: "三分構圖", symmetrical: "對稱構圖", leading_lines: "引導線構圖", negative_space: "留白構圖", imperfect: "自然不完美構圖" },
    transitions: { cut: "直接切換", cross_dissolve: "交叉溶接", fade: "淡入淡出", wipe: "擦除轉場" },
    sizes: { auto: "自動", extreme_close_up: "大特寫", close_up: "特寫", medium_close_up: "近景", medium: "中景", medium_wide: "中全景", wide: "全景", extreme_wide: "大遠景" },
    angles: { auto: "自動", eye_level: "平視", high_angle: "俯視", low_angle: "仰視", overhead: "正上方俯拍", bird_eye: "鳥瞰", worm_eye: "貼地仰拍", dutch: "傾斜視角", over_shoulder: "越肩視角", pov: "主觀視角" },
    motions: { auto: "自動", static: "固定鏡頭", zoom_in: "拉近焦距", zoom_out: "拉遠焦距", push_in: "推近", pull_out: "拉遠", pan_left: "向左搖攝", pan_right: "向右搖攝", truck_left: "向左橫移", truck_right: "向右橫移", tilt_up: "向上搖攝", tilt_down: "向下搖攝", pedestal_up: "升高鏡位", pedestal_down: "降低鏡位", arc: "環繞運鏡", tracking: "跟隨拍攝", handheld_follow: "手持跟拍", shake_slightly: "輕微晃動", shake_strongly: "強烈晃動", roll_clockwise: "順時針旋轉", roll_counterclockwise: "逆時針旋轉", none: "無" },
    amplitudes: { small: "小", normal: "中", large: "大" }, speeds: { slow: "慢", normal: "正常", fast: "快" },
    pictureRoles: { appearance: "人物外觀與身分", scene: "場景與環境", style: "視覺風格", first_frame: "起始畫面", keyframe: "關鍵畫面", last_frame: "結尾畫面", storyboard: "分鏡與動作順序", composition: "構圖與取景" },
    imperfections: { handheld_micro_shake: "手持微晃", motion_blur: "自然動態模糊", film_grain: "底片顆粒", autofocus_breathing: "對焦呼吸", exposure_shift: "曝光微調", rolling_shutter: "輕微果凍效應" },
    avoidances: { excessive_shake: "過度晃動", warped_perspective: "透視變形", random_zoom: "無目的變焦", camera_jitter: "數位抖動", broken_continuity: "鏡頭連貫中斷", unnatural_blur: "不自然模糊" },
  },
  en: {
    title: "Camera planning", summary: "Compile composition, framing, and camera movement into the Ref2VA prompt.", global: "Global", shots: "Shots",
    style: "Capture style", videoPolicy: "Reference video use", defaultComposition: "Default composition", defaultTransition: "Default transition",
    imperfectionsLabel: "Real-camera traits", avoidancesLabel: "Camera issues to avoid", addShot: "Add shot", shot: "Shot", starts: "Start time (seconds)",
    references: "Reference media", pictureRole: "Picture reference role", size: "Shot size", angle: "Camera angle", composition: "Composition",
    primaryMotion: "Primary movement", secondaryMotion: "Combined movement", amplitude: "Movement amplitude", speed: "Movement speed", transition: "Incoming transition",
    purpose: "Shot intent (optional)", purposePlaceholder: "For example: establish the environment, then guide attention to the expression.", useVideo: "Apply reference-video policy",
    remove: "Delete", moveEarlier: "Move earlier", moveLater: "Move later", noPictures: "Add reference pictures to assign them to individual shots.",
    styles: { auto: "Auto", smartphone: "Smartphone", documentary: "Documentary", real_camera: "Cinematic live action" },
    videoPolicies: { none: "Do not use", weak_camera: "Weak camera and pacing reference", preserve_camera_cuts: "Preserve camera and cuts", camera_only: "Camera movement only", pacing_only: "Pacing only" },
    compositions: { auto: "Auto", centered: "Centered", thirds: "Rule of thirds", symmetrical: "Symmetrical", leading_lines: "Leading lines", negative_space: "Negative space", imperfect: "Naturally imperfect" },
    transitions: { cut: "Cut", cross_dissolve: "Cross dissolve", fade: "Fade", wipe: "Wipe" },
    sizes: { auto: "Auto", extreme_close_up: "Extreme close-up", close_up: "Close-up", medium_close_up: "Medium close-up", medium: "Medium shot", medium_wide: "Medium-wide shot", wide: "Wide shot", extreme_wide: "Extreme-wide shot" },
    angles: { auto: "Auto", eye_level: "Eye level", high_angle: "High angle", low_angle: "Low angle", overhead: "Overhead", bird_eye: "Bird's-eye", worm_eye: "Worm's-eye", dutch: "Dutch angle", over_shoulder: "Over the shoulder", pov: "Point of view" },
    motions: { auto: "Auto", static: "Static", zoom_in: "Zoom in", zoom_out: "Zoom out", push_in: "Push in", pull_out: "Pull out", pan_left: "Pan left", pan_right: "Pan right", truck_left: "Truck left", truck_right: "Truck right", tilt_up: "Tilt up", tilt_down: "Tilt down", pedestal_up: "Pedestal up", pedestal_down: "Pedestal down", arc: "Arc", tracking: "Tracking", handheld_follow: "Handheld follow", shake_slightly: "Slight shake", shake_strongly: "Strong shake", roll_clockwise: "Roll clockwise", roll_counterclockwise: "Roll counterclockwise", none: "None" },
    amplitudes: { small: "Small", normal: "Medium", large: "Large" }, speeds: { slow: "Slow", normal: "Normal", fast: "Fast" },
    pictureRoles: { appearance: "Subject appearance and identity", scene: "Scene and environment", style: "Visual style", first_frame: "Opening frame", keyframe: "Keyframe", last_frame: "Ending frame", storyboard: "Storyboard and action order", composition: "Composition and framing" },
    imperfections: { handheld_micro_shake: "Handheld micro-shake", motion_blur: "Natural motion blur", film_grain: "Film grain", autofocus_breathing: "Autofocus breathing", exposure_shift: "Exposure adjustment", rolling_shutter: "Mild rolling shutter" },
    avoidances: { excessive_shake: "Excessive shake", warped_perspective: "Warped perspective", random_zoom: "Unmotivated zoom", camera_jitter: "Digital jitter", broken_continuity: "Broken continuity", unnatural_blur: "Unnatural blur" },
  },
} as const;

export function Ref2VCameraPlanner({ locale, duration, referenceCount, hasVideo, value, onChange }: Props) {
  const copy = locale === "en" ? LABELS.en : LABELS["zh-TW"];
  const plan = normalizeRef2VCameraPlan(value, { duration, referenceCount, hasVideo }) as CameraPlan;
  const update = (next: CameraPlan) => onChange(normalizeRef2VCameraPlan(next, { duration, referenceCount, hasVideo }) as CameraPlan);
  const updateGlobal = (key: string, nextValue: string | string[]) => update({ ...plan, global: { ...plan.global, [key]: nextValue } });
  const updateShot = (index: number, patch: Partial<CameraShot>) => update({ ...plan, shots: plan.shots.map((shot, shotIndex) => shotIndex === index ? { ...shot, ...patch } : shot) });
  const toggleGlobal = (key: "imperfections" | "avoidances", item: string) => {
    const current = plan.global[key];
    updateGlobal(key, current.includes(item) ? current.filter((value) => value !== item) : [...current, item]);
  };
  const addShot = () => {
    if (plan.shots.length >= 9) return;
    const startMs = Math.min(Math.round(duration * 1000) - 1, Math.max(1, Math.round(duration * 1000 * plan.shots.length / (plan.shots.length + 1))));
    update({ ...plan, shots: [...plan.shots, { ...plan.shots.at(-1)!, id: `shot-${plan.shots.length + 1}-${startMs}`, startMs, pictureRefs: [], purpose: "" }] });
  };
  const moveShot = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (index === 0 || target < 1 || target >= plan.shots.length) return;
    const shots = [...plan.shots]; [shots[index], shots[target]] = [shots[target], shots[index]];
    const times = shots.map((shot) => shot.startMs).sort((a, b) => a - b);
    update({ ...plan, shots: shots.map((shot, i) => ({ ...shot, startMs: times[i] })) });
  };

  return <details className={styles.cameraPlanner} open>
    <summary><span><strong>{copy.title}</strong><small>{copy.summary}</small></span><span className={styles.cameraCount}>{plan.shots.length}</span></summary>
    <div className={styles.cameraContent}>
      <section className={styles.cameraGroup} aria-labelledby="camera-global-title">
        <h4 id="camera-global-title">{copy.global}</h4>
        <div className={styles.cameraGrid}>
          <SelectField label={copy.style} value={plan.global.style} values={CAMERA_OPTION_VALUES.styles} labels={copy.styles} onChange={(next) => updateGlobal("style", next)} />
          <SelectField label={copy.defaultComposition} value={plan.global.composition} values={CAMERA_OPTION_VALUES.compositions} labels={copy.compositions} onChange={(next) => updateGlobal("composition", next)} />
          <SelectField label={copy.defaultTransition} value={plan.global.transition} values={CAMERA_OPTION_VALUES.transitions} labels={copy.transitions} onChange={(next) => updateGlobal("transition", next)} />
          {hasVideo && <SelectField label={copy.videoPolicy} value={plan.videoPolicy} values={CAMERA_OPTION_VALUES.videoPolicies} labels={copy.videoPolicies} onChange={(next) => update({ ...plan, videoPolicy: next })} />}
        </div>
        <CheckGroup label={copy.imperfectionsLabel} values={CAMERA_OPTION_VALUES.imperfections} selected={plan.global.imperfections} labels={copy.imperfections} onToggle={(item) => toggleGlobal("imperfections", item)} />
        <CheckGroup label={copy.avoidancesLabel} values={CAMERA_OPTION_VALUES.avoidances} selected={plan.global.avoidances} labels={copy.avoidances} onToggle={(item) => toggleGlobal("avoidances", item)} />
      </section>

      <section className={styles.cameraGroup} aria-labelledby="camera-shots-title">
        <div className={styles.cameraGroupHeader}><h4 id="camera-shots-title">{copy.shots}</h4><button type="button" className={styles.cameraAction} onClick={addShot} disabled={plan.shots.length >= 9}>＋ {copy.addShot}</button></div>
        <div className={styles.shotList}>
          {plan.shots.map((shot, index) => <article className={styles.shotCard} key={shot.id}>
            <header className={styles.shotHeader}>
              <strong>{copy.shot} {index + 1}</strong>
              <div className={styles.shotActions}>
                <button type="button" title={copy.moveEarlier} aria-label={`${copy.moveEarlier} ${copy.shot} ${index + 1}`} disabled={index <= 1} onClick={() => moveShot(index, -1)}>↑</button>
                <button type="button" title={copy.moveLater} aria-label={`${copy.moveLater} ${copy.shot} ${index + 1}`} disabled={index === 0 || index >= plan.shots.length - 1} onClick={() => moveShot(index, 1)}>↓</button>
                <button type="button" aria-label={`${copy.remove} ${copy.shot} ${index + 1}`} disabled={plan.shots.length === 1} onClick={() => update({ ...plan, shots: plan.shots.filter((_, i) => i !== index) })}>{copy.remove}</button>
              </div>
            </header>
            <div className={styles.cameraGrid}>
              <label className={styles.cameraField}><span>{copy.starts}</span><input type="number" min={0} max={Math.max(0, duration - .001)} step="0.001" disabled={index === 0} value={(shot.startMs / 1000).toFixed(3)} onChange={(event) => updateShot(index, { startMs: Math.round(Number(event.target.value) * 1000) })} /></label>
              <SelectField label={copy.pictureRole} value={shot.pictureRole} values={CAMERA_OPTION_VALUES.pictureRoles} labels={copy.pictureRoles} onChange={(next) => updateShot(index, { pictureRole: next })} />
              <SelectField label={copy.size} value={shot.size} values={CAMERA_OPTION_VALUES.sizes} labels={copy.sizes} onChange={(next) => updateShot(index, { size: next })} />
              <SelectField label={copy.angle} value={shot.angle} values={CAMERA_OPTION_VALUES.angles} labels={copy.angles} onChange={(next) => updateShot(index, { angle: next })} />
              <SelectField label={copy.composition} value={shot.composition} values={CAMERA_OPTION_VALUES.compositions} labels={copy.compositions} onChange={(next) => updateShot(index, { composition: next })} />
              <SelectField label={copy.primaryMotion} value={shot.primaryMotion} values={CAMERA_OPTION_VALUES.motions} labels={copy.motions} onChange={(next) => updateShot(index, { primaryMotion: next })} />
              <SelectField label={copy.secondaryMotion} value={shot.secondaryMotion} values={CAMERA_OPTION_VALUES.secondaryMotions} labels={copy.motions} onChange={(next) => updateShot(index, { secondaryMotion: next })} />
              <SelectField label={copy.amplitude} value={shot.amplitude} values={CAMERA_OPTION_VALUES.amplitudes} labels={copy.amplitudes} onChange={(next) => updateShot(index, { amplitude: next })} />
              <SelectField label={copy.speed} value={shot.speed} values={CAMERA_OPTION_VALUES.speeds} labels={copy.speeds} onChange={(next) => updateShot(index, { speed: next })} />
              <SelectField label={copy.transition} value={shot.transition} values={CAMERA_OPTION_VALUES.transitions} labels={copy.transitions} onChange={(next) => updateShot(index, { transition: next })} />
            </div>
            <fieldset className={styles.referenceChoices}><legend>{copy.references}</legend>
              {referenceCount ? Array.from({ length: referenceCount }, (_, refIndex) => <label key={refIndex}><input type="checkbox" checked={shot.pictureRefs.includes(refIndex + 1)} onChange={() => updateShot(index, { pictureRefs: shot.pictureRefs.includes(refIndex + 1) ? shot.pictureRefs.filter((ref) => ref !== refIndex + 1) : [...shot.pictureRefs, refIndex + 1] })} /><span>{locale === "en" ? "Picture" : "參考圖片"} {refIndex + 1}</span></label>) : <small>{copy.noPictures}</small>}
              {hasVideo && <label><input type="checkbox" checked={shot.videoReference} onChange={(event) => updateShot(index, { videoReference: event.target.checked })} /><span>{copy.useVideo}</span></label>}
            </fieldset>
            <label className={styles.cameraField}><span>{copy.purpose}</span><textarea value={shot.purpose} maxLength={300} placeholder={copy.purposePlaceholder} onChange={(event) => updateShot(index, { purpose: event.target.value })} /></label>
          </article>)}
        </div>
      </section>
    </div>
  </details>;
}

function SelectField({ label, value, values, labels, onChange }: { label: string; value: string; values: readonly string[]; labels: Record<string, string>; onChange: (value: string) => void }) {
  return <label className={styles.cameraField}><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{values.map((option) => <option key={option} value={option}>{labels[option]}</option>)}</select></label>;
}

function CheckGroup({ label, values, selected, labels, onToggle }: { label: string; values: readonly string[]; selected: string[]; labels: Record<string, string>; onToggle: (value: string) => void }) {
  return <fieldset className={styles.checkGroup}><legend>{label}</legend><div>{values.map((item) => <label key={item}><input type="checkbox" checked={selected.includes(item)} onChange={() => onToggle(item)} /><span>{labels[item]}</span></label>)}</div></fieldset>;
}
