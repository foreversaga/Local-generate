# SeedVR2 7B Advanced Sampling Plan

## Goal

Expose advanced sampling controls for the existing `seedvr2_7b_sharp_nvfp4` image and video upscale workflows while preserving their current output by default.

This plan is intentionally limited to the installed SeedVR2 7B Sharp NVFP4 model. It does not add SeedVR2 3B, the non-Sharp 7B checkpoint, or model switching.

## Current contract

Both programmatic SeedVR2 graphs currently use the same fixed KSampler values:

| Field | Current default |
| --- | ---: |
| `steps` | `1` |
| `cfg` | `1` |
| `samplerName` | `euler` |
| `scheduler` | `simple` |
| `denoise` | `1.0` |

The implementation must keep these values as defaults for new requests, old persisted jobs, retries, and clients that do not send advanced settings.

## Proposed public settings

Use the API and persisted-job names below. UI labels may be localized independently.

| API field | Type | Default | Initial validation boundary |
| --- | --- | ---: | --- |
| `steps` | integer | `1` | `1..20` |
| `cfg` | number | `1` | `0..20`, normalized to two decimals |
| `samplerName` | string enum | `euler` | explicit server allowlist sourced from the locally supported KSampler names |
| `scheduler` | string enum | `simple` | explicit server allowlist sourced from the locally supported scheduler names |
| `denoise` | number | `1` | `0..1`, normalized to two decimals |

Start with conservative numeric limits even though the generic ComfyUI KSampler schema accepts much larger values. SeedVR2 is distributed as a one-step restoration model, so the normal-state UI must retain the one-step defaults and explain that non-default settings are experimental.

`input_noise_scale` and `latent_noise_scale` are out of scope. No corresponding fields exist in the current local SeedVR2 nodes or workflow, so they require a separate model-level design and validation task.

## Backend work

Primary file: `server/video-upscale/seedvr2.mjs`.

1. Add exported default constants and allowlists for all five settings.
2. Extend `normalizeSeedVR2Settings()` to validate and normalize the fields.
3. Pass normalized values into both `buildSeedVR2Prompt()` and `buildSeedVR2ImagePrompt()`.
4. Replace the five fixed KSampler literals in both graphs with normalized settings.
5. Add the settings to `createJob()`, the public job response, provenance, and retry reconstruction.
6. Apply advanced fields only to the SeedVR2 profile. H3 Latent must retain its existing two-pass sampling contract.
7. Return stable `400` error codes for invalid values, for example `STEPS_INVALID`, `CFG_INVALID`, `SAMPLER_INVALID`, `SCHEDULER_INVALID`, and `DENOISE_INVALID`.

## Persistence work

Primary file: `server/video-upscale/seedvr2-store.mjs`.

1. Canonicalize all five fields in the job and `provenance.request`.
2. Backfill missing fields from the defaults when older SQLite or legacy JSON records are read.
3. Preserve the exact settings on retry.
4. Do not require a database schema migration because the repository stores canonical job JSON payloads.

## API client and UI work

Primary files:

- `app/components/tools/upscale-client.ts`
- `app/components/tools/UpscaleWorkspace.tsx`
- `app/components/tools/UpscaleWorkspace.module.css`
- `app/i18n/dictionaries.ts`

1. Extend `SeedVR2Settings` and `UpscaleJob` with the five fields.
2. Include them in `POST /app/api/upscale` only for `seedvr2_7b_sharp_nvfp4`.
3. Add a collapsed "Advanced sampling" section under the current SeedVR2 parameter panel.
4. Provide a one-click reset to `1 / 1 / euler / simple / 1.0`.
5. Keep all numeric form state as strings while editing; validate or normalize only on blur or submit.
6. Disable the controls while a job is active, consistent with the existing upscale settings.
7. Show a concise warning when any sampling value differs from the SeedVR2 defaults.
8. Do not expose the controls for `h3_latent_2x`.

## Tests

Extend the existing targeted suites:

- `tests/video-upscale.test.mjs`
  - default image and video graphs remain unchanged;
  - every advanced override reaches the correct KSampler input;
  - each invalid boundary or enum returns the expected error code;
  - H3 Latent ignores or rejects SeedVR2-only advanced settings as explicitly decided by the API contract.
- `tests/seedvr2-lifecycle.test.mjs`
  - persistence, public API output, restart recovery, and retry preserve all five values;
  - old records without these fields receive defaults.
- `tests/seedvr2-settings-ui.test.mjs`
  - controls are SeedVR2-only;
  - numeric inputs retain empty-string editing behavior;
  - payload wiring and reset-to-default behavior are present.

## Runtime acceptance

1. Run targeted SeedVR2 tests and the complete project test suite.
2. Run one production build.
3. Confirm the ComfyUI queue is empty before restarting H3 Studio Web/API.
4. Restart only the Web/API service; the ComfyUI service does not need a restart for graph-only changes.
5. Verify `/app/api/upscale/health` remains ready for SeedVR2 image and video modes.
6. Use the Browser to confirm default values, advanced-panel interaction, reset behavior, and no console errors.
7. When GPU execution is explicitly authorized, compare the default one-step workflow against one controlled non-default setting using the same source and seed. Record runtime, output dimensions, prompt graph, and visible artifacts.

## Acceptance criteria

- Existing clients and persisted jobs continue to produce the original one-step graph.
- Image and video SeedVR2 graphs accept the same advanced sampling fields.
- UI, API response, provenance, retry, and submitted ComfyUI prompt agree on all values.
- Invalid settings fail before a GPU job is queued.
- No new SeedVR2 model variant, noise-scale control, blend control, or H3 Latent behavior is introduced by this work.
