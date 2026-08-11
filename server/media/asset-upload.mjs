import { createWriteStream as defaultCreateWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const RAW_UPLOAD_LIMIT_BYTES = 256 * 1024 * 1024;
export const RAW_UPLOAD_CONTENT_TYPE = "application/octet-stream";

const IMAGE_MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};
const VIDEO_MIME_BY_EXTENSION = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};
const MIME_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["video/x-m4v", "video/mp4"],
]);
const MAX_DUPLICATE_SUFFIX = 10_000;

export class AssetUploadError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = "AssetUploadError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeMime(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function compatibleMime(mimeType, expectedMime) {
  const normalized = MIME_ALIASES.get(mimeType) || mimeType;
  return !normalized || normalized === RAW_UPLOAD_CONTENT_TYPE || normalized === expectedMime;
}

function pathInvalid(name) {
  return name !== path.basename(name)
    || /[\\/]/.test(name)
    || /^[A-Za-z]:/.test(name)
    || name.startsWith("\\\\")
    || name === "."
    || name === ".."
    || Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint < 0x20 || codePoint === 0x7f;
    });
}

export function validateAssetUploadMetadata({ name, mimeType } = {}) {
  const originalName = String(name || "");
  if (!originalName || originalName.length > 255 || Buffer.byteLength(originalName, "utf8") > 255 || pathInvalid(originalName)) {
    throw new AssetUploadError("ASSET_UPLOAD_NAME_INVALID", "Asset name must be a safe file name without path segments.", 400);
  }

  const extension = path.extname(originalName).toLowerCase();
  const imageMime = IMAGE_MIME_BY_EXTENSION[extension];
  const videoMime = VIDEO_MIME_BY_EXTENSION[extension];
  const expectedMime = imageMime || videoMime;
  const kind = imageMime ? "image" : videoMime ? "video" : "";
  if (!expectedMime) {
    throw new AssetUploadError("ASSET_UPLOAD_EXTENSION_UNSUPPORTED", "Only supported image and video extensions can be uploaded.", 415);
  }

  const normalizedMime = normalizeMime(mimeType);
  if (!compatibleMime(normalizedMime, expectedMime)) {
    throw new AssetUploadError("ASSET_UPLOAD_MIME_MISMATCH", "The upload MIME type does not match its file extension.", 415, {
      extension,
      expectedMime,
    });
  }

  const stem = originalName
    .slice(0, -extension.length)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "upload";
  return { originalName, stem, extension, kind, mimeType: expectedMime };
}

function isDestinationConflict(error) {
  return ["EEXIST", "ENOTEMPTY"].includes(error?.code);
}

function safeTempName(id) {
  const suffix = String(id || randomUUID()).replace(/[^a-zA-Z0-9-]/g, "");
  return `.upload-${suffix || randomUUID()}.tmp`;
}

function requestHeaders(request) {
  return request?.headers && typeof request.headers === "object" ? request.headers : {};
}

