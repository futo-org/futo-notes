//! `just puppet screenshot` on Linux. The debug bridge's `capture_native_screenshot`
//! answers on macOS and Windows; on Linux it has no capture (tauri-plugin-mcp-bridge 0.10
//! says "not yet implemented"), so the CLI asks the app for WebKitGTK's own snapshot of
//! the web view: the page as drawn, whether or not its window is on screen, with nothing
//! reaching the compositor or the clipboard (a compositor's window screenshot does both).
//! Debug builds only.

#[tauri::command]
pub(crate) async fn puppet_screenshot(window: tauri::WebviewWindow) -> Result<String, String> {
    if cfg!(not(debug_assertions)) {
        return Err("puppet_screenshot exists in debug builds only".into());
    }
    crate::background_tasks::blocking(move || capture(&window)).await
}

/// The visible web view as a base64 PNG.
#[cfg(target_os = "linux")]
fn capture(window: &tauri::WebviewWindow) -> Result<String, String> {
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            webview.inner().snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::NONE,
                None::<&gtk::gio::Cancellable>,
                move |surface| {
                    sender
                        .send(surface.map_err(|error| error.to_string()).and_then(png))
                        .ok();
                },
            );
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "WebKitGTK did not answer the snapshot within 5 s".to_string())?
}

#[cfg(target_os = "linux")]
fn png(surface: cairo::Surface) -> Result<String, String> {
    let image = cairo::ImageSurface::try_from(surface)
        .map_err(|_| "the snapshot is not an image surface".to_string())?;
    let mut bytes = Vec::new();
    image
        .write_to_png(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(glib::base64_encode(&bytes).to_string())
}

#[cfg(not(target_os = "linux"))]
fn capture(_window: &tauri::WebviewWindow) -> Result<String, String> {
    Err("the debug bridge's capture_native_screenshot covers this platform".into())
}
