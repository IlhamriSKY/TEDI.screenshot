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
//
// This file is the thin entry: it wires the host into the feature modules
// (runtime/helper/sidecar/capture/clipboard/ui) and exports activate /
// deactivate, which the host imports from the bundled single file.

import { runCapture } from "./capture.js";
import { CMD_CAPTURE, PANEL_ID, ctx, setCtx } from "./runtime.js";
import { safeToast } from "./ui.js";

export async function activate(context) {
  setCtx(context);

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

  // Click path: the manifest declares this panel `kind: "action"`, so the host
  // runs `toggleCommand` on click and never opens the right-slot panel. Before
  // that existed this had to intercept its own button with a capture-phase
  // document listener, which broke whenever the host's markup moved.

  // Safety net for the right-panel slot: on an older host that ignores
  // `kind`, or if anything calls `panel.toggle` programmatically, the host
  // mounts this renderer. We close the panel on the next frame and trigger the
  // capture instead.
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
  setCtx(null);
}
