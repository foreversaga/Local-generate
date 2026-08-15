const MAX_SHOTS = 9;

export const CAMERA_OPTION_VALUES = {
  styles: ["auto", "smartphone", "documentary", "real_camera"],
  videoPolicies: ["none", "weak_camera", "preserve_camera_cuts", "camera_only", "pacing_only"],
  compositions: ["auto", "centered", "thirds", "symmetrical", "leading_lines", "negative_space", "imperfect"],
  transitions: ["cut", "cross_dissolve", "fade", "wipe"],
  sizes: ["auto", "extreme_close_up", "close_up", "medium_close_up", "medium", "medium_wide", "wide", "extreme_wide"],
  angles: ["auto", "eye_level", "high_angle", "low_angle", "overhead", "bird_eye", "worm_eye", "dutch", "over_shoulder", "pov"],
  motions: ["auto", "static", "zoom_in", "zoom_out", "push_in", "pull_out", "pan_left", "pan_right", "truck_left", "truck_right", "tilt_up", "tilt_down", "pedestal_up", "pedestal_down", "arc", "tracking", "handheld_follow", "shake_slightly", "shake_strongly", "roll_clockwise", "roll_counterclockwise"],
  secondaryMotions: ["none", "pan_left", "pan_right", "tilt_up", "tilt_down", "arc", "tracking", "shake_slightly", "roll_clockwise", "roll_counterclockwise"],
  amplitudes: ["small", "normal", "large"],
  speeds: ["slow", "normal", "fast"],
  pictureRoles: ["appearance", "scene", "style", "first_frame", "keyframe", "last_frame", "storyboard", "composition"],
  imperfections: ["handheld_micro_shake", "motion_blur", "film_grain", "autofocus_breathing", "exposure_shift", "rolling_shutter"],
  avoidances: ["excessive_shake", "warped_perspective", "random_zoom", "camera_jitter", "broken_continuity", "unnatural_blur"],
};

const EN = {
  styles: { auto: "natural real-camera cinematography", smartphone: "casual smartphone footage", documentary: "observational documentary cinematography", real_camera: "polished live-action real-camera cinematography" },
  videoPolicies: { none: "do not derive camera behavior from <Video 1>", weak_camera: "use <Video 1> only as a weak camera and pacing reference", preserve_camera_cuts: "preserve the camera path and cut structure of <Video 1>", camera_only: "reuse only the camera movement from <Video 1>", pacing_only: "reuse only the pacing and temporal rhythm from <Video 1>" },
  compositions: { auto: "natural composition", centered: "centered composition", thirds: "rule-of-thirds composition", symmetrical: "symmetrical composition", leading_lines: "leading-line composition", negative_space: "negative-space composition", imperfect: "deliberately imperfect real-camera framing" },
  transitions: { cut: "a direct cut", cross_dissolve: "a cross dissolve", fade: "a fade transition", wipe: "a wipe transition" },
  sizes: { auto: "a naturally chosen shot size", extreme_close_up: "an extreme close-up", close_up: "a close-up", medium_close_up: "a medium close-up", medium: "a medium shot", medium_wide: "a medium-wide shot", wide: "a wide shot", extreme_wide: "an extreme-wide shot" },
  angles: { auto: "a natural camera angle", eye_level: "an eye-level angle", high_angle: "a high angle", low_angle: "a low angle", overhead: "an overhead angle", bird_eye: "a bird's-eye view", worm_eye: "a worm's-eye view", dutch: "a Dutch angle", over_shoulder: "an over-the-shoulder angle", pov: "a point-of-view angle" },
  motions: { auto: "natural camera movement", static: "a locked-off static camera", zoom_in: "a lens zoom in", zoom_out: "a lens zoom out", push_in: "a physical camera push-in", pull_out: "a physical camera pull-out", pan_left: "a pan left", pan_right: "a pan right", truck_left: "a lateral truck left", truck_right: "a lateral truck right", tilt_up: "a tilt up", tilt_down: "a tilt down", pedestal_up: "a pedestal rise", pedestal_down: "a pedestal drop", arc: "an arcing camera move", tracking: "a tracking move", handheld_follow: "a handheld follow shot", shake_slightly: "subtle camera shake", shake_strongly: "strong camera shake", roll_clockwise: "a clockwise camera roll", roll_counterclockwise: "a counterclockwise camera roll", none: "no secondary camera movement" },
  amplitudes: { small: "with restrained amplitude", normal: "with moderate amplitude", large: "with pronounced amplitude" },
  speeds: { slow: "at a slow pace", normal: "at a natural pace", fast: "at a fast pace" },
  pictureRoles: { appearance: "subject appearance and identity", scene: "scene and environment", style: "visual style", first_frame: "opening-frame composition", keyframe: "keyframe content", last_frame: "ending-frame composition", storyboard: "storyboard and action order", composition: "composition and framing" },
  imperfections: { handheld_micro_shake: "subtle handheld micro-shake", motion_blur: "natural motion blur", film_grain: "fine film grain", autofocus_breathing: "subtle autofocus breathing", exposure_shift: "minor automatic-exposure adjustment", rolling_shutter: "mild rolling-shutter character" },
  avoidances: { excessive_shake: "excessive camera shake", warped_perspective: "warped perspective", random_zoom: "unmotivated random zooms", camera_jitter: "digital camera jitter", broken_continuity: "broken shot continuity", unnatural_blur: "unnatural motion blur" },
};

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function uniqueAllowed(value, allowed) {
  return [...new Set(Array.isArray(value) ? value : [])].filter((item) => allowed.includes(item));
}

