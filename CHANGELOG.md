# Changelog

All notable changes to **TEDI Terminal Screenshot**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.2.1] - 2026-05-23

### Changed

- **Status-bar button is now icon-only.** Opts into the new TEDI core `panels[].compact: true` manifest flag (added in TEDI 0.2.20) so the auto-rendered toggle button drops its text label and `<Kbd>` chip in favour of a square 24×24 button that paints `logo.png` directly. The `aria-label` and hover tooltip still carry the panel title ("Screenshot") for accessibility, and the `Ctrl+Alt+S` shortcut still works — it just doesn't take up space on the status bar anymore.
- **Toast surfaces the save destination.** Capture toasts now read `Saved tedi-terminal-1-...png to Downloads (~/Downloads) + copied to clipboard.` on macOS / Linux, and `Saved …png to Downloads (%USERPROFILE%\Downloads) + copied to clipboard.` on Windows. Multi-pane capture says `Saved N screenshots to Downloads; first copied to clipboard.` Path is the OS default the webview uses — the extension can't query the exact path the user picked in a Save As dialog.
- **Bumped `engines.tedi` to `>=0.2.20`** because compact buttons rely on the new core manifest flag. Older TEDI builds will reject the install with a clear engines-mismatch message; downgrade the extension to 0.2.0 if you're stuck on TEDI 0.2.15-0.2.19.

## [0.2.0] - 2026-05-23

### Changed

- **Replaced the side-panel UI with a true floating dropdown.** Clicking the status-bar **Screenshot** button now opens a popover *above* the button instead of sliding the right-side workspace slot open. The dropdown lists every visible terminal pane by its FIFO `terminalOrdinal` — the same **Terminal N** badge TEDI shows next to each entry in the tab strip — plus an explicit **Capture all visible terminals** entry when there is more than one pane on screen. Each row also shows the tab's display label (`shell`, `ssh:host`, the cwd basename, …) so the user can disambiguate splits at a glance.
- **Click hijack via document capture-phase listener.** The button is still declared in `contributes.panels[surface=right]` (the only host API that paints a clickable button into the status bar), but the extension installs a document-level capture-phase `click` listener that calls `stopImmediatePropagation()` before React's bubble-phase `onClick` reaches `useRightPanelStore.toggle`. Net effect: the click opens the floating dropdown and the right-slot never appears.
- **Safety-net redirect.** If a click ever slips past the capture listener (e.g. another extension calls `panel.toggle` directly), the host mounts our panel renderer, which immediately calls `ctx.panel.close()` on the next frame and pops the dropdown anchored to the same toggle button. Either path lands the user in the same place.
- **Dropdown anchored with `right`/`bottom`** so a window resize keeps it pinned to the camera button. `Escape`, outside-click (`mousedown` capture), and selecting any entry close it.

### Added

- Per-terminal selection respects the focused terminal: the focused entry in the dropdown gets a small `focused` chip on the right so the user can pick the right pane in a split layout without guessing.
- Screenshots are now named `tedi-terminal-<N>-<YYYYMMDD-HHmmss>.png` where `N` is the same FIFO ordinal shown in the tab strip (falls back to `tedi-leaf-<id>-...` if the ordinal hasn't been backfilled yet — which only happens on legacy workspaces that pre-date TEDI 0.2.x).

### Fixed

- Panel manifest's `hideHostHeader` flipped to `true`. The host never paints its title strip now, so the brief panel-render flash during the safety-net redirect is barely perceptible (one frame, transparent border-only column).

## [0.1.0] - 2026-05-23

### Added

- Initial release. Side-panel UI with two big action buttons (**Capture focused terminal** / **Capture all visible terminals**) painted via `ctx.registerPanelRenderer` into the right-slot, plus a last-capture thumbnail. Captured PNG was auto-copied to the system clipboard via `navigator.clipboard.write` + `ClipboardItem` and offered as a browser download.
- Keybindings: `Mod+Alt+S` toggles the panel, `Mod+Alt+C` snaps the focused terminal directly. Rebindable from *Settings → Shortcuts → Extensions* under the **Terminal Screenshot** group.
- Requires TEDI **>= 0.2.15** for the `ctx.registerPanelRenderer` host API and the `surface: "right"` panel contribution; older builds surface a single warning toast at activate and stay idle so disable/uninstall still tears down cleanly.
