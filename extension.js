// Terminal Screenshot — composites xterm.js canvas layers under each
// `[data-terminal-leaf-id]` element into a single PNG. Copies the
// result to the system clipboard and offers a blob-URL download so
// the user can save anywhere the OS file dialog lets them.
//
// UI model: clicking the status-bar "Screenshot" button opens a
// floating dropdown directly above the button (NOT the host's
// right-panel slot). The dropdown lists every visible terminal by
// its TabBar ordinal — same "Terminal N" number the user sees in the
// tab strip — plus a "Capture all" entry. The keybindings still work
// for power users who want one-shot capture without the dropdown.
//
// Why hijack the button click instead of using the panel slot?
//   * The user asked for a dropdown, not a sidebar slice. TEDI's
//     `surface: "right"` panels always open the ~22% wide right
//     slot, which is wrong here — the picker is a transient menu.
//   * The status-bar button is still auto-rendered from the
//     `contributes.panels[]` entry (no other host API exists to put
//     a clickable button there). To redirect it, we attach a
//     capture-phase click listener on `document` and call
//     `stopImmediatePropagation()` before React's bubble-phase
//     `onClick` opens the panel. As a safety net, the panel
//     renderer itself just closes the panel and re-opens the
//     dropdown — so even if the hijack misses the first click, the
//     user still ends up at the right place.
//
// Why DOM-side composition instead of a Tauri-side capture?
//   * TEDI ships no `fs_write_bytes` command and the default
//     capability does not expose `dialog:allow-save` either, so the
//     extension can't go through Rust to write binary. The webview's
//     own `<a download>` mechanism + clipboard API cover both
//     storage paths without asking the host for new permissions.
//   * The render layers we want are already in the DOM (xterm's
//     WebGL canvas + the addon selection/cursor canvases), so the
//     extension never has to ask the host for terminal access.
//
// What "visible" means here: TEDI's `TerminalPane` toggles inline
// `visibility: hidden` on inactive tabs, so hidden panes' WebGL
// buffers are stale. We only capture panes whose nearest
// `[data-terminal-leaf-id]` element is currently visible, which
// matches what the user actually sees on screen.

const PANEL_ID = "screenshot";
const PANEL_TITLE = "Screenshot";
const CMD_TOGGLE = "tedi.terminal-screenshot.toggle";
const CMD_CAPTURE_ACTIVE = "tedi.terminal-screenshot.captureActive";
const CMD_CAPTURE_ALL = "tedi.terminal-screenshot.captureAll";

/** Unique selector for the auto-rendered status-bar toggle button. The
 *  host renders the button with `aria-label={panel.title}`; scoping to
 *  the status-bar `<footer>` keeps us from picking up any other element
 *  that happens to carry the same aria-label. */
const BUTTON_SELECTOR = `footer button[aria-label="${PANEL_TITLE}"]`;

let ctx = null;
let dropdownEl = null;
let outsideHandler = null;
let keyHandler = null;
let captureHandler = null;
let resizeHandler = null;

