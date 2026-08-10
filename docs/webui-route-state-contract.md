# H3 Studio WebUI Route / State Contract

> Phase 1 contract. This document defines page ownership, shared state boundaries, adapters, and validation reuse for the WebUI redesign. It does not change bridge APIs or persisted long-video draft data.

## 1. Route ownership

| Route | Owns | Reads shared state | Writes shared state |
|---|---|---|---|
| `/app/create` | entry cards, recent jobs summary | recent jobs, library recent assets | none |
| `/app/create/single` | single render form, single summary | service health, assets, defaults | create render job |
| `/app/create/long` | long form, planner/timeline/segments | service health, assets, long draft | save/hydrate long draft, create/resume long job |
| `/app/jobs` | filters, history list | jobs | cancel/retry |
| `/app/jobs/[id]` | job detail, progress, outputs | selected job, assets | cancel/retry/resume |
| `/app/library` | search/filter/bulk management | assets | delete/refresh assets |
| `/app/tools/upscale` | upscale form/job state | assets, service health | submit/cancel/retry upscale |
| `/app/tools/image-to-image` | I2I form/job state | assets, service health | submit/cancel/retry I2I |
| `/app/settings` | runtime/provider/defaults | health/settings | runtime/provider/default changes |

## 2. Domain state groups

### ServiceState

```ts
interface ServiceState {
    health: Health | null;
    bridgeOnline: boolean;
    refresh(): Promise<void>;
}
```

Responsibilities:

- bridge/service availability
- Ollama/Codex/ComfyUI/runtime derived status
- runtime switch busy state

Must not contain Create form values or Library selection UI state.

### AssetState

```ts
interface AssetState {
    assets: Asset[];
    refresh(): Promise<void>;
    deleteAssets(assets: Asset[]): Promise<void>;
}
```

Responsibilities:

- normalized input/output assets
- refresh/delete operations
- reusable selectors for recent/input/output assets

Route-local UI state such as filter text, preview dialog, selected rows, picker role stays in the route/component.

### JobState

```ts
type UiJobStatus = "queued" | "running" | "complete" | "error" | "cancelled";

interface JobState {
    jobs: Job[];
    refresh(): Promise<void>;
    cancel(id: string): Promise<void>;
    retry(id: string): Promise<void>;
}
```

The UI status is normalized by an adapter. Backend status strings are not renamed at the bridge layer.

### SingleCreateState

Route-local unless explicitly persisted:

- mode
- prompt brief / prompt / negative prompt
- reference image(s), last frame, source video
- width / height / duration / steps / seed / render count
- output name
- prompt-generation transient state

Do not put these values in global app state merely to survive navigation. Autosave, if enabled, must use a typed draft persistence boundary.

### LongCreateState

Preserve existing long draft schema and hydration semantics.

Owns:

- title/input type/timeline mode
- duration/segment duration hint
- brief/negative/timeline/folder/seam
- plan/job
- long references and reference mode
- dirty/error/planning state

Migration rule: extract access behind a typed long-draft service before changing persisted shape. Persisted shape is out of scope for this redesign.

### ToolState

Upscale and I2I state belong to their tool routes. They may share generic polling primitives but must not share one giant page-level state object.

## 3. Adapter boundaries

UI route components must not duplicate raw bridge URL construction or response-shape knowledge.

Recommended modules:

```text
app/lib/api/
├─ bridge-client.ts
├─ health-api.ts
├─ assets-api.ts
├─ jobs-api.ts
├─ render-api.ts
├─ long-api.ts
├─ upscale-api.ts
└─ image-to-image-api.ts
```

`bridge-client.ts` owns base path/error decoding only. Domain adapters own typed request/response conversion.

Existing API URLs and payloads remain unchanged.

## 4. Validation contract

Validation must be pure and shared by UI gating and submit handlers.

Recommended API:

```ts
interface ValidationIssue {
    field: string;
    message: string;
}

interface SingleRenderValidationInput {
    mode: Mode;
    prompt: string;
    width: NumberDraft;
    height: NumberDraft;
    steps: NumberDraft;
    seed: NumberDraft;
    renderCount: NumberDraft;
    referenceImage: Asset | null;
    referenceImages: Asset[];
    lastFrameImage: Asset | null;
    sourceVideo: Asset | null;
}

function validateSingleRender(input: SingleRenderValidationInput): ValidationIssue[];
```

Rules must cover the same cases currently guarded inside `startRender()`:

- prompt required
- H3 prompt length
- `ref2v`: reference image(s) or source video
- `i2v`: reference image
- `fl2v`: first + last frame
- `l2v`: last frame
- `replace`: reference image + source video
- dimensions aligned to required grid
- steps/seed/render count ranges

Submit handler calls the same function again defensively.

## 5. Route shell contract

```text
AppShell
├─ DesktopSidebar
├─ TopBar
│  ├─ PageTitle
│  ├─ ServiceStatusPopover
│  └─ RecentJobsDrawer
├─ RouteContent
└─ MobileBottomNav
```

Rules:

- Desktop sidebar visible above mobile breakpoint.
- Mobile bottom nav visible at `<=768px`.
- Bottom nav has exactly five primary destinations.
- Tools child routes keep Tools active.
- `/app` resolves to `/app/create`.
- Page title derives from route, not legacy `activeNav` state.

## 6. Migration sequence

1. Add pure validation tests/functions without moving UI.
2. Introduce typed bridge/domain adapters around existing fetch calls.
3. Introduce route-aware shell while legacy Home remains reachable during migration.
4. Move Single Create first.
5. Move Long Create while preserving hydration regression tests.
6. Move Jobs.
7. Move Library and Tools.
8. Remove legacy section navigation and obsolete Home state only after route parity is verified.

This sequence minimizes simultaneous UI + API + state changes.

## 7. Test contract

Before refactor, add failing tests for:

- single render validation matrix
- status normalization
- `/app` compatibility routing
- route-to-primary-nav mapping
- picker role mapping
- long draft hydration regression

Defect fixes discovered during migration should first receive an API-level or pure-function failing test where practical.

## 8. Non-goals

Phase 1 must not:

- alter `local-bridge.mjs` payload semantics
- rename persisted job/draft fields
- change ComfyUI workflows
- change Ollama/Codex prompt behavior
- change runtime resource coordination
- rewrite long planning logic
- delete legacy UI before replacement routes achieve parity
