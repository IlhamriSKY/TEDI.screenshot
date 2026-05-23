# TEDI Terminal Screenshot

Companion extension for [TEDI](https://github.com/IlhamriSKY/TEDI) that
adds a **Screenshot** button to the status-bar right cluster (next to
**Open AI Agent**). Click it to drop a small picker right above the
button — pick a specific terminal by its tab number, or capture every
visible pane in one go. The resulting PNG is copied to your clipboard
*and* offered as a download, so you can paste it straight into a chat
or save it to disk.

<p align="center">
  <img src="logo.png" alt="Terminal Screenshot" width="128" />
</p>

> [!NOTE]
> The button auto-appears in the status bar's right cluster the moment
> the extension activates — no manual layout wiring. A default shortcut
> `Mod+Alt+S` opens the dropdown; `Mod+Alt+C` captures the focused
> terminal without opening it (`C` for camera). Both are rebindable
> from *Settings → Shortcuts → Extensions* under the **Terminal
> Screenshot** group; the defaults were picked to avoid TEDI core's
> `Mod+Alt+P` (new preview tab) and `Mod+Shift+P` (search files).

---

## Install

In TEDI:

1. Open **Settings → Extensions**.
2. Switch to the **From GitHub** tab.
3. Paste `IlhamriSKY/TEDI.terminal-screenshot` (or the full URL).
4. Click **Review → Install**.

That's it. No manual settings to flip. The extension registers a
command + button hijack with TEDI's generic extension API at activate;
from then on the **Screenshot** button in the status bar opens the
dropdown until you disable or uninstall.

TEDI hits `releases/latest` on this repo, downloads the `.zip` asset
produced by the [release workflow](.github/workflows/release.yml), runs
its standard install pipeline (size cap, path-traversal guard, manifest
validation, fingerprint), and activates the extension. The card with
this README's logo appears in Settings → Extensions; the card-level
Switch is the only on/off control.

### Updating

The same Settings → Extensions screen has a **Check updates** button.
TEDI compares `tag_name` of the latest GitHub release against the
installed `manifest.version`. If newer, an **Update** button re-runs
the install pipeline against the new release. No manual download.

---

## The dropdown

```
┌─────────────────────────────────────┐
│  Capture all visible terminals      │
│  3 panes                            │
├─────────────────────────────────────┤
│  1   Terminal 1            focused  │
│      ~/projects/tedi                │
│                                     │
│  2   Terminal 2                     │
│      ssh:prod.example.com           │
│                                     │
│  3   Terminal 3                     │
│      ~/scratch                      │
└─────────────────────────────────────┘
                                  ▲
                              [Screenshot]   ← status-bar button
```

The numbers on the left of each row are the **same `terminalOrdinal`
values TEDI shows on its tab badges** — the FIFO chips persisted in
the workspace store, identical to what the AI sees inside its per-turn
`<env>` block. They survive split, reorder, move-to-group, and even a
full workspace restart, so "Terminal 3" today is the same shell as
"Terminal 3" was yesterday.

The right-hand `focused` chip marks the pane the cursor is currently
in. The "Capture all visible terminals" entry only appears when there
is actually more than one pane on screen (with a single terminal it
would just duplicate the entry below).

Captured PNGs land in two places at once:

- **Clipboard** — paste straight into Discord / Slack / a doc / an
  issue. With multi-pane capture, the first frame is copied so you
  always have a one-paste fallback.
- **Downloads** — one file per pane, named
  `tedi-terminal-<N>-<YYYYMMDD-HHmmss>.png` where `N` matches the
  Terminal ordinal in the dropdown.

---

## How it works

TEDI's host doesn't ship a "status-bar popover" API — only
right-side panels — but a `surface: "right"` panel is the *only* way
to get a clickable button auto-rendered in the status bar. So the
extension uses the panel mechanism for the button but redirects every
click to a real floating dropdown:

```
TEDI status bar
    │
    │  click "Screenshot"
    ▼
document.addEventListener("click", ..., true)
    │  (capture phase; runs BEFORE React's bubble-phase onClick)
    │  e.target.closest('footer button[aria-label="Screenshot"]')
    ▼
event.stopImmediatePropagation()    ← block useRightPanelStore.toggle
    │
    ▼
showDropdown(button)
    │
    │  position: fixed, right + bottom anchored to the button
    │  list: enumerate [data-terminal-leaf-id] visible panes
    │  ordinal: map leafId → terminalOrdinal via TabsTrigger DOM
    ▼
on row click → captureElement(<the matching DOM node>)
    │
    ├── navigator.clipboard.write([ClipboardItem({ "image/png": blob })])
    └── <a href="blob:..." download="tedi-terminal-<N>-<stamp>.png">
```

The click-hijack works because React 18 attaches its synthetic event
handlers on the root container in the **bubble** phase, while we
listen at `document` in the **capture** phase — capture runs first,
and `stopImmediatePropagation()` aborts the bubble dispatch before
React's `onClick` (which would call `useRightPanelStore.toggle`) ever
sees the event.

### Safety-net redirect

If a click somehow slips past the capture listener (e.g. another
extension calls `panel.toggle("screenshot")` directly, or the user's
device fires synthetic events that bypass the document phase), the
host still mounts the panel renderer registered with
`ctx.registerPanelRenderer`. That renderer renders a one-line
"Opening the Screenshot menu…" note, schedules
`ctx.panel.close()` for the next animation frame, and then shows the
dropdown anchored to the toggle button. Net effect: even the fallback
path lands the user in the dropdown, just one frame later.

### What "visible" means

`TerminalPane` toggles inline `visibility: hidden` on panes that
belong to inactive tabs, and an xterm WebGL buffer goes stale the
moment its host element is hidden. To avoid capturing blank frames,
the dropdown filters on `style.visibility !== "hidden"` plus a
bounding-rect sanity check. Translation: you get every split pane on
the currently active tab, not every pane in the entire workspace.

If you need a frozen shot of a background tab, switch to that tab
first; the WebGL buffer refreshes on the same frame, and a follow-up
capture lands the real content.

### Saving the file

The webview is in charge of the actual save:

- **Windows (WebView2)** — Edge's "Save As" prompt appears.
- **macOS (WKWebView)** — silently routes to `~/Downloads`.
- **Linux (WebKitGTK)** — silently routes to `~/Downloads` (or the
  XDG `XDG_DOWNLOAD_DIR` if configured).

If the webview refuses the download for any reason, the PNG is still
on the clipboard — paste it anywhere that accepts images.

---

## Permissions

Declared in `manifest.json`:

```json
"permissions": [
  "panels:register",
  "ui:toast"
]
```

| Permission                  | What it lets the extension do                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `panels:register`           | Register a runtime renderer for the right-surface panel declared in `contributes.panels[]`. The host auto-renders the matching status-bar toggle button from the manifest. The renderer itself is only a safety-net redirect — the visible UI is a `document.body`-mounted floating dropdown. |
| `ui:toast`                  | Surface capture results ("Captured tedi-terminal-1-...png.", "Capture produced an empty image", etc).        |

No filesystem, secret-keychain, network, or shell permissions are
requested. Capture goes through the DOM; persistence goes through the
clipboard + the webview's own download mechanism.

---

## Compatibility

Requires TEDI **>= 0.2.15** for the `ctx.registerPanelRenderer` host
API and the `surface: "right"` panel contribution. Older TEDI builds
fire a single warning toast at activate, name the missing API, and
stay idle so disable / uninstall still tears down cleanly.

The capture path itself relies on three browser features all current
TEDI webviews ship:

- `<canvas>.drawImage(otherCanvas)` for cross-canvas composite.
- `ClipboardItem` + `navigator.clipboard.write` for image clipboard.
- HTML5 anchor `download` attribute with `blob:` URLs.

---

## Local development

```bash
git clone https://github.com/IlhamriSKY/TEDI.terminal-screenshot.git
cd TEDI.terminal-screenshot

# Package + install into TEDI to test:
zip dev.zip manifest.json extension.js logo.png README.md CHANGELOG.md LICENSE
# In TEDI: Settings → Extensions → From file → dev.zip
```

After install, watch TEDI's dev-tools console (`Ctrl+Shift+I`) for
`[ext:tedi.terminal-screenshot]` log lines (capture warnings, clipboard
errors, fallback redirects).

Cut a release with a `vX.Y.Z` tag — the bundled
[`.github/workflows/release.yml`](.github/workflows/release.yml)
asserts the tag matches `manifest.version`, zips
`manifest.json + extension.js + logo.png + README.md + CHANGELOG.md +
LICENSE`, and uploads to the GitHub release that TEDI's installer
reads from `releases/latest`.

```bash
git tag v0.2.0
git push origin v0.2.0
```
