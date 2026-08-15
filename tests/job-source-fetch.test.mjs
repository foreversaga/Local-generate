import assert from 'node:assert/strict';
import test from 'node:test';

import { JOB_SOURCE_SPECS, fetchUnifiedJobSnapshot, lookupUnifiedJob } from '../app/lib/job-source-fetch.mjs';

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function sourceForUrl(url) {
  const pathname = String(url).split("?")[0];
  return JOB_SOURCE_SPECS.find((spec) => spec.url === pathname)?.source;
}

function successJobs(source) {
  return { jobs: [{ id: `${source}-job`, status: 'completed', updatedAt: '2026-08-12T00:00:00.000Z' }] };
}

test('successful source requests preserve the unified jobs behavior', async () => {
  const calls = [];
  const snapshot = await fetchUnifiedJobSnapshot({
    fetchImpl: async (url) => {
      calls.push(url);
      return response(200, successJobs(sourceForUrl(url)));
    },
  });
  assert.deepEqual(calls.sort(), JOB_SOURCE_SPECS.map((spec) => spec.url).sort());
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.jobs.length, JOB_SOURCE_SPECS.length);
  assert.deepEqual(new Set(snapshot.jobs.map((job) => job.source)), new Set(JOB_SOURCE_SPECS.map((spec) => spec.source)));
});

test('summary job requests bound every source response at the URL', async () => {
  const calls = [];
  await fetchUnifiedJobSnapshot({
    limitPerSource: 5,
    summary: true,
    fetchImpl: async (url) => {
      calls.push(url);
      return response(200, successJobs(sourceForUrl(url)));
    },
  });
  assert.deepEqual(calls.sort(), JOB_SOURCE_SPECS.map((spec) => `${spec.url}?limit=5&summary=1`).sort());
});

test('an HTTP source failure remains visible while other sources stay usable', async () => {
  const snapshot = await fetchUnifiedJobSnapshot({
    fetchImpl: async (url) => sourceForUrl(url) === 'long'
      ? response(500, { code: 'LONG_BACKEND_DOWN', error: 'long source temporarily unavailable' })
      : response(200, successJobs(sourceForUrl(url))),
  });
  assert.equal(snapshot.jobs.length, 4);
  assert.deepEqual(snapshot.errors, [{
    source: 'long', status: 500, code: 'LONG_BACKEND_DOWN', message: 'long source temporarily unavailable',
  }]);
});

test('network rejection maps to a safe source diagnostic instead of an empty-success source', async () => {
  const snapshot = await fetchUnifiedJobSnapshot({
    fetchImpl: async (url) => {
      if (sourceForUrl(url) === 'video') throw new Error('fetch failed token=super-secret');
      return response(200, successJobs(sourceForUrl(url)));
    },
  });
  const error = snapshot.errors.find((item) => item.source === 'video');
  assert.deepEqual(error, { source: 'video', status: null, code: 'NETWORK_ERROR', message: 'Unable to reach video jobs.' });
  assert.equal(snapshot.jobs.length, 4);
  assert.doesNotMatch(JSON.stringify(snapshot), /super-secret/);
});

test('timeout maps consistently and does not block partial results', async () => {
  const snapshot = await fetchUnifiedJobSnapshot({
    timeoutMs: 5,
    fetchImpl: async (url) => sourceForUrl(url) === 'upscale'
      ? new Promise(() => {})
      : response(200, successJobs(sourceForUrl(url))),
  });
  assert.equal(snapshot.jobs.length, 4);
  assert.deepEqual(snapshot.errors, [{
    source: 'upscale', status: 408, code: 'TIMEOUT', message: 'Timed out loading upscale jobs.',
  }]);
});

test('all source failures return no jobs but retain every failure diagnostic', async () => {
  const snapshot = await fetchUnifiedJobSnapshot({
    timeoutMs: 5,
    fetchImpl: async (url) => {
      const source = sourceForUrl(url);
      if (source === 'video') return response(503, { error: 'maintenance' });
      if (source === 'long') throw new Error('network down');
      return new Promise(() => {});
    },
  });
  assert.deepEqual(snapshot.jobs, []);
  assert.equal(snapshot.errors.length, JOB_SOURCE_SPECS.length);
  assert.deepEqual(snapshot.errors.map((item) => item.source).sort(), JOB_SOURCE_SPECS.map((spec) => spec.source).sort());
  assert.deepEqual(snapshot.errors.find((item) => item.source === 'video'), {
    source: 'video', status: 503, code: 'HTTP_503', message: 'maintenance',
  });
});

test('detail lookup reports source unavailable instead of falling through to another source', () => {
  const snapshot = {
    jobs: [{ id: 'same-id', source: 'video' }],
    errors: [{ source: 'long', status: 503, code: 'HTTP_503', message: 'Long jobs unavailable.' }],
  };
  const result = lookupUnifiedJob(snapshot, { jobId: 'same-id', sourceHint: 'long' });
  assert.equal(result.job, null);
  assert.deepEqual(result.sourceError, snapshot.errors[0]);
  assert.deepEqual(lookupUnifiedJob(snapshot, { jobId: 'same-id', sourceHint: 'video' }), { job: snapshot.jobs[0], sourceError: null });
  assert.deepEqual(lookupUnifiedJob(snapshot, { jobId: 'missing', sourceHint: 'video' }), { job: null, sourceError: null });
});
