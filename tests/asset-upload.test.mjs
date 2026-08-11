import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import {
  AssetUploadError,
  createAssetUploadService,
  RAW_UPLOAD_CONTENT_TYPE,
} from "../server/media/asset-upload.mjs";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4_BYTES = Buffer.from("00000018667479706d703432", "hex");

async function harness(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-asset-upload-"));
  const service = createAssetUploadService({
    root,
    maxBytes: options.maxBytes || 1024,
    createWriteStream: options.createWriteStream,
    toAsset: async (assetRoot, name) => {
      const stat = await fs.stat(path.join(root, name));
      return {
        root: assetRoot,
        name,
        kind: /\.(png|jpe?g|webp|gif|bmp)$/i.test(name) ? "image" : "video",
        mime: /\.png$/i.test(name) ? "image/png" : "video/mp4",
        size: stat.size,
      };
    },
  });
  return { root, service };
}

function requestFrom(chunks, { contentLength } = {}) {
  const request = Readable.from(chunks);
  request.headers = {
    "content-length": contentLength === undefined ? String(chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0)) : String(contentLength),
  };
  return request;
}

async function tempFiles(root) {
  return (await fs.readdir(root)).filter((name) => name.startsWith(".upload-") && name.endsWith(".tmp"));
}

test("streams image and video bytes into atomic final assets", async (t) => {
  const { root, service } = await harness();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const image = await service.upload(requestFrom([PNG_BYTES.subarray(0, 4), PNG_BYTES.subarray(4)]), {
    name: "probe.png",
    mimeType: "image/png",
    contentType: RAW_UPLOAD_CONTENT_TYPE,
  });
  const video = await service.upload(requestFrom([MP4_BYTES]), {
    name: "clip.mp4",
    mimeType: "video/mp4",
    contentType: RAW_UPLOAD_CONTENT_TYPE,
  });

  assert.equal(image.name, "probe.png");
  assert.equal(video.name, "clip.mp4");
  assert.deepEqual(await fs.readFile(path.join(root, image.name)), PNG_BYTES);
  assert.deepEqual(await fs.readFile(path.join(root, video.name)), MP4_BYTES);
  assert.deepEqual(await tempFiles(root), []);
});

test("uses deterministic suffixes without overwriting duplicate names", async (t) => {
  const { root, service } = await harness();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const first = await service.upload(requestFrom([Buffer.from("first")]), { name: "same.png", mimeType: "image/png" });
  const second = await service.upload(requestFrom([Buffer.from("second")]), { name: "same.png", mimeType: "image/png" });

  assert.equal(first.name, "same.png");
  assert.equal(second.name, "same-1.png");
  assert.equal(await fs.readFile(path.join(root, first.name), "utf8"), "first");
  assert.equal(await fs.readFile(path.join(root, second.name), "utf8"), "second");
});

test("rejects over-limit raw bodies before or during streaming and cleans temp files", async (t) => {
  const { root, service } = await harness({ maxBytes: 4 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => service.upload(requestFrom([Buffer.from("12345")]), { name: "large.png", mimeType: "image/png" }),
    (error) => error instanceof AssetUploadError
      && error.code === "ASSET_UPLOAD_TOO_LARGE"
      && error.status === 413
      && error.details.bytesReceived > error.details.maxBytes,
  );
  assert.deepEqual(await tempFiles(root), []);
  assert.deepEqual((await fs.readdir(root)).filter((name) => !name.startsWith(".upload-")), []);
});

test("maps client abort to a structured error and leaves no partial asset", async (t) => {
  const { root, service } = await harness();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = new Readable({
    read() {
      this.push(Buffer.from("partial"));
      this.aborted = true;
      this.emit("aborted");
      this.destroy(Object.assign(new Error("client disconnected"), { code: "ECONNRESET" }));
    },
  });
  request.headers = { "content-length": "7" };

  await assert.rejects(
    () => service.upload(request, { name: "aborted.png", mimeType: "image/png" }),
    (error) => error instanceof AssetUploadError && error.code === "ASSET_UPLOAD_ABORTED" && error.status === 499,
  );
  assert.deepEqual(await tempFiles(root), []);
  assert.deepEqual((await fs.readdir(root)).filter((name) => !name.startsWith(".upload-")), []);
});

test("maps write failures and removes the temporary file", async (t) => {
  const { root, service } = await harness({
    createWriteStream: () => new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
      },
    }),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => service.upload(requestFrom([Buffer.from("write failure")]), { name: "failed.mp4", mimeType: "video/mp4" }),
    (error) => error instanceof AssetUploadError && error.code === "ASSET_UPLOAD_WRITE_FAILED" && error.status === 500,
  );
  assert.deepEqual(await tempFiles(root), []);
  assert.deepEqual((await fs.readdir(root)).filter((name) => !name.startsWith(".upload-")), []);
});

test("validates path, extension, MIME, and raw content type before writing", async (t) => {
  const { root, service } = await harness();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(() => service.upload(requestFrom([PNG_BYTES]), { name: "../escape.png", mimeType: "image/png" }), { code: "ASSET_UPLOAD_NAME_INVALID", status: 400 });
  await assert.rejects(() => service.upload(requestFrom([PNG_BYTES]), { name: "mismatch.png", mimeType: "video/mp4" }), { code: "ASSET_UPLOAD_MIME_MISMATCH", status: 415 });
  await assert.rejects(() => service.upload(requestFrom([PNG_BYTES]), { name: "notes.txt", mimeType: "text/plain" }), { code: "ASSET_UPLOAD_EXTENSION_UNSUPPORTED", status: 415 });
  await assert.rejects(() => service.upload(requestFrom([PNG_BYTES]), { name: "json.png", mimeType: "image/png", contentType: "application/json" }), { code: "ASSET_UPLOAD_CONTENT_TYPE_INVALID", status: 415 });
  assert.deepEqual(await fs.readdir(root), []);
});
