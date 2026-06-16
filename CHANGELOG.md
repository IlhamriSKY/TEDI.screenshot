# Changelog

All notable changes to **Screenshot** (formerly *TEDI Terminal Screenshot*). Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.5.5] - 2026-06-16

### Changed

- **Internal refactor.** The single `src/index.js` is split into small, cohesive modules (each ≤ 300 lines), matching the project's module convention. No behaviour change — the built `extension.js` is functionally identical (verified: same string-literal set, same exports).

## [0.5.4] - 2026-06-16

### Changed

- **Build pipeline.** The extension is now authored as `src/index.js` and bundled into `extension.js` with esbuild (`npm run build`); the built bundle is **no longer committed** — CI (`release.yml`) builds it into the release `.zip` that users install. No behaviour change. CI actions bumped to `@v5` (Node 24).

## [0.5.3] - 2026-05-28

### Changed

- **`engines.tedi` raised to `>=0.3.9`.** The host now enforces this constraint at install time, so older TEDI builds refuse to install the extension and surface a "needs TEDI X.Y.Z" message rather than letting it run against a host that predates the current API surface.

## [0.5.2] - 2026-05-26

### Changed

- **Manifest description trimmed.** Reduced to the same "what + how" one-liner the other reference extensions use, so the *Settings → Extensions → From GitHub* install dialog reads cleanly when this card sits alongside SQL Explorer / Beautify / Discord Rich Presence. No runtime behaviour change; the sidecar binary is identical to 0.5.1.

## [0.5.1] - 2026-05-26

### Changed

- **Actionable toast when the helper binary is missing.** Wrapped the `ctx.invoke("shell_bg_spawn_direct")` call in `runCapture` with its own try/catch. If the spawn fails with a "file not found" style error (Windows `"(os error 2)"`, POSIX `"No such file or directory"`, etc.), the user now sees a clear "Screenshot helper missing for `<platform>-<arch>`. Reinstall the Screenshot extension to repopulate `sidecar/`." toast instead of the cryptic raw OS string. Other spawn failures (permission, IPC) are re-thrown with the command name tagged so the catch block higher up still reports them, just with more context. Same UX a half-broken install would hit when the sidecar dir was wiped or the platform tuple does not match any bundled binary.

## [0.5.0] - 2026-05-25

### Changed

- **Migrated native window-capture from a TEDI-core Tauri command to an extension-owned sidecar.** v0.4.0 put `xcap` + `image` directly in TEDI core's `Cargo.toml` and exposed `app_capture_window` as a host IPC command - the extension just called `ctx.invoke("app_capture_window")`. That left screenshot-specific native deps (and the Linux `libpipewire-0.3-dev` build requirement) sitting in the core binary forever, even for users who never install this extension. v0.5.0 ships its own `sidecar/<platform>-<arch>/tedi-screenshot-helper` binary built per-platform in this repo's release CI (mirroring the `tedi.discord-rich-presence` pattern), and the extension spawns the helper per click via `invoke:shell_bg_spawn_direct`. Core stays generic; uninstalling this extension removes every native dep with it.
- **Permission set updated.** Manifest drops `invoke:app_capture_window` (no longer exists in core) and adds `invoke:shell_bg_spawn_direct` / `invoke:shell_bg_logs` / `invoke:shell_bg_kill` - the generic background-process API the sidecar architecture needs. Same affordances as the Discord extension; the install dialog flags these as medium-risk.
- **Helper output transport is base64-over-stdout.** TEDI's `shell_bg_logs` reads child output via `String::from_utf8_lossy`, so raw PNG bytes would not survive intact. The helper base64-encodes the PNG before writing it to stdout; extension.js decodes and feeds the resulting `Blob` into the clipboard + download path. Adds ~33% to stdout volume vs raw bytes; on a typical 1920x1080 screenshot that's roughly 700 KB encoded - well under the 4 MiB log buffer cap.

### Added

