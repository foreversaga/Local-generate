# MiniMax Design-style Workspace integration plan

Status: implemented on `agent/minimax-design-workspace`; all eight phases are covered by the Workspace MVP and regression tests.

## Goal

Evolve H3 Studio from a collection of generation forms into a project-based local creation workspace while preserving the existing `/app` routes, generation payloads, Jobs polling semantics, Library APIs, and local ComfyUI/Ollama/Codex/Vast topology.

The design principle is progressive disclosure: the canvas shows the creation flow, a selected node exposes only its relevant settings in the Inspector, Jobs owns execution history, and Library owns reusable assets.

## Phase 1 — Project and workflow domain

### Functions

- Introduce a versioned `WorkflowProject` persisted locally.
- Store project name, brief, nodes, edges, assets, checkpoints, timestamps, and project version.
- Provide a deterministic starter graph: `Brief → Prompt → H3 Video → Output`.
- Add storage functions for list/get/save/delete with corrupt-data tolerance and recency ordering.
- Keep the storage implementation behind a small adapter that accepts the browser Storage interface.

### Benefit

Generation becomes resumable project work instead of isolated form submissions. Later Canvas, Agent, Skills, Jobs, and Asset Dock features can share one stable domain model.

### Acceptance

- Creating a project produces a valid starter graph.
- Updating the brief keeps the Brief node synchronized.
- Projects survive page reloads.
- Invalid local data does not break Create.

## Phase 2 — Extract reusable Single generation controller

### Functions

- Centralize Single mode defaults, compatible model profiles, render validation, Ref2V normalization, batching, and bridge request construction in `single-create-controller.mjs`.
- Keep the existing Single page on its proven UI/hydration implementation while locking it to the same lower-level request and validation contracts used by the controller.
- Cover parity-critical mode defaults, request semantics, batching, and Ref2V Motion normalization with regression tests.

### Benefit

Canvas can reuse the existing Single generation contract without cloning backend semantics or changing the stable Single page behavior.

### Acceptance

- Existing Single flow sends the same request payloads as before.
- Existing draft hydration and successful-submit cleanup remain unchanged.
- Workspace controller request semantics are regression-tested against the same request/validation helpers used by Single.

## Phase 3 — Brief-first Create landing

### Functions

- Put a project brief composer at the top of Create.
- Create a Workspace directly from natural-language intent.
- Show recent local projects.
- Keep Single and Long as explicit Quick Start flows.
- Keep asset-first and tool entry points below the main project action.

### Benefit

Users can start from “what I want to create” instead of needing to understand T2V/I2V/Ref2V/FL2V terminology before entering the product.

### Acceptance

- Empty brief cannot create a project.
- A created project opens its Workspace immediately.
- Existing Single, Long, asset-first, Tools, and Jobs links still work.

## Phase 4 — Workflow Canvas

### Functions

- Add the project Workspace route and canvas surface.
- Render nodes, connections, selection, node status, and project title.
- Add drag, connect, delete, duplicate, zoom/pan, multiselect, undo/redo, and persisted node positions.
- Introduce node registry entries for Brief, Asset, Prompt, H3 Video, OpenPose, Upscale, and Output.
- Add graph validation so incompatible connections are rejected before execution.

### Benefit

The complete generation flow is visible. Users can identify where a complex pipeline failed without navigating through multiple pages.

### Acceptance

- Graph edits persist after reload.
- Invalid node connections are blocked with a local explanation.
- Canvas state changes do not alter existing backend contracts.

## Phase 5 — Canvas and Jobs integration

### Functions

- Add a workflow job adapter that maps existing normalized Jobs onto node execution state.
- Display queued/running/progress/ETA/complete/error directly on nodes.
- Support Cancel/Retry where the existing backend already supports those actions.
- Add a compact Workspace Activity strip while leaving `/app/jobs` as the full execution history.

### Benefit

Users remain in the project while generation runs. Jobs retains its role as the system-level queue/history instead of becoming the primary creation UI.

### Acceptance

- A running existing Job can be reflected on its source node.
- Node progress matches normalized Jobs data.
- No second queue or polling implementation is introduced.

## Phase 6 — Library Asset Dock

### Functions

