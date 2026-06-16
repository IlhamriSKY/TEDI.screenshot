// Image transport: decode the base64 PNG the helper emits, copy it to the OS
// clipboard, and trigger a browser download.

import { ctx } from "./runtime.js";

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

export { base64ToBlob, tryClipboard, triggerDownload };
