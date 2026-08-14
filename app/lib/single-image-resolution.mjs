const MIN_DIMENSION = 32;
const MAX_DIMENSION = 2048;
const H3_GRID = 32;
const ANIMATE_GRID = 16;
const MIN_SCALE_PERCENT = 10;
const MAX_SCALE_PERCENT = 100;

/**
 * @typedef {{ width: number; height: number }} ImageDimensions
 */

/**
 * @typedef {ImageDimensions & {
 *   originalWidth: number;
 *   originalHeight: number;
 *   grid: number;
 *   scalePercent: number;
 *   scaled: boolean;
 *   adjusted: boolean;
 * }} NormalizedImageResolution
 */

/**
 * The H3 nodes accept a 32px canvas grid. Wan2.2 Animate accepts a 16px grid.
 * Keep this mapping next to the UI normalizer so the displayed dimensions and
 * the values sent to the legacy generate endpoint share one contract.
 *
 * @param {string} mode
 */
export function resolutionGridForMode(mode) {
  return mode === "replace" ? ANIMATE_GRID : H3_GRID;
}

/**
 * Parse a ratio written as `width:height`. Returning null keeps the Custom
 * retry-editor option distinct from a real ratio while still allowing decimal
 * custom ratios such as `2.39:1`.
 *
 * @param {unknown} value
 * @returns {{ width: number; height: number } | null}
 */