export async function activate(context) {
  ctx = context;

  // Match the Discord / Secondary Folder Tree pattern: probe the host
  // APIs we need up front. If a method is missing the user is on an
  // older TEDI; surface one warning toast and stay activated-but-idle
  // so disable/uninstall still tears down cleanly.
  const missing = [];
  if (typeof ctx.registerPanelRenderer !== "function") missing.push("ctx.registerPanelRenderer");
  if (typeof ctx.panel?.toggle !== "function") missing.push("ctx.panel.toggle");
  if (typeof ctx.panel?.close !== "function") missing.push("ctx.panel.close");
  if (missing.length > 0) {
    const msg = `Terminal Screenshot needs a newer TEDI (missing: ${missing.join(", ")}).`;
    ctx.logger?.warn?.(msg);
    safeToast(msg, "warning");
    return;
  }

  // Toggle command: bound to `Mod+Alt+S` by the manifest. We *don't*
  // call `ctx.panel.toggle` here — that would open the right-slot.
  // Instead toggle the floating dropdown directly so the keybinding
  // path mirrors the click path.
  ctx.registerCommandHandler(CMD_TOGGLE, () => {
    toggleDropdown();
  });

  // Direct-capture commands. Wired to keybindings so power users
  // never have to open the dropdown — `Mod+Alt+C` snaps the focused
  // terminal in one keystroke.
  ctx.registerCommandHandler(CMD_CAPTURE_ACTIVE, async () => {
    await runCapture("active");
  });
  ctx.registerCommandHandler(CMD_CAPTURE_ALL, async () => {
    await runCapture("all");
  });

  // Capture-phase listener that runs BEFORE React's bubble-phase
  // onClick handler (which would open the right-slot panel). React 18
  // attaches handlers to its root container in the bubble phase, so a
  // document-level capture listener always wins.
  captureHandler = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const btn = target.closest(BUTTON_SELECTOR);
    if (!btn) return;
    // Block the host's `useRightPanelStore.toggle` so the side panel
    // never opens.
    event.stopImmediatePropagation();
    event.preventDefault();
    toggleDropdown(btn);
  };
  document.addEventListener("click", captureHandler, true);
  ctx.addDisposer(() => {
    if (captureHandler) {
      document.removeEventListener("click", captureHandler, true);
      captureHandler = null;
    }
  });

  // Reposition (or hide) the dropdown when the layout changes so it
  // never floats over the wrong spot after a window resize / panel
  // reflow.
  resizeHandler = () => {
    if (!dropdownEl) return;
    const btn = document.querySelector(BUTTON_SELECTOR);
    if (!btn) {
      closeDropdown();
      return;
    }
    positionDropdown(dropdownEl, btn);
  };
  window.addEventListener("resize", resizeHandler);
  ctx.addDisposer(() => {
    if (resizeHandler) {
      window.removeEventListener("resize", resizeHandler);
      resizeHandler = null;
    }
  });

  // Safety net for the right-panel slot. If the user's click ever
  // slips past `captureHandler` (e.g. another extension calls
  // `panel.toggle` programmatically), the host mounts this renderer.
  // We close the panel on the next frame and pop the dropdown
  // instead — same destination, one extra frame.
  const disposeRenderer = ctx.registerPanelRenderer(PANEL_ID, (container) => {
    container.replaceChildren();
    const note = document.createElement("div");
    note.style.padding = "16px";
    note.style.color = "var(--muted-foreground)";
    note.style.fontSize = "12px";
    note.style.lineHeight = "1.5";
    note.textContent =
      "Opening the Screenshot menu — look for the dropdown above the status bar.";
    container.appendChild(note);

    // Defer one frame so React finishes mounting the right slot
    // before we yank it shut, then anchor the dropdown to the now-
    // re-rendered toggle button.
    requestAnimationFrame(() => {
      try {
        ctx?.panel?.close(PANEL_ID);
      } catch {
        // ignore
      }
      const btn = document.querySelector(BUTTON_SELECTOR);
      if (btn instanceof HTMLElement) showDropdown(btn);
    });

    return () => {
      try {
        container.replaceChildren();
      } catch {
        // ignore — host clears the host-owned wrapper too anyway.
      }
    };
  });
  ctx.addDisposer(disposeRenderer);
}

export function deactivate() {
  closeDropdown();
  ctx = null;
}

/* ------------------------------------------------------------------ */
/* Dropdown                                                           */
/* ------------------------------------------------------------------ */

function toggleDropdown(anchor) {
  if (dropdownEl) {
    closeDropdown();
    return;
  }
  const btn = anchor instanceof HTMLElement ? anchor : document.querySelector(BUTTON_SELECTOR);
  if (!(btn instanceof HTMLElement)) {
    // Button hasn't mounted yet (extension just activated, status
    // bar still rendering). Direct-capture the focused terminal as
    // a useful fallback so the keystroke isn't wasted.
    void runCapture("active");
    return;
  }
  showDropdown(btn);
}

function showDropdown(anchor) {
  closeDropdown();

  const root = document.createElement("div");
  root.setAttribute("data-tedi-terminal-screenshot-dropdown", "");
  root.tabIndex = -1;
  // Styled to match TEDI's tooltip / popover look so the dropdown
  // reads as part of the host UI rather than an extension island.
  Object.assign(root.style, {
    position: "fixed",
    zIndex: "9999",
    minWidth: "240px",
    maxWidth: "320px",
    maxHeight: "min(60vh, 420px)",
    overflow: "auto",
    background: "var(--popover, var(--card))",
    color: "var(--popover-foreground, var(--foreground))",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "0 10px 24px rgba(0, 0, 0, 0.28)",
    padding: "4px",
    fontSize: "12px",
    lineHeight: "1.4",
  });

  const terminals = enumerateTerminals();
  renderDropdownContents(root, terminals);

  document.body.appendChild(root);
  positionDropdown(root, anchor);
  dropdownEl = root;

  // Outside click closes. `mousedown` (not `click`) so the dropdown
  // dismisses before the click lands on whatever the user actually
  // wanted to interact with.
  outsideHandler = (event) => {
    const t = event.target instanceof Element ? event.target : null;
    if (!t) return;
    if (root.contains(t)) return;
    if (t.closest(BUTTON_SELECTOR)) return; // toggle handler owns this
    closeDropdown();
  };
  document.addEventListener("mousedown", outsideHandler, true);

  keyHandler = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeDropdown();
    }
  };
  document.addEventListener("keydown", keyHandler, true);
}

