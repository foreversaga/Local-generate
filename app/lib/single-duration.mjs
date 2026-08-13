/**
 * Single-render duration limits shared by the UI and bridge.
 *
 * The runtime keeps accepting the historical 0.5-second lower bound for
 * backwards compatibility (and for long-video segment reuse). The Single
 * Create UI exposes the narrower 2-second lower bound that it has always
 * shown, while both layers share the 60-second upper bound.
 */
export const SINGLE_RENDER_DURATION_DEFAULT_SECONDS = 5;
export const SINGLE_RENDER_DURATION_UI_MIN_SECONDS = 2;
export const SINGLE_RENDER_DURATION_RUNTIME_MIN_SECONDS = 0.5;
export const SINGLE_RENDER_DURATION_MAX_SECONDS = 60;
export const SINGLE_RENDER_DURATION_STEP_SECONDS = 0.5;
