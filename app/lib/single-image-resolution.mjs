const MIN_DIMENSION = 32;
const MAX_DIMENSION = 2048;
const H3_GRID = 32;
const ANIMATE_GRID = 16;

/**
 * @typedef {{ width: number; height: number }} ImageDimensions
 */

/**
 * @typedef {ImageDimensions & {
 *   originalWidth: number;
 *   originalHeight: number;
 *   grid: number;
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
  if (!isValidDimension(width) || !isValidDimension(height)) {
    throw new Error("The selected image has invalid dimensions.");
  }

  const grid = resolutionGridForMode(mode);
  const scale = Math.min(1, MAX_DIMENSION / width, MAX_DIMENSION / height);
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  const normalizedWidth = clampToLegalGrid(scaledWidth, grid);
  const normalizedHeight = clampToLegalGrid(scaledHeight, grid);

  return {
    originalWidth: width,
    originalHeight: height,
    width: normalizedWidth,
    height: normalizedHeight,
    grid,
    scaled: scale < 1,
    adjusted: normalizedWidth !== width || normalizedHeight !== height,
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
