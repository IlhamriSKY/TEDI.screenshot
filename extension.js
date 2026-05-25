// Screenshot - one-click whole-window capture via a native sidecar.
//
// Architecture: the heavy lifting lives in `sidecar/<platform>-<arch>/
// tedi-screenshot-helper`, a small Rust binary that links xcap + image.
// The extension JS layer:
//
//   1. picks the helper binary for the current OS / arch from `ctx.os`
//   2. spawns it once per capture via `shell_bg_spawn_direct` with the
//      TEDI window title as the only argv (no shell wrapper - the
//      tracked PID is the helper itself so kill cleanly terminates it)
//   3. polls its stdout via `shell_bg_logs` until the process exits
//   4. decodes the base64 PNG, copies to the clipboard, and triggers
//      a download
//
// Why sidecar (instead of a TEDI-core Tauri command): keeps screenshot-
// specific native deps (xcap + image + libpipewire on Linux) inside the
// extension's release artifact. The TEDI core binary stays generic;
// uninstalling the extension removes every native dep with it. Same
// architectural pattern as tedi.discord-rich-presence.
//
// Output transport is base64 over stdout because the host's
// `shell_bg_logs` reads child output as `String::from_utf8_lossy` -
// raw PNG bytes would be corrupted by the lossy UTF-8 conversion.

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

let ctx = null;
let captureHandler = null;
let busy = false;

function platformDir(os) {
  const arch = os.arch || "x86_64";
  if (os.platform === "windows") {
    return arch === "aarch64" ? "windows-aarch64" : "windows-x86_64";
  }
  if (os.platform === "macos") {
    return arch === "aarch64" ? "macos-aarch64" : "macos-x86_64";
  }
  if (os.platform === "linux") {
    return arch === "aarch64" ? "linux-aarch64" : "linux-x86_64";
  }
  return null;
}

function helperPath(installPath, os) {
  if (typeof installPath !== "string" || !installPath) return null;
  if (!os || typeof os.platform !== "string") return null;
  const dir = platformDir(os);
  if (!dir) return null;
  const exe = os.platform === "windows" ? "tedi-screenshot-helper.exe" : "tedi-screenshot-helper";
  return `${installPath.replace(/\\/g, "/")}/sidecar/${dir}/${exe}`;
}

/** The OS-level window title xcap matches against. Tauri sets the
 *  WebView document.title from `windows[0].title` in tauri.conf.json
 *  and keeps the two in sync via title APIs, so the value the webview
 *  reads is the same string the OS sees. */
function getMainWindowTitle() {
  return (typeof document !== "undefined" && document.title) || "TEDI";
}

export async function activate(context) {
  ctx = context;

  // Probe the host APIs up front. Missing anything -> we're on an older
  // TEDI than the manifest engines constraint; surface one warning toast
  // and stay activated-but-idle so disable/uninstall still tears down
  // cleanly.
  const missing = [];
  if (typeof ctx.invoke !== "function") missing.push("ctx.invoke");
  if (typeof ctx.os?.platform !== "string") missing.push("ctx.os.platform");
  if (typeof ctx.installPath !== "string") missing.push("ctx.installPath");
  if (typeof ctx.registerPanelRenderer !== "function") missing.push("ctx.registerPanelRenderer");
  if (typeof ctx.panel?.close !== "function") missing.push("ctx.panel.close");
  if (missing.length > 0) {
    const msg = `Screenshot needs a newer TEDI (missing: ${missing.join(", ")}).`;
    ctx.logger?.warn?.(msg);
    safeToast(msg, "warning");
    return;
  }

  // Keybinding path: Mod+Alt+S. Same capture as the click path.
  ctx.registerCommandHandler(CMD_CAPTURE, async () => {
    await runCapture();
  });

  // Click path: intercept the host's auto-rendered status-bar button so
  // the click never opens the right-slot panel. Capture-phase listener
  // runs BEFORE React's bubble-phase onClick handler.
  captureHandler = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const btn = target.closest(BUTTON_SELECTOR);
    if (!btn) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    void runCapture();
  };
  document.addEventListener("click", captureHandler, true);
  ctx.addDisposer(() => {
    if (captureHandler) {
      document.removeEventListener("click", captureHandler, true);
      captureHandler = null;
    }
  });

  // Safety net for the right-panel slot. If the click ever slips past
  // captureHandler (e.g. another extension calls `panel.toggle`
  // programmatically), the host mounts this renderer. We close the panel
  // on the next frame and trigger the capture instead.
  const disposeRenderer = ctx.registerPanelRenderer(PANEL_ID, (container) => {
    container.replaceChildren();
    const note = document.createElement("div");
    note.style.padding = "16px";
    note.style.color = "var(--muted-foreground)";
    note.style.fontSize = "12px";
    note.style.lineHeight = "1.5";
    note.textContent = "Capturing TEDI window...";
    container.appendChild(note);
    requestAnimationFrame(() => {
      try {
        ctx?.panel?.close(PANEL_ID);
      } catch {
        // ignore
      }
      void runCapture();
    });
    return () => {
      try {
        container.replaceChildren();
      } catch {
        // ignore
      }
    };
  });
  ctx.addDisposer(disposeRenderer);
}

export function deactivate() {
  ctx = null;
}

async function runCapture() {
  if (busy) return;
  busy = true;
  try {
    const program = helperPath(ctx.installPath, ctx.os);
    if (!program) {
      safeToast(
        `Unsupported platform: ${ctx.os?.platform ?? "unknown"}/${ctx.os?.arch ?? "unknown"}`,
        "error",
      );
      return;
    }

    const handle = await ctx.invoke("shell_bg_spawn_direct", {
      program,
      args: [getMainWindowTitle()],
    });

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
    busy = false;
  }
}

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

function describeSaveLocation() {
  const platform = ctx?.os?.platform;
  if (platform === "windows") return "Downloads (%USERPROFILE%\\Downloads)";
  if (platform === "macos") return "Downloads (~/Downloads)";
  if (platform === "linux") return "Downloads (~/Downloads)";
  return "your Downloads folder";
}

function base64ToBlob(b64, mime) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function tryClipboard(blob) {
  if (!blob) return false;
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      return false;
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch (err) {
    ctx?.logger?.warn?.("clipboard write failed", err);
    return false;
  }
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.position = "fixed";
  a.style.left = "-9999px";
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    setTimeout(() => {
      try {
        a.remove();
      } catch {
        // ignore
      }
      URL.revokeObjectURL(url);
    }, 1500);
  }
}

function safeToast(message, variant) {
  try {
    ctx?.ui.toast(message, { variant });
  } catch {
    ctx?.logger?.info?.(message);
  }
}

function formatStamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