function closeDropdown() {
  if (dropdownEl) {
    try {
      dropdownEl.remove();
    } catch {
      // ignore
    }
    dropdownEl = null;
  }
  if (outsideHandler) {
    document.removeEventListener("mousedown", outsideHandler, true);
    outsideHandler = null;
  }
  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler, true);
    keyHandler = null;
  }
}

function positionDropdown(root, anchor) {
  const rect = anchor.getBoundingClientRect();
  const GAP = 6;
  // Pin the dropdown's right edge under the button's right edge and
  // float it above the status bar. Using `right`/`bottom` keeps the
  // popover anchored when the window resizes.
  const right = Math.max(8, window.innerWidth - rect.right);
  const bottom = Math.max(8, window.innerHeight - rect.top + GAP);
  root.style.right = `${right}px`;
  root.style.bottom = `${bottom}px`;
  root.style.left = "auto";
  root.style.top = "auto";
}

function renderDropdownContents(root, terminals) {
  // "Capture all visible terminals" sits at the top, only when there
  // is actually more than one pane to capture. With a single terminal
  // it is a duplicate of the per-terminal entry below.
  if (terminals.length > 1) {
    root.appendChild(
      makeRow({
        primary: "Capture all visible terminals",
        secondary: `${terminals.length} panes`,
        onSelect: async () => {
          closeDropdown();
          await runCapture("all");
        },
      }),
    );
    root.appendChild(makeDivider());
  }

  if (terminals.length === 0) {
    const empty = document.createElement("div");
    empty.style.padding = "10px 12px";
    empty.style.color = "var(--muted-foreground)";
    empty.textContent = "No visible terminal to capture.";
    root.appendChild(empty);
    return;
  }

  for (const t of terminals) {
    root.appendChild(
      makeRow({
        ordinal: t.ordinal,
        primary: t.ordinal != null ? `Terminal ${t.ordinal}` : "Terminal",
        secondary: t.label || undefined,
        focused: t.focused,
        onSelect: async () => {
          closeDropdown();
          await runCaptureElement(t.element);
        },
      }),
    );
  }
}

function makeDivider() {
  const hr = document.createElement("div");
  hr.style.height = "1px";
  hr.style.margin = "4px 6px";
  hr.style.background = "var(--border)";
  return hr;
}

function makeRow({ ordinal, primary, secondary, focused, onSelect }) {
  const btn = document.createElement("button");
  btn.type = "button";
  Object.assign(btn.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    padding: "8px 10px",
    border: "0",
    background: "transparent",
    color: "inherit",
    textAlign: "left",
    font: "inherit",
    borderRadius: "6px",
    cursor: "pointer",
    transition: "background 100ms",
  });
  btn.onmouseenter = () => {
    btn.style.background = "var(--accent)";
    btn.style.color = "var(--accent-foreground, var(--foreground))";
  };
  btn.onmouseleave = () => {
    btn.style.background = "transparent";
    btn.style.color = "inherit";
  };
  btn.onclick = () => {
    void onSelect();
  };

  if (typeof ordinal === "number") {
    const badge = document.createElement("span");
    badge.textContent = String(ordinal);
    // Same look as TEDI's `TerminalOrdinalBadge`: muted background,
    // tabular numerals, small monospaced text.
    Object.assign(badge.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: "22px",
      padding: "2px 6px",
      borderRadius: "4px",
      background: "var(--muted, rgba(127,127,127,0.18))",
      color: "var(--muted-foreground, inherit)",
      fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
      fontSize: "10px",
      fontWeight: "600",
      fontVariantNumeric: "tabular-nums",
    });
    btn.appendChild(badge);
  }

  const labels = document.createElement("span");
  labels.style.display = "flex";
  labels.style.flexDirection = "column";
  labels.style.minWidth = "0";
  labels.style.flex = "1";

  const top = document.createElement("span");
  top.textContent = primary;
  top.style.whiteSpace = "nowrap";
  top.style.overflow = "hidden";
  top.style.textOverflow = "ellipsis";
  labels.appendChild(top);

  if (secondary) {
    const sub = document.createElement("span");
    sub.textContent = secondary;
    sub.style.color = "var(--muted-foreground)";
    sub.style.fontSize = "11px";
    sub.style.whiteSpace = "nowrap";
    sub.style.overflow = "hidden";
    sub.style.textOverflow = "ellipsis";
    labels.appendChild(sub);
  }

  btn.appendChild(labels);

  if (focused) {
    const tag = document.createElement("span");
    tag.textContent = "focused";
    Object.assign(tag.style, {
      color: "var(--muted-foreground)",
      fontSize: "10px",
      textTransform: "uppercase",
      letterSpacing: "0.04em",
      padding: "2px 6px",
      border: "1px solid var(--border)",
      borderRadius: "999px",
    });
    btn.appendChild(tag);
  }

  return btn;
}

