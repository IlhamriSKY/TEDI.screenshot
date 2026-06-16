// UI + presentation helpers: toast surface, the human-readable save-location
// label, and the timestamp used in the saved filename.

import { ctx } from "./runtime.js";

function describeSaveLocation() {
  const platform = ctx?.os?.platform;
  if (platform === "windows") return "Downloads (%USERPROFILE%\\Downloads)";
  if (platform === "macos") return "Downloads (~/Downloads)";
  if (platform === "linux") return "Downloads (~/Downloads)";
  return "your Downloads folder";
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

export { describeSaveLocation, safeToast, formatStamp };
