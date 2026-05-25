# Changelog

All notable changes to **Screenshot** (formerly *TEDI Terminal Screenshot*). Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

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