/* ------------------------------------------------------------------ */
/* Terminal enumeration                                               */
/* ------------------------------------------------------------------ */

/**
 * Returns every visible terminal pane, decorated with the FIFO ordinal
 * shown in the tab strip and its display label. The ordinal mapping
 * comes from walking `TabsTrigger` elements (`[data-entry-key^="leaf-"]`)
 * whose `<TerminalOrdinalBadge>` carries `aria-label="Terminal N"`.
 * Persisted across restarts by TEDI core, so the number stays stable.
 */
function enumerateTerminals() {
  const ordinalByLeaf = buildLeafOrdinalMap();
  const focusedEl = document.activeElement?.closest?.("[data-terminal-leaf-id]") ?? null;

  const out = [];
  const panes = document.querySelectorAll("[data-terminal-leaf-id]");
  for (const el of panes) {
    if (!(el instanceof HTMLElement)) continue;
    if (!isVisible(el)) continue;
    const idAttr = el.getAttribute("data-terminal-leaf-id") ?? "";
    const leafId = Number(idAttr);
    const meta = Number.isFinite(leafId) ? ordinalByLeaf.get(leafId) : undefined;
    out.push({
      element: el,
      leafId,
      ordinal: meta?.ordinal,
      label: meta?.label ?? "",
      focused: el === focusedEl,
    });
  }
  // Sort by ordinal so the dropdown matches the tab strip's order;
  // unknown ordinals (newly opened, mapping not yet built) trail.
  out.sort((a, b) => {
    if (a.ordinal == null && b.ordinal == null) return 0;
    if (a.ordinal == null) return 1;
    if (b.ordinal == null) return -1;
    return a.ordinal - b.ordinal;
  });
  return out;
}

function buildLeafOrdinalMap() {
  /** @type {Map<number, { ordinal: number; label: string }>} */
  const out = new Map();
  const triggers = document.querySelectorAll('[data-entry-key^="leaf-"]');
  for (const t of triggers) {
    const key = t.getAttribute("data-entry-key") ?? "";
    const id = Number(key.slice("leaf-".length));
    if (!Number.isFinite(id)) continue;
    const badge = t.querySelector('[aria-label^="Terminal "]');
    if (!badge) continue;
    const match = /^Terminal (\d+)$/.exec(badge.getAttribute("aria-label") ?? "");
    if (!match) continue;
    const ordinal = Number(match[1]);
    // Tab label sits in the only `.truncate` span inside the entry.
    // Fall back to whatever the trigger's text is, minus the badge.
    let label = "";
    const labelSpan = t.querySelector(".truncate");
    if (labelSpan) label = labelSpan.textContent?.trim() ?? "";
    if (!label) {
      const text = (t.textContent ?? "").trim();
      label = text.replace(/^\d+\s*/, "");
    }
    out.set(id, { ordinal, label });
  }
  return out;
}

function findActiveTerminal() {
  const fromFocus = document.activeElement?.closest?.("[data-terminal-leaf-id]");
  if (fromFocus instanceof HTMLElement && isVisible(fromFocus)) {
    return fromFocus;
  }
  const all = document.querySelectorAll("[data-terminal-leaf-id]");
  for (const el of all) {
    if (el instanceof HTMLElement && isVisible(el)) return el;
  }
  return null;
}

function findVisibleTerminals() {
  const all = Array.from(document.querySelectorAll("[data-terminal-leaf-id]"));
  return all.filter((el) => el instanceof HTMLElement && isVisible(el));
}

