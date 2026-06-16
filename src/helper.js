// Helper-binary resolution: picks the right native sidecar executable for the
// current OS / arch and resolves its on-disk path inside the extension's
// install dir.

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

export { platformDir, helperPath, getMainWindowTitle };
