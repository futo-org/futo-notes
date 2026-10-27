//! `futo-puppet screenshot`: the screen as a PNG under `.puppet/screens/`, for what only pixels
//! can say — a colour, an underline, a layout. Never for reading state: `state` and `doc` say
//! what is selected or saved, and `elements` gives the coordinates gestures take.
//!
//! Desktop asks the debug bridge itself for `capture_native_screenshot`, the capture the Tauri
//! MCP server calls: the web view as its window draws it (on macOS, WKWebView's own snapshot;
//! on Linux, where the bridge has none, the app's `puppet_screenshot`, WebKitGTK's), so a
//! window on another space or behind others still comes back whole. A native file picker
//! or the title bar is not in it. A phone shoots this worktree's claimed device: `simctl io` on
//! iOS, `adb -s` on Android.

use super::*;
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Capture the target's screen and save it; the line to print says where and how big.
pub(crate) fn capture(target: &Target) -> Result<String, String> {
    let dir = repo_root().join(".puppet").join("screens");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let at = now_millis();
    let (name, png) = match target {
        Target::Desktop(port) => {
            let data = bridge_command(
                *port,
                "capture_native_screenshot",
                json!({ "format": "png" }),
                BRIDGE_REPLY_TIMEOUT,
            )
            // The bridge has no capture on Linux; the app's own WebKitGTK snapshot does
            // (apps/tauri/src-tauri/src/puppet_screenshot.rs).
            .or_else(|bridge| {
                bridge_execute_js(
                    *port,
                    "await window.__TAURI__.core.invoke(\"puppet_screenshot\")",
                )
                .map_err(|app| format!("{bridge}; puppet_screenshot: {app}"))
            })?;
            let url = data
                .as_str()
                .ok_or_else(|| format!("the desktop app answered {data} for a screenshot"))?;
            let encoded = url.split_once("base64,").map_or(url, |(_, rest)| rest);
            let png = STANDARD_NO_PAD
                .decode(encoded.trim_end_matches('='))
                .map_err(|_| "the capture is not base64")?;
            ("desktop", png)
        }
        Target::Native(NativePlatform::Ios, _, udid) => {
            let path = dir.join(format!("ios-{at}.png"));
            let out = Command::new("xcrun")
                .args(["simctl", "io", udid, "screenshot"])
                .arg(&path)
                .output()
                .map_err(|e| format!("could not run xcrun simctl: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "simctl io screenshot: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            let png = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            ("ios", png)
        }
        Target::Native(NativePlatform::Android, _, serial) => {
            let out = Command::new("adb")
                .args(["-s", serial, "exec-out", "screencap", "-p"])
                .output()
                .map_err(|e| format!("could not run adb: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "adb screencap: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            ("android", out.stdout)
        }
    };
    let (width, height) = png_size(&png).ok_or("the capture is not a PNG")?;
    let path = dir.join(format!("{name}-{at}.png"));
    std::fs::write(&path, &png).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(format!(
        "screenshot {} · {width}×{height} px · open it with Read",
        path.display()
    ))
}

/// Width and height from a PNG's header chunk.
fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if !png.starts_with(PNG_SIGNATURE) || png.len() < 24 {
        return None;
    }
    let number = |at: usize| u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]);
    Some((number(16), number(20)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_png_header_gives_its_size_and_anything_else_none() {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend_from_slice(&[0, 0, 0, 13]);
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&2400u32.to_be_bytes());
        png.extend_from_slice(&1600u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((2400, 1600)));
        assert_eq!(png_size(b"GIF89a, not a png at all"), None);
    }
}
