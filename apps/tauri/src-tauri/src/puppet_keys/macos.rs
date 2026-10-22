//! macOS: a key as an `NSEvent` down and up, through the WKWebView's responder methods.

use super::{mac_key, Key};

#[cfg(target_os = "macos")]
pub(super) fn send_key(
    webview: &tauri::webview::PlatformWebview,
    key: &Key,
) -> Result<crate::puppet_input::Sent, String> {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSView};
    use objc2_foundation::{NSPoint, NSProcessInfo, NSString};

    // SAFETY: `with_webview` runs this on the main thread with the live
    // WKWebView, which is an NSView, for the duration of the call.
    let view: &NSView = unsafe { &*webview.inner().cast::<NSView>() };
    let ns_window = view.window().ok_or("the web view is not in a window")?;
    let mut flags = NSEventModifierFlags::empty();
    for (held, flag) in [
        (key.modifiers.meta, NSEventModifierFlags::Command),
        (key.modifiers.shift, NSEventModifierFlags::Shift),
        (key.modifiers.alt, NSEventModifierFlags::Option),
        (key.modifiers.control, NSEventModifierFlags::Control),
    ] {
        if held {
            flags |= flag;
        }
    }
    let (code, characters, unmodified) = mac_key(key);
    let event = |kind: NSEventType| {
        NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,
            NSPoint::new(0.0, 0.0),
            flags,
            NSProcessInfo::processInfo().systemUptime(),
            ns_window.windowNumber(),
            None,
            &NSString::from_str(&characters),
            &NSString::from_str(&unmodified),
            false,
            code,
        )
        .ok_or("AppKit refused to build the key event")
    };
    // To the web view's own responder methods, as `puppet_input.rs` does for the
    // mouse: through `NSWindow.sendEvent` a key reaches only the key window.
    let down = event(NSEventType::KeyDown)?;
    let up = event(NSEventType::KeyUp)?;
    view.keyDown(&down);
    view.keyUp(&up);
    Ok(())
}
