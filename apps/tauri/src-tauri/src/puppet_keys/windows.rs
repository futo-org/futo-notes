//! Windows: a key as DevTools `Input.dispatchKeyEvent` calls on the WebView2.

use super::{devtools_key_events, Key};

/// The DevTools key events, sent to this window's WebView2 one after another; each answers
/// on the UI thread's message loop, after this returns.
#[cfg(target_os = "windows")]
pub(super) fn send_key(
    webview: &tauri::webview::PlatformWebview,
    key: &Key,
) -> Result<crate::puppet_input::Sent, String> {
    devtools_key_events(key)
        .iter()
        .map(|event| crate::puppet_input::devtools(webview, "Input.dispatchKeyEvent", event))
        .collect()
}
