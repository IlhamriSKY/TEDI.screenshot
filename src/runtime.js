// Screenshot — runtime module. Bundled into extension.js by build.mjs.
// Shared mutable singletons + app constants. Other modules import the live
// bindings for reads and call the setters here for writes (esbuild preserves
// ESM live-binding semantics across the bundle).

const PANEL_ID = "screenshot";
const PANEL_TITLE = "Screenshot";
const CMD_CAPTURE = "tedi.screenshot.capture";

/** Scoped to the status-bar `<footer>` so we don't pick up any other
 *  element that happens to carry the same aria-label. */
const BUTTON_SELECTOR = `footer button[aria-label="${PANEL_TITLE}"]`;

/** Hard cap on the spawn-to-exit wait. xcap typically returns in <500ms;
 *  15s leaves ample headroom for a slow first-time pipewire-portal prompt
 *  on Linux without leaving the user staring at a stalled UI. */
const SPAWN_TIMEOUT_MS = 15_000;

/** Poll cadence for `shell_bg_logs`. Tight enough that small captures
 *  feel synchronous; loose enough that a multi-MB stdout doesn't spin
 *  the IPC channel at 1kHz. */
const POLL_INTERVAL_MS = 80;

export { PANEL_ID, PANEL_TITLE, CMD_CAPTURE, BUTTON_SELECTOR, SPAWN_TIMEOUT_MS, POLL_INTERVAL_MS };

// ----------------------------- Module state ----------------------------------

export let ctx = null;
export let captureHandler = null;
export let busy = false;

export function setCtx(value) {
  ctx = value;
}

export function setCaptureHandler(value) {
  captureHandler = value;
}

export function setBusy(value) {
  busy = value;
}
