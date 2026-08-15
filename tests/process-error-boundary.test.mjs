import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const boundaryUrl = pathToFileURL(path.join(projectRoot, "server", "process-error-boundary.mjs")).href;
const vinextBackstopUrl = pathToFileURL(path.join(projectRoot, "node_modules", "vinext", "dist", "server", "socket-error-backstop.js")).href;

function runBoundaryProbe() {
  const source = `
    import { installProcessErrorBoundary } from ${JSON.stringify(boundaryUrl)};
    const boundary = installProcessErrorBoundary();
    const { installSocketErrorBackstop } = await import(${JSON.stringify(vinextBackstopUrl)});
    installSocketErrorBackstop();
    const failure = Object.assign(new Error("simulated locked persistence file"), {
      code: "EPERM",
      syscall: "rename",
      path: "temporary-job.json",
      dest: "job.json",
    });
    Promise.reject(failure);
    setTimeout(() => {
      throw Object.assign(new Error("simulated escaped callback error"), { code: "EPERM" });
    }, 10);
    setTimeout(() => {
      const snapshot = boundary.snapshot();
      console.log(JSON.stringify({
        alive: true,
        rejectionCount: snapshot.unhandledRejectionCount,
        exceptionCount: snapshot.uncaughtExceptionCount,
        rejectionCode: snapshot.lastUnhandledRejection?.error?.code,
        exceptionCode: snapshot.lastUncaughtException?.error?.code,
        rejectionListeners: process.listenerCount("unhandledRejection"),
        exceptionListeners: process.listenerCount("uncaughtException"),
      }));
    }, 40);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("outer process boundary records escaped EPERM errors and keeps Node alive", async () => {
  const result = await runBoundaryProbe();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    alive: true,
    rejectionCount: 1,
    exceptionCount: 1,
    rejectionCode: "EPERM",
    exceptionCode: "EPERM",
    rejectionListeners: 1,
    exceptionListeners: 1,
  });
  assert.match(result.stderr, /\[process-error-boundary\]/);
  assert.match(result.stderr, /unhandledRejection/);
  assert.match(result.stderr, /uncaughtException/);
  assert.match(result.stderr, /EPERM/);
});
