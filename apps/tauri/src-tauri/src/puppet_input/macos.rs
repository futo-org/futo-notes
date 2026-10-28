//! macOS: each step as an `NSEvent`, straight to the WKWebView's responder methods.

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};

use super::{Phase, Sent, Step};

#[cfg(target_os = "macos")]
static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(1);

/// The button mask WebKit should see while one of our gestures is in flight.
///
/// WebKit fills `MouseEvent.buttons` from `+[NSEvent pressedMouseButtons]` —
/// the window server's view of the physical mouse — not from the event it was
/// handed. So a sent drag arrives with `buttons: 0` on every event, and
/// CodeMirror ends a drag-selection the moment it reads that (measured: eight
/// moves delivered, selection never left the anchor). Between one of our downs
/// and its up, that class method answers with the held button; the rest of
/// the time the original implementation runs untouched.
#[cfg(target_os = "macos")]
static HELD_BUTTONS: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "macos")]
static ORIGINAL_PRESSED_MOUSE_BUTTONS: AtomicUsize = AtomicUsize::new(0);

#[cfg(target_os = "macos")]
fn answer_pressed_mouse_buttons_for_our_gestures() {
    use objc2::runtime::{AnyClass, Sel};
    use objc2::ClassType;

    type PressedMouseButtons = unsafe extern "C-unwind" fn(*const AnyClass, Sel) -> usize;

    unsafe extern "C-unwind" fn pressed_mouse_buttons(
        class: *const AnyClass,
        selector: Sel,
    ) -> usize {
        match HELD_BUTTONS.load(Ordering::Relaxed) {
            0 => {
                // SAFETY: stored below from the method's own implementation,
                // whose signature this is.
                let original: PressedMouseButtons = unsafe {
                    std::mem::transmute(ORIGINAL_PRESSED_MOUSE_BUTTONS.load(Ordering::Relaxed))
                };
                unsafe { original(class, selector) }
            }
            held => held,
        }
    }

    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let method = objc2_app_kit::NSEvent::class()
            .class_method(objc2::sel!(pressedMouseButtons))
            .expect("NSEvent has +pressedMouseButtons");
        // SAFETY: same signature as the method it replaces; debug builds only,
        // and the original is kept and called whenever nothing of ours is held.
        let original = unsafe {
            method.set_implementation(std::mem::transmute::<
                PressedMouseButtons,
                objc2::runtime::Imp,
            >(pressed_mouse_buttons))
        };
        ORIGINAL_PRESSED_MOUSE_BUTTONS.store(original as usize, Ordering::Relaxed);
    });
}

/// The web view's size in CSS px.
#[cfg(target_os = "macos")]
pub(super) fn view_size(webview: &tauri::webview::PlatformWebview) -> Result<(f64, f64), String> {
    // SAFETY: `with_webview` runs this on the main thread with the live
    // WKWebView, which is an NSView, for the duration of the call.
    let view: &objc2_app_kit::NSView = unsafe { &*webview.inner().cast() };
    let bounds = view.bounds();
    Ok((bounds.size.width, bounds.size.height))
}

