import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLoraTrainingHealthRequest } from '../local-bridge.mjs';

test('health route accepts Z-Image and its canonical base profile', () => {
  assert.deepEqual(
    resolveLoraTrainingHealthRequest(new URLSearchParams({ family: 'z-image', baseProfile: 'z-image-turbo' })),
    { family: 'z-image', baseProfile: 'z-image-turbo' },
  );
});

test('health route canonicalizes the WAI family alias', () => {
  assert.deepEqual(
    resolveLoraTrainingHealthRequest(new URLSearchParams({ family: 'wai', baseProfile: 'wai-illustrious' })),
    { family: 'illustrious', baseProfile: 'wai-illustrious' },
  );
});

test('health route rejects a family/profile mismatch', () => {
  assert.throws(
    () => resolveLoraTrainingHealthRequest(new URLSearchParams({ family: 'z-image', baseProfile: 'sdxl-base-1.0' })),
    (error) => error?.code === 'INVALID_REQUEST' && error?.details?.field === 'baseProfile',
  );
});