export function createDefaultRef2VCameraPlan({ referenceCount = 0, hasVideo = false } = {}) {
  return {
    version: 1,
    videoPolicy: hasVideo ? "weak_camera" : "none",
    global: { style: "auto", composition: "auto", transition: "cut", imperfections: [], avoidances: ["camera_jitter", "broken_continuity"] },
    shots: [{ id: "shot-1", startMs: 0, pictureRefs: referenceCount ? [1] : [], videoReference: hasVideo, pictureRole: "appearance", size: "auto", angle: "auto", primaryMotion: "auto", secondaryMotion: "none", amplitude: "normal", speed: "normal", transition: "cut", composition: "auto", purpose: "" }],
  };
}

export function normalizeRef2VCameraPlan(value, { duration = 5, referenceCount = 0, hasVideo = false } = {}) {
  const source = value && typeof value === "object" ? value : createDefaultRef2VCameraPlan({ referenceCount, hasVideo });
  const durationMs = Math.max(100, Math.round(Number(duration || 5) * 1000));
  const rawShots = Array.isArray(source.shots) && source.shots.length ? source.shots.slice(0, MAX_SHOTS) : [{}];
  let previous = -1;
  const shots = rawShots.map((raw, index) => {
    const requested = index === 0 ? 0 : Math.round(Number(raw?.startMs));
    const fallback = Math.round(durationMs * index / rawShots.length);
    const startMs = index === 0 ? 0 : Math.min(durationMs - 1, Math.max(previous + 1, Number.isFinite(requested) ? requested : fallback));
    previous = startMs;
    return {
      id: typeof raw?.id === "string" && raw.id ? raw.id : `shot-${index + 1}`,
      startMs,
      pictureRefs: [...new Set(Array.isArray(raw?.pictureRefs) ? raw.pictureRefs.map(Number) : [])].filter((ref) => Number.isInteger(ref) && ref >= 1 && ref <= Math.min(9, referenceCount)),
      videoReference: Boolean(hasVideo && raw?.videoReference),
      pictureRole: pick(raw?.pictureRole, CAMERA_OPTION_VALUES.pictureRoles, "appearance"),
      size: pick(raw?.size, CAMERA_OPTION_VALUES.sizes, "auto"),
      angle: pick(raw?.angle, CAMERA_OPTION_VALUES.angles, "auto"),
      primaryMotion: pick(raw?.primaryMotion, CAMERA_OPTION_VALUES.motions, "auto"),
      secondaryMotion: pick(raw?.secondaryMotion, CAMERA_OPTION_VALUES.secondaryMotions, "none"),
      amplitude: pick(raw?.amplitude, CAMERA_OPTION_VALUES.amplitudes, "normal"),
      speed: pick(raw?.speed, CAMERA_OPTION_VALUES.speeds, "normal"),
      transition: pick(raw?.transition, CAMERA_OPTION_VALUES.transitions, "cut"),
      composition: pick(raw?.composition, CAMERA_OPTION_VALUES.compositions, "auto"),
      purpose: String(raw?.purpose || "").trim().slice(0, 300),
    };
  });
  return {
    version: 1,
    videoPolicy: hasVideo ? pick(source.videoPolicy, CAMERA_OPTION_VALUES.videoPolicies, "weak_camera") : "none",
    global: {
      style: pick(source.global?.style, CAMERA_OPTION_VALUES.styles, "auto"),
      composition: pick(source.global?.composition, CAMERA_OPTION_VALUES.compositions, "auto"),
      transition: pick(source.global?.transition, CAMERA_OPTION_VALUES.transitions, "cut"),
      imperfections: uniqueAllowed(source.global?.imperfections, CAMERA_OPTION_VALUES.imperfections),
      avoidances: uniqueAllowed(source.global?.avoidances, CAMERA_OPTION_VALUES.avoidances),
    },
    shots,
  };
}

