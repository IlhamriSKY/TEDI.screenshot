// Capture orchestration: spawns the helper, waits for it to exit, decodes the
// PNG, copies it to the clipboard, and triggers a download. This is the single
// entry the click path, the keybinding, and the panel-renderer safety net all
// funnel through.

import { base64ToBlob, triggerDownload, tryClipboard } from "./clipboard.js";
import { getMainWindowTitle, helperPath } from "./helper.js";
import { busy, ctx, setBusy } from "./runtime.js";
import { waitForExit } from "./sidecar.js";
import { describeSaveLocation, formatStamp, safeToast } from "./ui.js";

async function runCapture() {
  if (busy) return;
  setBusy(true);
  try {
    const program = helperPath(ctx.installPath, ctx.os);
    if (!program) {
      safeToast(
        `Unsupported platform: ${ctx.os?.platform ?? "unknown"}/${ctx.os?.arch ?? "unknown"}`,
        "error",
      );
      return;
    }

    let handle;
    try {
      handle = await ctx.invoke("shell_bg_spawn_direct", {
        program,
        args: [getMainWindowTitle()],
      });
    } catch (spawnErr) {
      // Translate the two most common spawn failures into actionable
      // guidance before the generic catch block surfaces a cryptic OS
      // error string. The strings to match are stable: Tauri serializes
      // `io::Error::to_string()`, which on Windows includes "(os error 2)"
      // when the program file is missing, and on POSIX includes the
      // word "No such file or directory". Either way the user's fix is
      // the same: reinstall the extension to repopulate `sidecar/`.
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      const lower = msg.toLowerCase();
      if (
        lower.includes("os error 2") ||
        lower.includes("no such file") ||
        lower.includes("cannot find the file") ||
        lower.includes("not found")
      ) {
        const platformLabel = `${ctx.os?.platform ?? "?"}-${ctx.os?.arch ?? "?"}`;
        safeToast(
          `Screenshot helper missing for ${platformLabel}. Reinstall the Screenshot extension to repopulate sidecar/. (${msg})`,
          "error",
        );
        ctx?.logger?.error?.("helper binary missing", { program, err: spawnErr });
        return;
      }
      // Permission / IPC errors from the host. Re-throw to land in the
      // generic catch so the user still gets a toast - but tag the
      // command so future debugging is easier.
      throw new Error(`shell_bg_spawn_direct: ${msg}`);
    }

    const { stdout, stderr, exitCode } = await waitForExit(handle);

    if (exitCode !== 0) {
      const trail = (stderr || stdout).trim();
      safeToast(
        trail
          ? `Capture failed (exit ${exitCode ?? "?"}): ${trail}`
          : `Capture failed with exit ${exitCode ?? "?"}.`,
        "error",
      );
      return;
    }

    const b64 = stdout.trim();
    if (!b64) {
      safeToast("Capture returned empty output.", "error");
      return;
    }

    const blob = base64ToBlob(b64, "image/png");
    const name = `tedi-${formatStamp(new Date())}.png`;

    await tryClipboard(blob);
    triggerDownload(blob, name);

    safeToast(
      `Saved ${name} to ${describeSaveLocation()} + copied to clipboard.`,
      "success",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx?.logger?.error?.("capture failed", err);
    safeToast(`Capture failed: ${msg}`, "error");
  } finally {
    setBusy(false);
  }
}

export { runCapture };