export function parseAspectRatio(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Calculate a linked width/height pair for the retry editor. The requested
 * anchor is kept as closely as possible, then the pair is clamped to the
 * legal 32px H3 grid and 32–2048 bounds. The API still receives only this
 * resulting width and height pair; the ratio itself is UI state.
 *
 * @param {string | { width: number; height: number }} aspectRatio
 * @param {number} anchorValue
 * @param {"width" | "height"} [anchorDimension]
 * @param {number} [grid]
 * @returns {{ width: number; height: number }}
 */
export function calculateAspectRatioDimensions(aspectRatio, anchorValue, anchorDimension = "width", grid = H3_GRID) {
  const parsed = typeof aspectRatio === "string" ? parseAspectRatio(aspectRatio) : aspectRatio;
  if (!parsed || !Number.isFinite(parsed.width) || !Number.isFinite(parsed.height) || parsed.width <= 0 || parsed.height <= 0) {
    throw new Error("A valid aspect ratio is required.");
  }
  if (anchorDimension !== "width" && anchorDimension !== "height") {
    throw new Error("The aspect-ratio anchor must be width or height.");
  }
  if (!Number.isFinite(anchorValue) || anchorValue <= 0) {
    throw new Error("The aspect-ratio anchor must be a positive number.");
  }
  if (!Number.isInteger(grid) || grid <= 0) {
    throw new Error("The resolution grid must be a positive integer.");
  }

  const rawWidth = anchorDimension === "height"
    ? anchorValue * parsed.width / parsed.height
    : anchorValue;
  const rawHeight = anchorDimension === "height"
    ? anchorValue
    : anchorValue * parsed.height / parsed.width;
  const maximumScale = Math.min(1, MAX_DIMENSION / rawWidth, MAX_DIMENSION / rawHeight);
  const minimumScale = Math.max(MIN_DIMENSION / rawWidth, MIN_DIMENSION / rawHeight);
  const scale = Math.max(minimumScale, maximumScale);

  return {
    width: clampToLegalGrid(rawWidth * scale, grid),
    height: clampToLegalGrid(rawHeight * scale, grid),
  };
}

/**
 * Keep the resolution slider bounded to a percentage of the source image.
 * A value outside the range is clamped so keyboard input and restored drafts
 * cannot create an invalid request.
 *
 * @param {number} value
 */
export function clampResolutionScale(value) {
  if (!Number.isFinite(value)) return MAX_SCALE_PERCENT;
  return Math.min(MAX_SCALE_PERCENT, Math.max(MIN_SCALE_PERCENT, Math.round(value)));
}

/**
 * Read an image's intrinsic dimensions without fetching or decoding it twice.
 * The constructor is injectable so the error and success paths remain unit
 * testable in Node, where the DOM Image constructor is unavailable.
 *
 * @param {string} url
 * @param {new () => { naturalWidth?: number; naturalHeight?: number; onload?: () => void; onerror?: () => void; src?: string }} [ImageConstructor]
 * @returns {Promise<ImageDimensions>}
 */
export function readImageDimensions(url, ImageConstructor = globalThis.Image) {
  if (typeof ImageConstructor !== "function") {
    return Promise.reject(new Error("This browser cannot read image dimensions."));
  }

  return new Promise((resolve, reject) => {
    const image = new ImageConstructor();
    image.onload = () => {
      const width = Number(image.naturalWidth);
      const height = Number(image.naturalHeight);
      if (!isValidDimension(width) || !isValidDimension(height)) {
        reject(new Error("The selected image has no readable dimensions."));
        return;
      }
      resolve({ width, height });
    };
    image.onerror = () => reject(new Error("The selected image could not be decoded."));
    image.src = url;
  });
}

/**
 * Fit intrinsic image dimensions to the current model's legal canvas while
 * keeping the source aspect ratio as closely as the legal pixel grid allows.
 * The result is what the UI should display and what the request builder should
 * receive; no hidden second resize is needed at submit time.
 *
 * @param {number} width
 * @param {number} height
 * @param {string} mode
 * @returns {NormalizedImageResolution}
 */
export function normalizeImageResolution(width, height, mode) {
  return scaleImageResolution(width, height, mode, MAX_SCALE_PERCENT);
}

/**
 * Scale an intrinsic image resolution and then fit it to the model's legal
 * dimensions. The percentage is applied to the original pixels, so 50% of a
 * 3024px source is 1512px before legal-grid rounding; 100% is capped only
 * when the model maximum would otherwise be exceeded.
 *
 * @param {number} width
 * @param {number} height
 * @param {string} mode
 * @param {number} scalePercent
 * @returns {NormalizedImageResolution & { scalePercent: number }}
 */
export function scaleImageResolution(width, height, mode, scalePercent = MAX_SCALE_PERCENT) {
  if (!isValidDimension(width) || !isValidDimension(height)) {
    throw new Error("The selected image has invalid dimensions.");
  }

  const grid = resolutionGridForMode(mode);
  const normalizedScalePercent = clampResolutionScale(scalePercent);
  const scaledWidth = width * normalizedScalePercent / MAX_SCALE_PERCENT;
  const scaledHeight = height * normalizedScalePercent / MAX_SCALE_PERCENT;
  const constrained = fitToLegalCanvas(scaledWidth, scaledHeight, grid);

  return {
    originalWidth: width,
    originalHeight: height,
    width: constrained.width,
    height: constrained.height,
    grid,
    scalePercent: normalizedScalePercent,
    scaled: normalizedScalePercent < MAX_SCALE_PERCENT || constrained.scale < 1,
    adjusted: constrained.width !== width || constrained.height !== height || normalizedScalePercent < MAX_SCALE_PERCENT,
  };
}

/**
 * Normalize one manually edited dimension without changing the other field.
 * The UI uses this for the unlocked aspect-ratio mode and for the secondary
 * dimension while the user edits a locked pair.
 *
 * @param {number} value
 * @param {string} mode
 */
export function normalizeResolutionDimension(value, mode) {
  if (!Number.isFinite(value)) return value;
  return clampToLegalGrid(value, resolutionGridForMode(mode));
}

/**
 * Estimate the slider value represented by an already edited output pair.
 * Values at or above the source dimensions map back to 100%; this keeps the
 * slider from becoming misleading after legal-grid rounding.
 *
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} width
 * @param {number} height
 */
export function resolutionScaleForDimensions(sourceWidth, sourceHeight, width, height) {
  if (![sourceWidth, sourceHeight, width, height].every(isValidDimension)) {
    return MAX_SCALE_PERCENT;
  }
  const scale = Math.min(width / sourceWidth, height / sourceHeight) * MAX_SCALE_PERCENT;
  return clampResolutionScale(scale);
}

function fitToLegalCanvas(width, height, grid) {
  const scale = Math.min(1, MAX_DIMENSION / width, MAX_DIMENSION / height);
  return {
    width: clampToLegalGrid(width * scale, grid),
    height: clampToLegalGrid(height * scale, grid),
    scale,
  };
}

function clampToLegalGrid(value, grid) {
  return Math.min(
    MAX_DIMENSION,
    Math.max(MIN_DIMENSION, Math.round(value / grid) * grid),
  );
}

function isValidDimension(value) {
  return Number.isInteger(value) && value > 0;
}