- Embed a compact project Asset Dock backed by existing Library APIs.
- Support drag/drop from assets to Canvas to create typed Asset nodes.
- Add semantic roles such as Character, Face, Clothing, Pose, Scene, Video, Audio, and Output without changing the underlying file APIs.
- Register node outputs back into the Library and current project.

### Benefit

References become reusable project assets rather than files that must be repeatedly selected in every form.

### Acceptance

- Existing Library remains the full management page.
- Asset Dock never creates a second storage location.
- Outputs are visible in both project context and Library.

## Phase 7 — Node Inspector and progressive settings

### Functions

- Move per-node configuration into the right Inspector.
- Show only essential fields by default.
- Keep Advanced sections closed until explicitly enabled or a persisted non-default value requires them.
- Prompt node owns provider/model/skill controls.
- H3 node owns mode/model/duration/resolution plus optional LoRA/seed/steps/memory controls.
- Asset node owns role and reference metadata.

### Benefit

The main workspace stops exposing dozens of unrelated controls at once. Settings are contextual to the selected node and optional controls remain hidden until needed.

### Acceptance

- Selecting a node changes Inspector content without changing graph state.
- Hidden invalid fields open automatically when validation requires user action.
- Numeric fields continue to allow an empty editing state as required by `AGENTS.md`.

## Phase 8 — Review checkpoints and Agent/Skill orchestration

### Functions

- Add checkpoint records for important transitions such as generated prompt, render-ready graph, generated media, and pre-upscale output.
- Support Approve, Edit, Regenerate, and Restore.
- Add a planner interface that can convert Brief + assets into graph changes.
- Integrate Hermes/Skills behind the planner and Prompt nodes rather than creating a separate Hermes page.
- Require explicit review checkpoints for high-cost downstream generation when configured.

### Benefit

Bad prompts or incorrect references can be corrected before expensive GPU work continues. Agent behavior becomes inspectable and reversible rather than an opaque one-shot action.

### Acceptance

- Restoring a checkpoint restores graph/config references without deleting historical Jobs.
- Agent-generated graph changes remain editable before execution.
- Skills are reusable by Prompt/Planner nodes without duplicating generation APIs.

## Implementation checkpoints

1. **Checkpoint A — foundation:** Phase 1 + Brief-first entry + Workspace skeleton.
2. **Checkpoint B — controller:** Phase 2 with parity tests against current Single request/validation behavior.
3. **Checkpoint C — interactive canvas:** Phase 4 interaction layer and persisted graph edits.
4. **Checkpoint D — execution:** Phase 5 node/Jobs integration.
5. **Checkpoint E — assets and inspector:** Phase 6 + Phase 7.
6. **Checkpoint F — orchestration:** Phase 8 Agent/Skill/checkpoint behavior.

## Non-breaking constraints

- Preserve `/app` base path.
- Preserve existing `/app/api/generate` payload and polling semantics.
- Preserve existing sequence draft shape/hydration for Long.
- Do not expose ComfyUI or Ollama beyond loopback.
- Do not change Tailscale Serve.
- Do not duplicate Jobs or Library backend ownership.
- Production build is run only once after the current implementation checkpoint is complete.

## Implementation result

- Phase 1: versioned local project storage and starter graph implemented.
- Phase 2: `single-create-controller.mjs` is the canonical Workspace render controller and is locked to the legacy Single request/validation helpers by parity tests, so Canvas and Single preserve the same bridge payload semantics without rewriting the large legacy form during this MVP.
- Phase 3: Brief-first Create landing and recent projects implemented.
- Phase 4: interactive persisted Canvas implemented.
- Phase 5: existing Jobs feed is bound to nodes without a second queue.
- Phase 6: Library-backed Asset Dock and semantic roles implemented.
- Phase 7: contextual Inspector with progressive settings implemented.
- Phase 8: review checkpoints, Hermes Prompt provider, skill discovery, and allow-listed Brief-to-graph planning implemented. Agent plans remain editable/reversible and create an `agent-plan` checkpoint.

Hosted CI validates application contracts without requiring local GPU/model daemons. Set `H3_STUDIO_REQUIRE_LOCAL_SERVICES=1` when running `npm run web:smoke` on the real local host to additionally require ComfyUI and Ollama to be online.