export function buildRef2VCameraPlanContext(value, options = {}) {
  const plan = normalizeRef2VCameraPlan(value, options);
  const lines = [
    "User-selected Ref2VA camera plan. Integrate these choices as natural English prose inside the exact six-field Ref2VA JSON, especially subject_definitions, summary, retention_analysis, and detailed_description where relevant. Do not output detached camera tags or UI labels.",
    `Global visual capture style: ${EN.styles[plan.global.style]}. Default composition: ${EN.compositions[plan.global.composition]}. Default transition: ${EN.transitions[plan.global.transition]}.`,
  ];
  if (options.hasVideo) lines.push(`Reference-video policy: ${EN.videoPolicies[plan.videoPolicy]}.`);
  if (plan.global.imperfections.length) lines.push(`Real-camera characteristics: ${plan.global.imperfections.map((item) => EN.imperfections[item]).join(", ")}.`);
  for (const [index, shot] of plan.shots.entries()) {
    const refs = shot.pictureRefs.length ? ` Use ${shot.pictureRefs.map((ref) => `<Picture ${ref}>`).join(" and ")} for ${EN.pictureRoles[shot.pictureRole]}.` : "";
    const video = shot.videoReference && options.hasVideo ? " Apply the allowed <Video 1> reference policy to this shot." : "";
    const secondary = shot.secondaryMotion === "none" ? "" : ` combined with ${EN.motions[shot.secondaryMotion]}`;
    const purpose = shot.purpose ? ` Creative purpose: ${shot.purpose}.` : "";
    lines.push(`Shot ${index + 1} begins at ${(shot.startMs / 1000).toFixed(3)} seconds: ${EN.sizes[shot.size]}, ${EN.angles[shot.angle]}, ${EN.compositions[shot.composition]}; ${EN.motions[shot.primaryMotion]}${secondary}, ${EN.amplitudes[shot.amplitude]} ${EN.speeds[shot.speed]}; enter with ${EN.transitions[shot.transition]}.${refs}${video}${purpose}`);
  }
  if (plan.global.avoidances.length) lines.push(`Camera-specific negative constraints: ${plan.global.avoidances.map((item) => EN.avoidances[item]).join(", ")}.`);
  return { plan, context: lines.join("\n"), negativeTerms: plan.global.avoidances.map((item) => EN.avoidances[item]) };
}

export function mergeNegativePromptTerms(prompt, terms = []) {
  const parts = String(prompt || "").split(",").map((item) => item.trim()).filter(Boolean);
  const seen = new Set(parts.map((item) => item.toLowerCase()));
  for (const term of terms) if (!seen.has(String(term).toLowerCase())) { parts.push(String(term)); seen.add(String(term).toLowerCase()); }
  return parts.join(", ");
}
