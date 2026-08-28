import { promises as fs } from "node:fs";
import path from "node:path";
import { LongVideoError } from "./schema.mjs";
import { mediaExecutables, probeMedia, runCommand, stderrTail, validateNormalizedProbe } from "./media.mjs";
import { sequenceOutputFile } from "./paths.mjs";

function concatLine(filePath, baseDir = process.cwd()) {
  const normalized = path.relative(baseDir, path.resolve(filePath)).replaceAll("\\", "/").replaceAll("'", "'\\''");
  return `file '${normalized}'`;
}

export async function assembleSegments({ segmentPaths, outputFolder, assemblyDir, revision = 1, duration, width, height, masterNormalize = "off", allowSingleSegment = false, tools = {}, run = runCommand, logger = null }) {
  const minimumSegments = allowSingleSegment ? 1 : 2;
  if (!Array.isArray(segmentPaths) || segmentPaths.length < minimumSegments) throw new LongVideoError("ASSEMBLY_SEGMENTS_REQUIRED", `At least ${minimumSegments} normalized segment${minimumSegments === 1 ? " is" : "s are"} required.`);
  const concatPath = path.join(assemblyDir || outputFolder, "concat.txt");
  const outputPath = sequenceOutputFile(outputFolder, `final-r${String(revision).padStart(3, "0")}.mp4`);
  const outputExisted = Boolean(await fs.stat(outputPath).catch(() => null));
  const executables = tools.executables || mediaExecutables();
  let verified = false;
  try {
    if (!["off", "luma", "luma+contrast"].includes(masterNormalize)) throw new LongVideoError("MASTER_NORMALIZE_INVALID", "masterNormalize must be off, luma, or luma+contrast.", 400);
    await fs.mkdir(path.dirname(concatPath), { recursive: true });
    await fs.writeFile(concatPath, segmentPaths.map((segmentPath) => concatLine(segmentPath, path.dirname(concatPath))).join("\n") + "\n", "utf8");
  const args = ["-y", "-f", "concat", "-safe", "0", "-i", concatPath];
  if (masterNormalize === "off") {
    args.push("-c", "copy", outputPath);
  } else {
    // Temporal normalization runs only after assembly, never in the H3
    // feedback loop. Luma keeps RGB linked; luma+contrast also balances
    // channel steps to reduce warm/cold boundary shifts.
    const contrastAndColor = masterNormalize === "luma+contrast";
    const strength = contrastAndColor ? "0.55" : "0.35";
    args.push("-vf", `normalize=independence=${contrastAndColor ? 1 : 0}:smoothing=48:strength=${strength}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", outputPath);
  }
  await logger?.({ event: "assembly.start", executable: executables.ffmpeg, args, outputPath, segmentCount: segmentPaths.length });
  let response;
  try { response = await run(executables.ffmpeg, args); } catch (error) {
    await logger?.({ level: "error", event: "assembly.failure", executable: executables.ffmpeg, args, errorMessage: error.message });
    throw new LongVideoError("FFMPEG_UNAVAILABLE", `Unable to execute ffmpeg: ${error.message}`, 503, { executable: executables.ffmpeg, error: error.message });
  }
  if (response.exitCode !== 0) {
    await logger?.({ level: "error", event: "assembly.failure", executable: executables.ffmpeg, args, exitCode: response.exitCode, stderrTail: stderrTail(response.stderr) });
    throw new LongVideoError("FFMPEG_ASSEMBLY_FAILED", "ffmpeg failed while assembling the final video.", 502, { executable: executables.ffmpeg, exitCode: response.exitCode, stderrTail: stderrTail(response.stderr) });
  }
  const probe = tools.probe ? await tools.probe(outputPath) : await probeMedia(outputPath, { executables, run, logger });
  validateNormalizedProbe(probe, { duration, width, height, fps: 24 });
  verified = true;
  await logger?.({ event: "assembly.success", outputPath, exitCode: response.exitCode, duration: probe.format?.duration || null });
  return { outputPath, concatPath, probe, response, revision, masterNormalize };
  } finally {
    await fs.unlink(concatPath).catch(() => {});
    if (!verified && !outputExisted) {
      const stat = await fs.lstat(outputPath).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink()) await fs.unlink(outputPath).catch(() => {});
    }
  }
}

export { concatLine };
export const assembleSequence = assembleSegments;
