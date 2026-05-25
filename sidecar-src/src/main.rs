//! tedi-screenshot-helper - one-shot OS-level window capture.
//!
//! Usage: `tedi-screenshot-helper <window-title>`
//!
//! Resolves a TEDI window via `xcap::Window::all()` by exact title
//! match (falls back to substring "TEDI" if the title drifted mid-flight
//! because TEDI rewrites it to include the active folder), grabs the
//! OS-composited frame, encodes as PNG, prints the base64 payload to
//! stdout terminated by a newline, and exits.
//!
//! Why base64-over-stdout instead of raw PNG: the host calls
//! `shell_bg_logs` which decodes child output via
//! `String::from_utf8_lossy` - raw PNG bytes survive that
//! intact only by luck. Base64 is plain ASCII so no conversion drops
//! data.
//!
//! Why a sidecar instead of a TEDI core Tauri command: keeps the screen-
//! capture native deps (xcap + image + libpipewire on Linux) inside the
//! extension's release artifact. The TEDI core binary stays generic;
//! uninstalling the screenshot extension removes every native dep with
//! it. Same architectural pattern as tedi.discord-rich-presence.

use std::io::{self, Cursor, Write};
use std::process::ExitCode;

use base64::Engine as _;
use image::ImageFormat;
use xcap::Window;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: tedi-screenshot-helper <window-title>");
        return ExitCode::from(2);
    }
    let want_title = args[0].as_str();

    match run(want_title) {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("{msg}");
            ExitCode::FAILURE
        }
    }
}

fn run(want_title: &str) -> Result<(), String> {
    let windows = Window::all().map_err(|e| format!("enumerate windows: {e}"))?;

    let title_of = |w: &Window| w.title().ok();
    let target = windows
        .iter()
        .find(|w| title_of(w).as_deref() == Some(want_title))
        .or_else(|| {
            windows.iter().find(|w| {
                title_of(w)
                    .as_deref()
                    .map(|t| t.contains("TEDI"))
                    .unwrap_or(false)
            })
        })
        .ok_or_else(|| format!("window `{want_title}` not visible to capture backend"))?;

    let img = target
        .capture_image()
        .map_err(|e| format!("capture image: {e}"))?;

    let mut bytes: Vec<u8> = Vec::with_capacity(512 * 1024);
    {
        let mut cursor = Cursor::new(&mut bytes);
        img.write_to(&mut cursor, ImageFormat::Png)
            .map_err(|e| format!("encode png: {e}"))?;
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{b64}").map_err(|e| format!("write stdout: {e}"))?;
    Ok(())
}
