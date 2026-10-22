//! Windows: each step as a DevTools `Input.dispatchMouseEvent` call on the WebView2.

use std::sync::mpsc;

use super::{devtools_mouse_event, Sent, Step};

#[cfg(target_os = "windows")]
pub(super) fn view_size(webview: &tauri::webview::PlatformWebview) -> Result<(f64, f64), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
    use windows_core::Interface;

    let controller = webview.controller();
    // The controller's box is in device pixels; CSS pixels are those over its scale.
    let mut bounds = windows::Win32::Foundation::RECT::default();
    let mut scale = 1.0;
    // SAFETY: plain getters on the live controller, on the UI thread `with_webview` runs on.
    unsafe {
        controller
            .Bounds(&mut bounds)
            .map_err(|error| error.to_string())?;
        if let Ok(scaled) = controller.cast::<ICoreWebView2Controller3>() {
            scaled.RasterizationScale(&mut scale).ok();
        }
    }
    Ok((
        f64::from(bounds.right - bounds.left) / scale,
        f64::from(bounds.bottom - bounds.top) / scale,
    ))
}

#[cfg(target_os = "windows")]
pub(super) fn send_event(
    webview: &tauri::webview::PlatformWebview,
    step: Step,
) -> Result<Sent, String> {
    Ok(vec![devtools(
        webview,
        "Input.dispatchMouseEvent",
        &devtools_mouse_event(step),
    )?])
}

/// One DevTools call on this window's WebView2; its answer arrives on the UI thread's
/// message loop, after this returns, through the receiver it hands back.
#[cfg(target_os = "windows")]
pub(crate) fn devtools(
    webview: &tauri::webview::PlatformWebview,
    method: &'static str,
    params: &serde_json::Value,
) -> Result<mpsc::Receiver<Result<(), String>>, String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;

    let (sender, receiver) = mpsc::channel();
    let handler =
        CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, answer| {
            sender
                .send(result.map_err(|error| format!("{method}: {error} {answer}")))
                .ok();
            Ok(())
        }));
    // SAFETY: the live controller's web view, on the UI thread `with_webview` runs on.
    unsafe {
        webview
            .controller()
            .CoreWebView2()
            .and_then(|core| {
                core.CallDevToolsProtocolMethod(
                    &HSTRING::from(method),
                    &HSTRING::from(params.to_string()),
                    &handler,
                )
            })
            .map_err(|error| format!("{method}: {error}"))?;
    }
    Ok(receiver)
}