- **`sidecar-src/`** sub-project: small Rust crate with `xcap = "0.9"` + `image = "0.25"` + `base64 = "0.22"` deps. Built per (target_os, target_arch) by the new release workflow; the resulting binary is staged into `sidecar/<platform>-<arch>/` and bundled into the release zip alongside `manifest.json` / `extension.js` / `logo.png`.
- **Release CI rewritten** to mirror `tedi.discord-rich-presence`: matrix-builds the sidecar across `windows-latest` / `macos-latest` (x86_64 + aarch64) / `ubuntu-latest`, uploads each as an artifact, then a second job downloads all four, flattens the layout, zips the runtime tree, and uploads to the GitHub release. Ubuntu step adds `libpipewire-0.3-dev` + `libdbus-1-dev` for xcap's Wayland xdg-desktop-portal path.

## [0.4.0] - 2026-05-25

### Changed

- **Renamed extension from `tedi.terminal-screenshot` to `tedi.screenshot`.** Manifest `id`, display `name`, repository (`IlhamriSKY/TEDI.screenshot`), and command IDs all drop the `terminal-` segment while keeping the `tedi.` namespace prefix. Existing installs need to be uninstalled and re-installed once because TEDI keys extensions by manifest `id`; there is no in-place rename path.
- **Rewrote the capture pipeline to a native window grab.** The previous version composited xterm.js canvases on the JS side and tried to coax the WebGL renderer into a fresh draw before reading pixels. That worked most of the time but still hit black frames whenever the drawing buffer was reclaimed mid-capture. v0.4.0 delegates to the host's new `app_capture_window` Tauri command, which calls `xcap` to grab the OS-composited window (WebView2 `PrintWindow` on Windows, CGWindowList on macOS, XCB / pipewire-portal on Linux). The pixels we save are the exact pixels the user sees - no repaint dance, no preserveDrawingBuffer trick.
- **Status-bar button is a single one-shot trigger.** The per-tab dropdown (with `Terminal N` rows + `Capture all visible terminals`) is gone. Click the camera icon or press `Ctrl+Alt+S` and you get one PNG of the whole TEDI window. The dropdown made sense when capture was DOM-scoped to a single pane; with whole-window capture there is nothing left to disambiguate.
- **Single command + single keybinding.** Manifest now ships `tedi.screenshot.capture` (default `Mod+Alt+S`). The previous `tedi.terminal-screenshot.toggle` / `captureActive` / `captureAll` commands are removed - they all collapsed into the same action.
- **Added `invoke:app_capture_window` permission.** Required to call the new host command. The install dialog will flag this as a medium-risk permission.

### Removed

- Per-pane DOM compositing helpers (`enumerateTerminals`, `captureElement`, wallpaper compositor, ResizeObserver nudge) - replaced by the single `ctx.invoke("app_capture_window")` call. Extension dropped from ~880 LoC to ~200.

## [0.3.0] - 2026-05-25

### Fixed

