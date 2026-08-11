import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';

const SECRET = /(?:bearer\s+|hf_[a-z0-9]+|token=|password=|api[_-]?key=)/ig;

export function parseTrainingProgress(line) {
  const text = String(line);
  const step = text.match(/(?:steps?|global_step)\s*[:= ]\s*(\d+)(?:\s*\/\s*(\d+))?/i) ?? text.match(/(\d+)\s*\/\s*(\d+)\s*\[/);
  const epoch = text.match(/epoch\s*[:= ]\s*(\d+)(?:\s*\/\s*(\d+))?/i);
  const loss = text.match(/(?:loss|train_loss)\s*[:= ]\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i);
  const eta = text.match(/(?:eta\s*[:= ]\s*|<)(\d{1,3}:\d{2}(?::\d{2})?)/i);
  if (!step && !epoch && !loss && !eta) return null;
  return {
    ...(step ? { step: Number(step[1]), ...(step[2] ? { totalSteps: Number(step[2]) } : {}) } : {}),
    ...(epoch ? { epoch: Number(epoch[1]), ...(epoch[2] ? { totalEpochs: Number(epoch[2]) } : {}) } : {}),
    ...(loss ? { loss: Number(loss[1]) } : {}),
    ...(eta ? { eta: eta[1] } : {}),
  };
}

function safeLine(line, maximum = 4096) {
  return String(line).replace(SECRET, '[REDACTED]').slice(0, maximum);
}

export function createTrainingRunner({
  spawn = nodeSpawn,
  onProgress = async () => {},
  onLog = async () => {},
  now = () => Date.now(),
  progressIntervalMs = 500,
  maxLogLines = 2000,
  cancelGraceMs = 5000,
  platform = process.platform,
} = {}) {
  let active = null;

  async function run(resolved, { env = {}, signal } = {}) {
    if (active) throw new Error('runner already has an active process');
    if (!resolved || resolved.shell !== false || typeof resolved.command !== 'string' || !Array.isArray(resolved.args)) {
      throw new TypeError('a resolved shell:false command is required');
    }
    const child = spawn(resolved.command, resolved.args, {
      cwd: resolved.cwd,
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      detached: platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    let lastProgressAt = 0;
    let pendingProgress = null;
    let cancelTimer = null;
    let abortListener;
    const consume = (stream, channel) => {
      if (!stream) return;
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('line', (raw) => {
        const line = safeLine(raw);
        logs.push({ at: new Date(now()).toISOString(), channel, line });
        if (logs.length > maxLogLines) logs.splice(0, logs.length - maxLogLines);
        void onLog(logs.at(-1));
        const progress = parseTrainingProgress(line);
        if (!progress) return;
        pendingProgress = progress;
        const timestamp = now();
        if (timestamp - lastProgressAt >= progressIntervalMs) {
          lastProgressAt = timestamp;
          pendingProgress = null;
          void onProgress(progress);
        }
      });
    };
    consume(child.stdout, 'stdout');
    consume(child.stderr, 'stderr');

    const cancel = async () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGINT');
      cancelTimer = setTimeout(() => {
        if (child.exitCode !== null) return;
        if (platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGKILL');
      }, cancelGraceMs);
      cancelTimer.unref?.();
    };
    active = { child, cancel };
    if (signal) {
      abortListener = () => void cancel();
      if (signal.aborted) abortListener(); else signal.addEventListener('abort', abortListener, { once: true });
    }
    try {
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, terminationSignal) => resolve({ code, signal: terminationSignal }));
      });
      if (pendingProgress) await onProgress(pendingProgress);
      return { ...result, logs: structuredClone(logs) };
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      active = null;
    }
  }

  return Object.freeze({ run, cancel: () => active?.cancel() ?? Promise.resolve(), isRunning: () => Boolean(active) });
}
