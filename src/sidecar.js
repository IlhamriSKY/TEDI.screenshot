// Sidecar process lifecycle: drives the spawned helper to completion by polling
// `shell_bg_logs`, accumulating its stdout and surfacing the exit code.

import { ctx, SPAWN_TIMEOUT_MS, POLL_INTERVAL_MS } from "./runtime.js";

/**
 * Polls `shell_bg_logs` until the helper exits or the timeout fires.
 * Accumulates stdout across polls (the host buffer drains by offset, so
 * each call returns only new bytes). stderr is currently muxed into the
 * same buffer; we keep it as a single string for the toast surface.
 */
async function waitForExit(handle) {
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  let offset = 0;
  let stdout = "";
  while (true) {
    if (Date.now() > deadline) {
      try {
        await ctx.invoke("shell_bg_kill", { handle });
      } catch {
        // ignore - already dead or never spawned cleanly
      }
      throw new Error("capture timed out");
    }
    const resp = await ctx.invoke("shell_bg_logs", { handle, sinceOffset: offset });
    if (resp.bytes) stdout += resp.bytes;
    offset = typeof resp.next_offset === "number" ? resp.next_offset : offset;
    if (resp.exited) {
      return {
        stdout,
        // shell_bg_logs muxes stderr into the same stream; we return the
        // accumulated text under both fields so the caller can surface
        // whichever exists.
        stderr: "",
        exitCode: typeof resp.exit_code === "number" ? resp.exit_code : null,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { waitForExit, sleep };