- **Capture no longer produces a solid-black PNG.** Root cause: TEDI's terminal renderer is xterm.js's WebGL addon, which sets `preserveDrawingBuffer: false` upstream (a performance trade-off). After the browser composites a frame, the WebGL buffer is gone - and `drawImage(webglCanvas)` on a subsequent tick reads zero pixels. With nothing painted underneath, the resulting PNG was uniformly black. The capture pipeline now dispatches a synthetic `resize` event before reading (which forces xterm's ResizeObserver-driven redraw to issue a fresh draw call) and waits two animation frames before `drawImage` so we're inside the live frame where the buffer still holds visible pixels.

### Added

- **Wallpaper-aware capture.** When the user has a theme background set (TEDI 0.2.23's `#tedi-bg-layer`), the screenshot now paints the wallpaper underneath the terminal cells first, mirroring what's actually on screen. Reads the CSS `background-image: url(...)`, computes the same `background-size: cover` placement the live layer uses, applies the configured blur via `ctx.filter`, and reapplies the darken overlay extracted from the layer's `linear-gradient`. Cross-origin images load with `crossOrigin = "anonymous"` so a CDN-hosted wallpaper doesn't taint the canvas; if it does throw (e.g. server refuses CORS), the wallpaper layer is skipped silently and the terminal background colour takes over.
- **Theme-respecting cell background.** The fill colour painted under the canvases is read from the terminal element's computed `background-color`, so it follows the active custom theme. When that colour resolves to transparent and a wallpaper is set, the fill is skipped entirely - `--tedi-canvas-alpha` < 1 makes the wallpaper bleed through identically to the live UI.

## [0.2.1] - 2026-05-23

### Changed

- **Status-bar button is now icon-only.** Opts into the new TEDI core `panels[].compact: true` manifest flag (added in TEDI 0.2.20) so the auto-rendered toggle button drops its text label and `<Kbd>` chip in favour of a square 24×24 button that paints `logo.png` directly. The `aria-label` and hover tooltip still carry the panel title ("Screenshot") for accessibility, and the `Ctrl+Alt+S` shortcut still works - it just doesn't take up space on the status bar anymore.
- **Toast surfaces the save destination.** Capture toasts now read `Saved tedi-terminal-1-...png to Downloads (~/Downloads) + copied to clipboard.` on macOS / Linux, and `Saved …png to Downloads (%USERPROFILE%\Downloads) + copied to clipboard.` on Windows. Multi-pane capture says `Saved N screenshots to Downloads; first copied to clipboard.` Path is the OS default the webview uses - the extension can't query the exact path the user picked in a Save As dialog.
- **Bumped `engines.tedi` to `>=0.2.20`** because compact buttons rely on the new core manifest flag. Older TEDI builds will reject the install with a clear engines-mismatch message; downgrade the extension to 0.2.0 if you're stuck on TEDI 0.2.15-0.2.19.

## [0.2.0] - 2026-05-23

### Changed

- **Replaced the side-panel UI with a true floating dropdown.** Clicking the status-bar **Screenshot** button now opens a popover *above* the button instead of sliding the right-side workspace slot open. The dropdown lists every visible terminal pane by its FIFO `terminalOrdinal` - the same **Terminal N** badge TEDI shows next to each entry in the tab strip - plus an explicit **Capture all visible terminals** entry when there is more than one pane on screen. Each row also shows the tab's display label (`shell`, `ssh:host`, the cwd basename, …) so the user can disambiguate splits at a glance.
- **Click hijack via document capture-phase listener.** The button is still declared in `contributes.panels[surface=right]` (the only host API that paints a clickable button into the status bar), but the extension installs a document-level capture-phase `click` listener that calls `stopImmediatePropagation()` before React's bubble-phase `onClick` reaches `useRightPanelStore.toggle`. Net effect: the click opens the floating dropdown and the right-slot never appears.
- **Safety-net redirect.** If a click ever slips past the capture listener (e.g. another extension calls `panel.toggle` directly), the host mounts our panel renderer, which immediately calls `ctx.panel.close()` on the next frame and pops the dropdown anchored to the same toggle button. Either path lands the user in the same place.
- **Dropdown anchored with `right`/`bottom`** so a window resize keeps it pinned to the camera button. `Escape`, outside-click (`mousedown` capture), and selecting any entry close it.

### Added

- Per-terminal selection respects the focused terminal: the focused entry in the dropdown gets a small `focused` chip on the right so the user can pick the right pane in a split layout without guessing.
- Screenshots are now named `tedi-terminal-<N>-<YYYYMMDD-HHmmss>.png` where `N` is the same FIFO ordinal shown in the tab strip (falls back to `tedi-leaf-<id>-...` if the ordinal hasn't been backfilled yet - which only happens on legacy workspaces that pre-date TEDI 0.2.x).

### Fixed

- Panel manifest's `hideHostHeader` flipped to `true`. The host never paints its title strip now, so the brief panel-render flash during the safety-net redirect is barely perceptible (one frame, transparent border-only column).

## [0.1.0] - 2026-05-23

### Added

- Initial release. Side-panel UI with two big action buttons (**Capture focused terminal** / **Capture all visible terminals**) painted via `ctx.registerPanelRenderer` into the right-slot, plus a last-capture thumbnail. Captured PNG was auto-copied to the system clipboard via `navigator.clipboard.write` + `ClipboardItem` and offered as a browser download.
- Keybindings: `Mod+Alt+S` toggles the panel, `Mod+Alt+C` snaps the focused terminal directly. Rebindable from *Settings → Shortcuts → Extensions* under the **Terminal Screenshot** group.
- Requires TEDI **>= 0.2.15** for the `ctx.registerPanelRenderer` host API and the `surface: "right"` panel contribution; older builds surface a single warning toast at activate and stay idle so disable/uninstall still tears down cleanly.
