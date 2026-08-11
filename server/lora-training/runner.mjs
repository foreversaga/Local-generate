import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';

const SECRET = /(?:bearer\s+|hf_[a-z0-9]+|token=|password=|api[_-]?key=)/ig;
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|opt)\/)[^\s"']*/g;

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

export function sanitizeTrainerText(line, maximum = 4096) {
  return String(line)
    .replace(SECRET, '[REDACTED]')
    .replace(ABSOLUTE_PATH, '[PATH]')
    .slice(0, maximum);
}

function clockMilliseconds(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function createTrainingRunner({
  spawn = nodeSpawn,
  onProgress = async () => {},
  onLog = async () => {},
  now = () => Date.now(),
  progressIntervalMs = 500,
  maxLogLines = 400,
  cancelGraceMs = 5000,
  platform = process.platform,
} = {}) {
  let active = null;

  async function run(resolved, { env = {}, signal } = {}) {
    if (active) throw new Error('runner already has an active process');
    if (!resolved || resolved.shell !== false || typeof resolved.command !== 'string' || !Array.isArray(resolved.args)) {
      throw new TypeError('a resolved shell:false command is required');
    }
    const startedAt = new Date(now()).toISOString();
    const startedClock = now();
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
      stream.setEncoding?.('utf8');
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('line', (raw) => {
        const line = sanitizeTrainerText(raw);
        logs.push({ at: new Date(now()).toISOString(), channel, line });
        if (logs.length > maxLogLines) logs.splice(0, logs.length - maxLogLines);
        void Promise.resolve(onLog(logs.at(-1))).catch(() => {});
        const progress = parseTrainingProgress(line);
        if (!progress) return;
        pendingProgress = progress;
        const timestamp = now();
        if (timestamp - lastProgressAt >= progressIntervalMs) {
          lastProgressAt = timestamp;
          pendingProgress = null;
          void Promise.resolve(onProgress(progress)).catch(() => {});
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
      const finishedAt = new Date(now()).toISOString();
      const finishedClock = now();
      return {
        ...result,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, clockMilliseconds(finishedClock) - clockMilliseconds(startedClock)),
        logs: structuredClone(logs),
      };
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      active = null;
    }
  }

  return Object.freeze({ run, cancel: () => active?.cancel() ?? Promise.resolve(), isRunning: () => Boolean(active) });
}