function isVisible(el) {
  // `TerminalPane` toggles inline `visibility: hidden` on inactive
  // tabs. That's a stronger signal than computed style (which also
  // catches CSS-only hides we don't care about here) and matches
  // exactly what the user sees.
  if (el.style.visibility === "hidden") return false;
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4;
}

/* ------------------------------------------------------------------ */
/* Capture pipeline                                                   */
/* ------------------------------------------------------------------ */

async function runCapture(mode /* "active" | "all" */) {
  let targets;
  if (mode === "active") {
    const one = findActiveTerminal();
    targets = one ? [one] : [];
  } else {
    targets = findVisibleTerminals();
  }
  await captureMany(targets);
}

async function runCaptureElement(el) {
  if (!(el instanceof HTMLElement) || !isVisible(el)) {
    safeToast("That terminal is no longer visible.", "warning");
    return;
  }
  await captureMany([el]);
}

async function captureMany(targets) {
  if (!targets || targets.length === 0) {
    safeToast("No visible terminal to capture.", "warning");
    return;
  }

  const stamp = formatStamp(new Date());
  const ordinalByLeaf = buildLeafOrdinalMap();
  const shots = []; // { blob, name }

  for (const target of targets) {
    try {
      const { blob } = await captureElement(target);
      if (!blob) continue;
      const leafId = Number(target.getAttribute("data-terminal-leaf-id") ?? "0");
      const ordinal = ordinalByLeaf.get(leafId)?.ordinal;
      const labelPart = ordinal != null ? `terminal-${ordinal}` : `leaf-${leafId}`;
      const name = `tedi-${labelPart}-${stamp}.png`;
      shots.push({ blob, name });
    } catch (err) {
      ctx?.logger?.error?.("capture failed", err);
    }
  }

  if (shots.length === 0) {
    safeToast("Capture produced an empty image.", "error");
    return;
  }

  // Clipboard takes the first frame so multi-pane capture still has
  // a one-paste path. Per-pane files are still produced via the
  // download anchor below.
  await tryClipboard(shots[0].blob);

  // One download per capture. The webview's anchor handler resolves
  // each click against its own save flow (WebView2: Save As prompt,
  // WKWebView / WebKitGTK: routed to ~/Downloads). Space them out by
  // a tick so the host doesn't coalesce simultaneous clicks.
  for (let i = 0; i < shots.length; i++) {
    triggerDownload(shots[i].blob, shots[i].name);
    if (i < shots.length - 1) {
      await sleep(80);
    }
  }

  if (shots.length === 1) {
    safeToast(`Captured ${shots[0].name}.`, "success");
  } else {
    safeToast(`Captured ${shots.length} terminals; first copied to clipboard.`, "success");
  }
}

/**
 * Paints every `<canvas>` under the terminal element onto a fresh
 * 2D canvas at device-pixel resolution. xterm's WebGL renderer keeps
 * its drawing buffer between frames as long as nothing forces a
 * reset, so `drawImage(canvas)` reliably copies the visible pixels.
 */
async function captureElement(el) {
  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx2d = out.getContext("2d");
  if (!ctx2d) return { blob: null };

  // Paint the terminal's background colour first so transparent
  // canvas regions (selection layer, etc.) don't leave the PNG with
  // a transparent backdrop.
  const bgHost = el.querySelector(".xterm-viewport, .xterm") ?? el;
  const bg = readBackground(bgHost);
  ctx2d.fillStyle = bg;
  ctx2d.fillRect(0, 0, width, height);

  // Composite child canvases in document order so the cursor/selection
  // layers end up on top of the text layer.
  const canvases = el.querySelectorAll("canvas");
  for (const c of canvases) {
    const cr = c.getBoundingClientRect();
    const dx = (cr.left - rect.left) * dpr;
    const dy = (cr.top - rect.top) * dpr;
    const dw = cr.width * dpr;
    const dh = cr.height * dpr;
    try {
      ctx2d.drawImage(c, dx, dy, dw, dh);
    } catch {
      // `drawImage` can throw on a WebGL canvas whose buffer was
      // wiped (e.g. the GPU just reclaimed it). Skip and continue;
      // the remaining layers will still give a useful image.
    }
  }

  const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
  return { blob };
}

function readBackground(el) {
  try {
    const c = getComputedStyle(el).backgroundColor;
    if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
  } catch {
    // ignore
  }
  return "#000000";
}

/* ------------------------------------------------------------------ */
/* IO                                                                 */
/* ------------------------------------------------------------------ */

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
    // Revoke after a tick so the click handler has time to read the URL.
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
