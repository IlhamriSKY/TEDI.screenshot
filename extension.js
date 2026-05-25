// Screenshot - captures the entire TEDI window in one click.
//
// The previous version composited xterm.js canvases on the JS side,
// which left WebGL panes black whenever the renderer's drawing buffer
// was empty for the current frame (preserveDrawingBuffer = false). This
// rewrite delegates to the host's `app_capture_window` Tauri command,
// which uses `xcap` to grab the OS-composited frame - same pixels the
// user sees, no repaint dance required.
//
// UI model: the status-bar "Screenshot" button is a single trigger. No
// dropdown, no per-tab picker. The keybinding (Mod+Alt+S) runs the same
// capture path so power users skip the click entirely.

const PANEL_ID = "screenshot";
const PANEL_TITLE = "Screenshot";
const CMD_CAPTURE = "tedi.screenshot.capture";

/** Scoped to the status-bar `<footer>` so we don't pick up any other
 *  element that happens to carry the same aria-label. */
const BUTTON_SELECTOR = `footer button[aria-label="${PANEL_TITLE}"]`;

let ctx = null;
let captureHandler = null;
let busy = false;

export async function activate(context) {
  ctx = context;

  const missing = [];
  if (typeof ctx.invoke !== "function") missing.push("ctx.invoke");
  if (typeof ctx.registerPanelRenderer !== "function") missing.push("ctx.registerPanelRenderer");
  if (typeof ctx.panel?.close !== "function") missing.push("ctx.panel.close");
  if (missing.length > 0) {
    const msg = `Screenshot needs a newer TEDI (missing: ${missing.join(", ")}).`;
    ctx.logger?.warn?.(msg);
    safeToast(msg, "warning");
    return;
  }

  // Keybinding path: Mod+Alt+S. Runs the same capture as the click.
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

  // Safety net for the right-panel slot. If the user's click ever slips
  // past `captureHandler` (e.g. another extension calls `panel.toggle`
  // programmatically), the host mounts this renderer. We close the
  // panel on the next frame and trigger the capture instead.
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
    const base64Png = await ctx.invoke("app_capture_window");
    if (typeof base64Png !== "string" || base64Png.length === 0) {
      safeToast("Capture returned an empty image.", "error");
      return;
    }
    const blob = base64ToBlob(base64Png, "image/png");
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
