//! Show the main window only once it has something to show.
//!
//! Every window config declares `"visible": false`. A WKWebView paints its own
//! opaque white until the page's first frame, so a visible-from-birth window
//! flashes white on every launch — measured at ~9 consecutive captured frames
//! on this app — and the flash is at its worst in dark mode, where it is the
//! first thing the user sees. Tauri's `backgroundColor` window option does NOT
//! fix it on macOS: killing the webview's own background needs the private
//! `drawsBackground` key, which wry only touches under its `transparent`
//! feature (tauri's `macOSPrivateApi`). Not shipping a private API for this.
//!
//! So the window is revealed instead of repainted. The frontend calls `show()`
//! after its first paint (src/lib/platform revealAppWindow), and this module
//! guarantees the window appears regardless: a webview that never renders — a
//! JS error before first paint, a dev server that is not up yet — must never
//! leave the user with an application that has no window.

use std::time::Duration;

use tauri::Manager;

/// How long the frontend gets to reveal the window before we do it for it.
/// Generous on purpose: this is a safety net, not a schedule.
const REVEAL_FALLBACK: Duration = Duration::from_secs(3);

pub(crate) fn install(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app = app.clone();
    crate::background_tasks::spawn("futo-window-reveal", move || {
        std::thread::sleep(REVEAL_FALLBACK);
        if let Some(window) = app.get_webview_window("main") {
            // `show` is a no-op on an already-visible window, so the normal
            // path (frontend revealed it in ~200ms) costs nothing.
            let _ = window.show();
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fallback is a safety net for a webview that never paints. Make it
    /// too short and it races a slow first paint back into the white flash
    /// this module exists to remove.
    #[test]
    fn fallback_is_a_safety_net_not_a_schedule() {
        assert!(REVEAL_FALLBACK >= Duration::from_secs(2));
        assert!(REVEAL_FALLBACK <= Duration::from_secs(10));
    }
}
