//! Linux: each step as a `GdkEvent`, straight to the WebKitGTK widget.

use super::{gtk_scroll_units, Phase, Sent, Step};

/// GDK's event clock: milliseconds, as a real event's `time`. WebKitGTK counts a double
/// click by these, as GDK does.
#[cfg(target_os = "linux")]
pub(crate) fn gdk_time() -> u32 {
    (glib::monotonic_time() / 1000) as u32
}

/// The web view's size in CSS px: its GTK allocation.
#[cfg(target_os = "linux")]
pub(super) fn view_size(webview: &tauri::webview::PlatformWebview) -> Result<(f64, f64), String> {
    use gtk::prelude::*;

    let allocation = webview.inner().allocation();
    Ok((
        f64::from(allocation.width()),
        f64::from(allocation.height()),
    ))
}

/// One pointer event, straight to the WebKitGTK widget (`gtk_widget_event`) at a point in
/// its own window, as GDK delivers a real one: WebKitGTK hit-tests it, counts clicks by
/// time and place, and reads the held button from a motion's `state`, so a drag selects.
/// A wheel notch is a smooth scroll from the seat's mouse, in [`gtk_scroll_units`].
#[cfg(target_os = "linux")]
pub(super) fn send_event(
    webview: &tauri::webview::PlatformWebview,
    step: Step,
) -> Result<Sent, String> {
    use glib::translate::{ToGlibPtr, ToGlibPtrMut};
    use gtk::gdk;
    use gtk::prelude::*;

    let view = webview.inner();
    let allocation = view.allocation();
    let window = view.window().ok_or("the web view has no GDK window yet")?;
    // A widget without a window of its own draws in its parent's, whose origin is not its own.
    let (x, y) = if view.has_window() {
        (step.x, step.y)
    } else {
        (
            step.x + f64::from(allocation.x()),
            step.y + f64::from(allocation.y()),
        )
    };
    let (origin_x, origin_y) = window.root_coords(0, 0);
    let (root_x, root_y) = (x + f64::from(origin_x), y + f64::from(origin_y));
    let pointer = window
        .display()
        .default_seat()
        .and_then(|seat| seat.pointer())
        .ok_or("this display has no pointer device")?;
    let held = if step.right {
        gdk::ModifierType::BUTTON3_MASK
    } else {
        gdk::ModifierType::BUTTON1_MASK
    };
    let kind = match step.phase {
        Phase::Down => gdk::EventType::ButtonPress,
        Phase::Up => gdk::EventType::ButtonRelease,
        Phase::Dragged => gdk::EventType::MotionNotify,
        Phase::Wheel => gdk::EventType::Scroll,
    };
    let mut event = gdk::Event::new(kind);
    event.set_device(Some(&pointer));
    event.set_source_device(Some(&pointer));
    // SAFETY: a fresh event of `kind`, so the matching union member is the live one. The
    // window goes in with a reference of its own, which freeing the event releases; the
    // device is the seat's and outlives the event.
    unsafe {
        let raw: *mut gdk::ffi::GdkEvent = event.to_glib_none_mut().0;
        let device: *mut gdk::ffi::GdkDevice = pointer.to_glib_none().0;
        match step.phase {
            Phase::Down | Phase::Up => {
                let button = &mut (*raw).button;
                button.window = window.to_glib_full();
                button.time = gdk_time();
                (button.x, button.y, button.x_root, button.y_root) = (x, y, root_x, root_y);
                button.button = if step.right { 3 } else { 1 };
                // A press reports the buttons held before it, a release the ones that were.
                button.state = if step.phase == Phase::Up {
                    held.bits()
                } else {
                    0
                };
                button.device = device;
            }
            Phase::Dragged => {
                let motion = &mut (*raw).motion;
                motion.window = window.to_glib_full();
                motion.time = gdk_time();
                (motion.x, motion.y, motion.x_root, motion.y_root) = (x, y, root_x, root_y);
                motion.state = held.bits();
                motion.device = device;
            }
            Phase::Wheel => {
                let scroll = &mut (*raw).scroll;
                scroll.window = window.to_glib_full();
                scroll.time = gdk_time();
                (scroll.x, scroll.y, scroll.x_root, scroll.y_root) = (x, y, root_x, root_y);
                scroll.direction = gdk::ffi::GDK_SCROLL_SMOOTH;
                scroll.delta_x = gtk_scroll_units(step.dx, f64::from(allocation.width()));
                scroll.delta_y = gtk_scroll_units(step.dy, f64::from(allocation.height()));
                scroll.device = device;
            }
        }
    }
    view.event(&event);
    Ok(())
}
