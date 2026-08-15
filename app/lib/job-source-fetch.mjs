import { mergeJobCollections } from './job-adapter.mjs';

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_ERROR_MESSAGE_LENGTH = 240;

export const JOB_SOURCE_SPECS = Object.freeze([
  Object.freeze({ source: 'video', url: '/app/api/jobs' }),
  Object.freeze({ source: 'long', url: '/app/api/sequences' }),
  Object.freeze({ source: 'upscale', url: '/app/api/upscale/jobs' }),
  Object.freeze({ source: 'img2img', url: '/app/api/img2img/jobs' }),
  Object.freeze({ source: 'lora', url: '/app/api/lora-training/jobs' }),
]);

function safeText(value, fallback) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const safe = text
    .replace(/\s+/g, ' ')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\/{1,2})[^\s,;]+/g, '[redacted path]')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
  return safe || fallback;
}

function safeCode(value, fallback) {
  const code = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(code) ? code : fallback;
}

function statusValue(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function timeoutValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(numeric, 30_000) : DEFAULT_TIMEOUT_MS;
}

function sourceError(spec, { status = null, code, message }) {
  return {
    source: spec.source,
    status: statusValue(status),
    code: safeCode(code, 'SOURCE_UNAVAILABLE'),
    message: safeText(message, `${spec.source} jobs are unavailable.`),
  };
}

function timeoutError(spec) {
  return sourceError(spec, {
    status: 408,
    code: 'TIMEOUT',
    message: `Timed out loading ${spec.source} jobs.`,
  });
}

function sourceUrl(spec, { limitPerSource, summary }) {
  const params = new URLSearchParams();
  if (Number.isInteger(limitPerSource) && limitPerSource > 0) params.set('limit', String(limitPerSource));
  if (summary) params.set('summary', '1');
  const query = params.toString();
  return query ? `${spec.url}?${query}` : spec.url;
}

async function fetchOneSource(spec, { fetchImpl, timeoutMs, limitPerSource, summary }) {
  if (typeof fetchImpl !== 'function') {
    return { source: spec.source, jobs: [], error: sourceError(spec, { code: 'NETWORK_ERROR', message: `Unable to reach ${spec.source} jobs.` }) };
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  let timer;
  const request = Promise.resolve().then(() => fetchImpl(sourceUrl(spec, { limitPerSource, summary }), {
    cache: 'no-store',
    ...(controller ? { signal: controller.signal } : {}),
  }));
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
      const error = new Error('job source request timed out');
      error.code = 'JOB_SOURCE_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  let response;
  try {
    response = await Promise.race([request, deadline]);
  } catch (error) {
    if (timedOut || error?.code === 'JOB_SOURCE_TIMEOUT' || error?.name === 'TimeoutError') {
      return { source: spec.source, jobs: [], error: timeoutError(spec) };
    }
    return {
      source: spec.source,
      jobs: [],
      error: sourceError(spec, { code: 'NETWORK_ERROR', message: `Unable to reach ${spec.source} jobs.` }),
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response || typeof response.ok !== 'boolean') {
    return { source: spec.source, jobs: [], error: sourceError(spec, { code: 'INVALID_RESPONSE', message: `Invalid response from ${spec.source} jobs.` }) };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) {
      return {
        source: spec.source,
        jobs: [],
        error: sourceError(spec, {
          status: response.status,
          code: `HTTP_${statusValue(response.status) || 'ERROR'}`,
          message: `${spec.source} jobs request failed (HTTP ${statusValue(response.status) || 'error'}).`,
        }),
      };
    }
    return { source: spec.source, jobs: [], error: sourceError(spec, { status: response.status, code: 'INVALID_RESPONSE', message: `Invalid response from ${spec.source} jobs.` }) };
  }

  if (!response.ok) {
    const payloadError = typeof payload?.error === 'string'
      ? payload.error
      : payload?.error?.message || payload?.message;
    return {
      source: spec.source,
      jobs: [],
      error: sourceError(spec, {
        status: response.status,
        code: payload?.code || `HTTP_${statusValue(response.status) || 'ERROR'}`,
        message: payloadError || `${spec.source} jobs request failed (HTTP ${statusValue(response.status) || 'error'}).`,
      }),
    };
  }

  const jobs = Array.isArray(payload?.jobs)
    ? payload.jobs
    : spec.source === 'img2img' && payload?.job && typeof payload.job === 'object'
      ? [payload.job]
      : [];
  return { source: spec.source, jobs };
}

/**
 * @param {{
 *   fetchImpl?: typeof globalThis.fetch;
 *   timeoutMs?: number;
 *   limitPerSource?: number | null;
 *   summary?: boolean;
 * }} [options]
 */
export async function fetchUnifiedJobSnapshot(options = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, limitPerSource = null, summary = false } = options;
  const results = await Promise.all(JOB_SOURCE_SPECS.map((spec) => fetchOneSource(spec, {
    fetchImpl,
    timeoutMs: timeoutValue(timeoutMs),
    limitPerSource,
    summary,
  })));
  const collections = results.map(({ source, jobs }) => ({ source, jobs }));
  return {
    jobs: mergeJobCollections(collections),
    errors: results.filter((result) => result.error).map((result) => result.error),
  };
}

export function lookupUnifiedJob(snapshot, { jobId, sourceHint } = {}) {
  const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
  const job = sourceHint
    ? jobs.find((item) => item?.id === jobId && item?.source === sourceHint) || null
    : jobs.find((item) => item?.id === jobId) || null;
  const sourceError = !job && sourceHint
    ? (snapshot?.errors || []).find((item) => item?.source === sourceHint) || null
    : null;
  return { job, sourceError };
}
