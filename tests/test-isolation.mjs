/**
 * Test-process isolation for modules that persist long-video jobs at import
 * time or on their first API call.  This module is intentionally imported
 * before any server module in the affected test files and is also loaded by
 * the package test command with --import, so a test can never fall back to
 * the repository's live data/jobs directory.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "h3-sequence-test-process-"));
process.env.H3_SEQUENCE_DATA_ROOT = path.join(root, "data");
process.env.COMFYUI_OUTPUT_ROOT = path.join(root, "output");
process.env.H3_LONG_VIDEO_LOG_STDOUT = "0";

export const testIsolationRoot = root;