function declaredLength(request) {
  const value = Number(requestHeaders(request)["content-length"]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function uploadDetails(bytesReceived, maxBytes, extra = {}) {
  return { bytesReceived, maxBytes, ...extra };
}

export function createAssetUploadService({
  root,
  assetRoot = "input",
  toAsset,
  maxBytes = RAW_UPLOAD_LIMIT_BYTES,
  fileSystem = fs,
  createWriteStream = defaultCreateWriteStream,
  idFactory = randomUUID,
} = {}) {
  const rootPath = path.resolve(String(root || ""));
  const reservedTargets = new Set();
  if (!rootPath || !root || typeof toAsset !== "function") {
    throw new TypeError("asset upload service requires root and toAsset");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("asset upload maxBytes must be a positive safe integer");
  }

  async function ensureRoot() {
    await fileSystem.mkdir(rootPath, { recursive: true });
    const stat = await fileSystem.lstat(rootPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AssetUploadError("ASSET_UPLOAD_ROOT_INVALID", "The upload root is not a regular directory.", 500);
    }
  }

  async function reserveTarget(stem, extension) {
    for (let suffix = 0; suffix <= MAX_DUPLICATE_SUFFIX; suffix += 1) {
      const outputName = `${stem}${suffix ? `-${suffix}` : ""}${extension}`;
      const outputPath = path.join(rootPath, outputName);
      if (reservedTargets.has(outputPath)) continue;
      const existing = await fileSystem.lstat(outputPath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (existing) continue;
      reservedTargets.add(outputPath);
      return { outputName, outputPath };
    }
    throw new AssetUploadError("ASSET_UPLOAD_DUPLICATE_LIMIT", "Unable to allocate a unique asset name.", 409);
  }

  async function upload(request, metadata = {}) {
    const info = validateAssetUploadMetadata(metadata);
    const contentType = normalizeMime(metadata.contentType);
    if (contentType && contentType !== RAW_UPLOAD_CONTENT_TYPE) {
      throw new AssetUploadError("ASSET_UPLOAD_CONTENT_TYPE_INVALID", "Raw uploads must use application/octet-stream.", 415);
    }
    const length = declaredLength(request);
    if (length !== null && length > maxBytes) {
      throw new AssetUploadError("ASSET_UPLOAD_TOO_LARGE", "The upload exceeds the raw byte limit.", 413, uploadDetails(length, maxBytes));
    }

    await ensureRoot();
    let target = await reserveTarget(info.stem, info.extension);
    const tempPath = path.join(rootPath, safeTempName(idFactory()));
    let renamed = false;
    let requestAborted = false;
    let requestEnded = false;
    const onAborted = () => { requestAborted = true; };
    const onClose = () => {
      if (!requestEnded && request?.aborted === true) requestAborted = true;
    };
    request?.once?.("aborted", onAborted);
    request?.once?.("close", onClose);

    let bytesReceived = 0;
    try {
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
          bytesReceived += buffer.length;
          if (bytesReceived > maxBytes) {
            callback(new AssetUploadError("ASSET_UPLOAD_TOO_LARGE", "The upload exceeds the raw byte limit.", 413, uploadDetails(bytesReceived, maxBytes)));
            return;
          }
          callback(null, buffer);
        },
      });
      const output = createWriteStream(tempPath, { flags: "wx" });
      await pipeline(request, limiter, output);
      requestEnded = true;
      if (requestAborted || request?.aborted === true) {
        throw new AssetUploadError("ASSET_UPLOAD_ABORTED", "The client aborted the upload.", 499, uploadDetails(bytesReceived, maxBytes));
      }
      if (bytesReceived === 0) {
        throw new AssetUploadError("ASSET_UPLOAD_EMPTY", "The upload body is empty.", 400, uploadDetails(0, maxBytes));
      }

      for (let attempt = 0; attempt <= MAX_DUPLICATE_SUFFIX; attempt += 1) {
        try {
          await fileSystem.rename(tempPath, target.outputPath);
          renamed = true;
          break;
        } catch (error) {
          reservedTargets.delete(target.outputPath);
          if (!isDestinationConflict(error) || attempt === MAX_DUPLICATE_SUFFIX) {
            throw new AssetUploadError("ASSET_UPLOAD_COMMIT_FAILED", "The uploaded asset could not be committed atomically.", 500, uploadDetails(bytesReceived, maxBytes));
          }
          target = await reserveTarget(info.stem, info.extension);
        }
      }
      return await toAsset(assetRoot, target.outputName);
    } catch (error) {
      if (error instanceof AssetUploadError) throw error;
      if (requestAborted || request?.aborted === true || error?.code === "ERR_STREAM_PREMATURE_CLOSE") {
        throw new AssetUploadError("ASSET_UPLOAD_ABORTED", "The client aborted the upload.", 499, uploadDetails(bytesReceived, maxBytes));
      }
      throw new AssetUploadError("ASSET_UPLOAD_WRITE_FAILED", "The uploaded asset could not be written.", 500, uploadDetails(bytesReceived, maxBytes));
    } finally {
      request?.removeListener?.("aborted", onAborted);
      request?.removeListener?.("close", onClose);
      if (target?.outputPath) reservedTargets.delete(target.outputPath);
      if (!renamed) await fileSystem.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  return { upload };
}
