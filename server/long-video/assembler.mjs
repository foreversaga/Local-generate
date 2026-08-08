import { promises as fs } from "node:fs";
import path from "node:path";
import { LongVideoError } from "./schema.mjs";
import { mediaExecutables, probeMedia, runCommand, stderrTail, validateNormalizedProbe } from "./media.mjs";
import { sequenceOutputFile } from "./paths.mjs";

function concatLine(filePath, baseDir = process.cwd()) {
  const normalized = path.relative(baseDir, path.resolve(filePath)).replaceAll("\\", "/").replaceAll("'", "'\\''");
  return `file '${normalized}'`;
}

export async function assembleSegments({ segmentPaths, outputFolder, assemblyDir, revision = 1, duration, width, height, tools = {}, run = runCommand, logger = null }) {
  if (!Array.isArray(segmentPaths) || segmentPaths.length < 2) throw new LongVideoError("ASSEMBLY_SEGMENTS_REQUIRED", "At least two normalized segments are required.");
  const concatPath = path.join(assemblyDir || outputFolder, "concat.txt");
  await fs.mkdir(path.dirname(concatPath), { recursive: true });
  await fs.writeFile(concatPath, segmentPaths.map((segmentPath) => concatLine(segmentPath, path.dirname(concatPath))).join("\n") + "\n", "utf8");
  const outputPath = sequenceOutputFile(outputFolder, `final-r${String(revision).padStart(3, "0")}.mp4`);
  const executables = tools.executables || mediaExecutables();
  const args = ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", outputPath];
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
  await logger?.({ event: "assembly.success", outputPath, exitCode: response.exitCode, duration: probe.format?.duration || null });
  return { outputPath, concatPath, probe, response, revision };
}

export { concatLine };
export const assembleSequence = assembleSegments;
