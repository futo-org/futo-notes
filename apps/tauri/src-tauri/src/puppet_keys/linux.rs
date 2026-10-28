//! Linux: a key as a `GdkEventKey` down and up, straight to the WebKitGTK widget.

use super::{gdk_key, Key};

/// A `GdkEventKey` down and up, straight to the WebKitGTK widget (`gtk_widget_event`),
/// not through the toplevel: a key sent to the window goes to whatever widget has focus,
/// and through the compositor to whatever window has it. WebKitGTK runs the key through
/// its input method and its key handling as it does a real one.
#[cfg(target_os = "linux")]
pub(super) fn send_key(
    webview: &tauri::webview::PlatformWebview,
    key: &Key,
) -> Result<crate::puppet_input::Sent, String> {
    use gtk::gdk;
    use gtk::prelude::*;

    let view = webview.inner();
    let window = view.window().ok_or("the web view has no GDK window yet")?;
    let keyboard = window
        .display()
        .default_seat()
        .and_then(|seat| seat.keyboard())
        .ok_or("this display has no keyboard device")?;
    let (keyval, keycode) = gdk_key(key);
    let mut state = gdk::ModifierType::empty();
    for (held, mask) in [
        (key.modifiers.shift, gdk::ModifierType::SHIFT_MASK),
        (key.modifiers.control, gdk::ModifierType::CONTROL_MASK),
        (key.modifiers.alt, gdk::ModifierType::MOD1_MASK),
        (
            key.modifiers.meta,
            gdk::ModifierType::SUPER_MASK | gdk::ModifierType::META_MASK,
        ),
    ] {
        if held {
            state |= mask;
        }
    }
    for kind in [gdk::EventType::KeyPress, gdk::EventType::KeyRelease] {
        let mut event = gdk::Event::new(kind);
        event.set_device(Some(&keyboard));
        // SAFETY: a fresh key event, so `key` is the union's live member; the window is
        // handed over with its own reference, which freeing the event releases.
        unsafe {
            use glib::translate::{ToGlibPtr, ToGlibPtrMut};
            let raw: *mut gdk::ffi::GdkEvent = event.to_glib_none_mut().0;
            let raw = &mut (*raw).key;
            raw.window = window.to_glib_full();
            raw.time = crate::puppet_input::gdk_time();
            raw.state = state.bits();
            raw.keyval = keyval;
            raw.hardware_keycode = keycode;
        }
        view.event(&event);
    }
    Ok(())
}
