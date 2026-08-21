import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLoraTrainingHealthRequest } from '../local-bridge.mjs';

test('health route canonicalizes the WAI family alias', () => {
  assert.deepEqual(
    resolveLoraTrainingHealthRequest(new URLSearchParams({ family: 'wai', baseProfile: 'wai-illustrious' })),
    { family: 'illustrious', baseProfile: 'wai-illustrious' },
  );
});

test('health route rejects a removed model family', () => {
  assert.throws(
    () => resolveLoraTrainingHealthRequest(new URLSearchParams({ family: 'z-image', baseProfile: 'z-image-turbo' })),
    (error) => error?.code === 'INVALID_REQUEST' && error?.details?.field === 'family',
  );
});