#[cfg(target_os = "macos")]
pub(super) fn send_event(
    webview: &tauri::webview::PlatformWebview,
    step: Step,
) -> Result<Sent, String> {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSView};
    use objc2_foundation::{NSPoint, NSProcessInfo};

    answer_pressed_mouse_buttons_for_our_gestures();
    // SAFETY: `with_webview` runs this on the main thread with the live
    // WKWebView, which is an NSView, for the duration of the call.
    let view: &NSView = unsafe { &*webview.inner().cast::<NSView>() };
    let bounds = view.bounds();
    let ns_window = view.window().ok_or("the web view is not in a window")?;
    // CSS y grows downward; AppKit's does not unless the view is flipped
    // (WKWebView is). Ask rather than assume.
    let in_view = if view.isFlipped() {
        NSPoint::new(step.x, step.y)
    } else {
        NSPoint::new(step.x, bounds.size.height - step.y)
    };
    let in_window = view.convertPoint_toView(in_view, None);
    if step.phase == Phase::Wheel {
        return send_wheel(view, in_window, step);
    }
    let kind = match (step.phase, step.right) {
        (Phase::Down, false) => NSEventType::LeftMouseDown,
        (Phase::Dragged, false) => NSEventType::LeftMouseDragged,
        (Phase::Up, false) => NSEventType::LeftMouseUp,
        (Phase::Down, true) => NSEventType::RightMouseDown,
        (Phase::Dragged, true) => NSEventType::RightMouseDragged,
        (Phase::Up, true) => NSEventType::RightMouseUp,
        (Phase::Wheel, _) => unreachable!("sent by send_wheel above"),
    };
    let pressure = if step.phase == Phase::Up { 0.0 } else { 1.0 };
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind,
        in_window,
        NSEventModifierFlags::empty(),
        NSProcessInfo::processInfo().systemUptime(),
        ns_window.windowNumber(),
        None,
        EVENT_NUMBER.fetch_add(1, Ordering::Relaxed),
        isize::try_from(step.count).unwrap_or(1),
        pressure,
    )
    .ok_or("AppKit refused to build the mouse event")?;
    // A real mouseup already reads as released (`buttons: 0`); a real mousedown
    // as held. Set the mask before either is sent so WebKit sees the same.
    HELD_BUTTONS.store(
        match step.phase {
            Phase::Up | Phase::Wheel => 0,
            Phase::Down | Phase::Dragged if step.right => 2,
            Phase::Down | Phase::Dragged => 1,
        },
        Ordering::Relaxed,
    );
    // Straight to the web view's responder methods, not `NSWindow.sendEvent`.
    // The window applies the key-window rule there: a press on a window that is
    // not key activates it instead of reaching the view (WKWebView does not
    // accept first mouse), and this window is key only while the human is in
    // it. Measured: the same click landed on a key window and vanished on a
    // non-key one. The web view is the window's whole content, so no
    // hit-testing is lost, and activating the window would steal the human's
    // focus (the rule qa-shot keeps).
    match kind {
        NSEventType::LeftMouseDown => view.mouseDown(&event),
        NSEventType::LeftMouseDragged => view.mouseDragged(&event),
        NSEventType::LeftMouseUp => view.mouseUp(&event),
        NSEventType::RightMouseDown => view.rightMouseDown(&event),
        NSEventType::RightMouseDragged => view.rightMouseDragged(&event),
        _ => view.rightMouseUp(&event),
    }
    Ok(())
}

/// One wheel notch over `in_window`. AppKit cannot build a scroll-wheel
/// `NSEvent`, so it starts as a CoreGraphics pixel-wheel event, then goes to the
/// web view's `scrollWheel:` like every other step here, so WebKit scrolls
/// whatever is under that point and the page sees trusted `wheel` events.
///
/// An `NSEvent` made from a CoreGraphics event belongs to no window, and AppKit
/// then answers `locationInWindow` — what WebKit reads — with the event's
/// position on screen. So the event is placed at the window point itself, not
/// where the window sits on screen (measured: placed at its true screen point,
/// every wheel landed offset by the window's origin).
#[cfg(target_os = "macos")]
fn send_wheel(
    view: &objc2_app_kit::NSView,
    in_window: objc2_foundation::NSPoint,
    step: Step,
) -> Result<(), String> {
    use objc2_app_kit::NSEvent;
    use objc2_core_graphics::{CGDisplayBounds, CGEvent, CGMainDisplayID, CGScrollEventUnit};

    // CoreGraphics places events top-left from the main display; AppKit reads
    // them back bottom-left, so flip by that display's height.
    let main_display_height = CGDisplayBounds(CGMainDisplayID()).size.height;
    let global = objc2_foundation::NSPoint::new(in_window.x, main_display_height - in_window.y);
    // CoreGraphics counts a wheel the other way round from `WheelEvent.deltaY`:
    // positive is up/left, so down/right is a negative wheel.
    let wheel = |delta: f64| -(delta.round() as i32);
    let cg_event = CGEvent::new_scroll_wheel_event2(
        None,
        CGScrollEventUnit::Pixel,
        2,
        wheel(step.dy),
        wheel(step.dx),
        0,
    )
    .ok_or("CoreGraphics refused to build the wheel event")?;
    CGEvent::set_location(Some(&cg_event), global);
    let event = NSEvent::eventWithCGEvent(&cg_event).ok_or("AppKit refused the wheel event")?;
    if event.windowNumber() != 0 {
        return Err(
            "AppKit tied the wheel event to a window, so its placement no longer holds".into(),
        );
    }
    view.scrollWheel(&event);
    Ok(())
}
