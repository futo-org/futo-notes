//! Real mouse input for `just puppet click` / `drag` / `scroll` on desktop.
//!
//! The CLI's typed verbs call handlers directly, which is exactly why they
//! cannot reproduce an input bug: the language dropdown that closed on
//! `mousedown` never showed through a verb. This command builds a platform
//! mouse event and hands it to THIS window's web view the way the platform hands
//! it a real one, so the engine hit-tests it and the page sees `isTrusted: true`:
//!
//! - macOS: an `NSEvent` to the WKWebView's responder methods, the ones AppKit
//!   calls for a real click (WebKit's own automation builds the same events,
//!   `WebAutomationSessionMac.mm`).
//! - Linux: a `GdkEvent` to the WebKitGTK widget (`gtk_widget_event`), as GDK
//!   delivers a real one (WebKit's test runner builds the same events,
//!   `EventSenderProxyGtk.cpp`).
//! - Windows: DevTools `Input.dispatchMouseEvent` on the WebView2, which WebView2
//!   turns into the input a real mouse would give the page.
//!
//! Nothing is posted to the window server, the compositor or the OS input queue,
//! so the event can only ever reach the process the debug bridge already vetted
//! (AGENTS.md M24) — never a focused release app on the user's real vault — and
//! the window is never activated, so the human keeps focus.
//!
//! Debug builds only: the mcp bridge that carries the call is debug-only, and
//! in release the command refuses.

use std::sync::mpsc;
use std::time::Duration;

use serde::Deserialize;

// How each platform hands a step to its web view: `view_size` and `send_event`.
#[cfg(target_os = "macos")]
#[path = "puppet_input/macos.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "puppet_input/linux.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "puppet_input/windows.rs"]
mod platform;

#[cfg(target_os = "windows")]
pub(crate) use platform::devtools;
#[cfg(target_os = "linux")]
pub(crate) use platform::gdk_time;
use platform::{send_event, view_size};

/// One `click`, `drag` or `scroll`, in CSS pixels inside the web view.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Pointer {
    kind: String,
    x: f64,
    y: f64,
    x2: Option<f64>,
    y2: Option<f64>,
    /// `left` (default) or `right`.
    button: Option<String>,
    /// Click count: 2 is a double-click.
    count: Option<u32>,
    /// Seconds between press and release: a press-and-hold (a `hold` and a
    /// `count` do not combine).
    hold: Option<f64>,
    /// Drag duration in seconds (default 0.3).
    duration: Option<f64>,
    /// Scroll distance in CSS pixels, as a wheel's `deltaX`/`deltaY`: positive scrolls right/down.
    dx: Option<f64>,
    dy: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    Down,
    Dragged,
    Up,
    Wheel,
}

/// One platform event to send, and how long to wait before it.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Step {
    phase: Phase,
    right: bool,
    x: f64,
    y: f64,
    count: u32,
    delay: Duration,
    /// A wheel step's distance, CSS px; zero for a button.
    dx: f64,
    dy: f64,
}

/// Samples between a drag's down and up: enough for a drag-selection to walk
/// the text, few enough to finish well inside the bridge's 5 s call timeout.
const DRAG_SAMPLES: u32 = 8;

/// The longest `hold` or drag `duration`, so the gesture ends inside the bridge's 5 s script
/// limit, and the most clicks or key presses one request may repeat: the main thread sends
/// them all in one go, and the app does nothing else until it has.
const MAX_GESTURE_SECONDS: f64 = 3.0;
pub(crate) const MAX_REPEATS: u32 = 500;

/// A `hold` or `duration` in seconds, refused unless it is from 0 to MAX_GESTURE_SECONDS:
/// `Duration::from_secs_f64` panics on a negative or non-finite one.
fn gesture_seconds(name: &str, seconds: f64) -> Result<Duration, String> {
    Duration::try_from_secs_f64(seconds)
        .ok()
        .filter(|duration| duration.as_secs_f64() <= MAX_GESTURE_SECONDS)
        .ok_or_else(|| {
            format!("\"{name}\" is seconds, from 0 to {MAX_GESTURE_SECONDS}, not {seconds}")
        })
}

/// A scroll arrives as a run of wheel notches, as a mouse wheel sends it, so the
/// page sees each `wheel` and `scroll` event a person's would cause: notches of
/// about 40 px, at most 25 of them, so a long scroll spins the wheel faster
/// instead of for longer. The run goes to the main thread in one trip: a trip
/// per notch landed ~110 ms after the last (measured), so 1,000 px took ~3.5 s
/// and 1,700 px outran the bridge's 5 s script limit, still turning behind the
/// timeout. (A one-trip run once looked lossy; every loss followed a `ScrollBy`
/// whose offset WebKit's scrolling thread had not yet seen, fixed in
/// puppetScroll.ts.)
const WHEEL_STEP_PX: f64 = 40.0;
const MAX_WHEEL_NOTCHES: u32 = 25;

#[tauri::command]
pub(crate) async fn puppet_pointer(
    window: tauri::WebviewWindow,
    pointer: Pointer,
) -> Result<(), String> {
    if cfg!(not(debug_assertions)) {
        return Err("puppet_pointer exists in debug builds only".into());
    }
    let steps = steps(&pointer)?;
    crate::background_tasks::blocking(move || deliver(&window, &steps)).await
}

/// The event sequence for one gesture. Pure, so the sequence is testable
/// without a window.
fn steps(pointer: &Pointer) -> Result<Vec<Step>, String> {
    let right = match pointer.button.as_deref() {
        None | Some("left") => false,
        Some("right") => true,
        Some(other) => return Err(format!("button must be left or right, not {other}")),
    };
    let step = |phase, x, y, count, delay| Step {
        phase,
        right,
        x,
        y,
        count,
        delay,
        dx: 0.0,
        dy: 0.0,
    };
    match pointer.kind.as_str() {
        "click" => {
            let count = pointer.count.unwrap_or(1).max(1);
            if count > MAX_REPEATS {
                return Err(format!(
                    "\"count\" is clicks, at most {MAX_REPEATS}, not {count}"
                ));
            }
            if pointer.hold.is_some() && count > 1 {
                return Err("hold and count do not combine".into());
            }
            let release_after = pointer
                .hold
                .map(|hold| gesture_seconds("hold", hold))
                .transpose()?
                .unwrap_or(Duration::from_millis(40));
            Ok((1..=count)
                .flat_map(|nth| {
                    [
                        step(Phase::Down, pointer.x, pointer.y, nth, Duration::ZERO),
                        step(Phase::Up, pointer.x, pointer.y, nth, release_after),
                    ]
                })
                .collect())
        }
        "drag" => {
            let (Some(x2), Some(y2)) = (pointer.x2, pointer.y2) else {
                return Err("drag needs x2 and y2".into());
            };
            if x2 == pointer.x && y2 == pointer.y {
                // Eight moves to the same point would read as a jittery press, not a hold.
                return Err("a drag that does not move is a press: use click with \"hold\"".into());
            }
            let delay =
                gesture_seconds("duration", pointer.duration.unwrap_or(0.3))? / (DRAG_SAMPLES + 1);
            let mut out = vec![step(Phase::Down, pointer.x, pointer.y, 1, Duration::ZERO)];
            for sample in 1..=DRAG_SAMPLES {
                let t = f64::from(sample) / f64::from(DRAG_SAMPLES);
                out.push(step(
                    Phase::Dragged,
                    pointer.x + (x2 - pointer.x) * t,
                    pointer.y + (y2 - pointer.y) * t,
                    1,
                    delay,
                ));
            }
            out.push(step(Phase::Up, x2, y2, 1, delay));
            Ok(out)
        }
        "scroll" => {
            let (dx, dy) = (pointer.dx.unwrap_or(0.0), pointer.dy.unwrap_or(0.0));
            if dx == 0.0 && dy == 0.0 {
                return Err("scroll needs a non-zero dy (down is positive) or dx".into());
            }
            let notches = ((dx.abs().max(dy.abs()) / WHEEL_STEP_PX).ceil() as u32)
                .clamp(1, MAX_WHEEL_NOTCHES);
            let notch = |n: f64| n / f64::from(notches);
            Ok((0..notches)
                .map(|_| Step {
                    dx: notch(dx),
                    dy: notch(dy),
                    ..step(Phase::Wheel, pointer.x, pointer.y, 1, Duration::ZERO)
                })
                .collect())
        }
        other => Err(format!("kind must be click, drag or scroll, not {other}")),
    }
}

/// How long one trip to the main thread takes to land while the window is hidden
/// (measured ~95-110 ms). A gap shorter than this cannot be kept by pacing trips,
/// so those steps go together in one trip, back to back.
const ONE_TRIP: Duration = Duration::from_millis(100);

/// Send the steps on the main thread, pacing from this blocking thread so the UI
/// thread never sleeps mid-gesture. Steps closer together than `ONE_TRIP` (a
/// wheel run, a default drag, a click's press and release) share a trip; a
/// longer gap (a hold, a slow `duration`) is its own paced trip. One trip per
/// step made a default drag ~1 s whatever it asked for. Every point of the gesture
/// is checked against the view before its first event is sent, so a gesture that
/// leaves the view delivers nothing — not a press whose release never comes.
fn trips(steps: &[Step]) -> impl Iterator<Item = &[Step]> {
    steps.chunk_by(|_, next| next.delay < ONE_TRIP)
}

fn deliver(window: &tauri::WebviewWindow, steps: &[Step]) -> Result<(), String> {
    for (trip, batch) in trips(steps).enumerate() {
        std::thread::sleep(batch[0].delay);
        let batch = batch.to_vec();
        let gesture = (trip == 0).then(|| steps.to_vec());
        let (sender, receiver) = mpsc::channel();
        window
            .with_webview(move |webview| {
                let sent = gesture
                    .map_or(Ok(()), |gesture| {
                        let (width, height) = view_size(&webview)?;
                        check_bounds(&gesture, width, height)
                    })
                    .and_then(|()| {
                        batch
                            .iter()
                            .map(|step| send_event(&webview, *step))
                            .collect::<Result<Vec<_>, _>>()
                    });
                sender.send(sent).ok();
            })
            .map_err(|error| error.to_string())?;
        receiver
            .recv()
            .map_err(|_| "the main thread dropped the pointer event".to_string())??
            .into_iter()
            .try_for_each(settled)?;
    }
    Ok(())
}

/// What sending one event hands back. On macOS and Linux the web view has the event when
/// the call returns. On Windows DevTools answers later, on the UI thread's message loop,
/// so the answer is waited for off it, in [`settled`]: waiting on the UI thread would
/// block the loop that delivers it.
#[cfg(not(target_os = "windows"))]
pub(crate) type Sent = ();
#[cfg(target_os = "windows")]
pub(crate) type Sent = Vec<mpsc::Receiver<Result<(), String>>>;

#[cfg(not(target_os = "windows"))]
pub(crate) fn settled(_sent: Sent) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn settled(sent: Sent) -> Result<(), String> {
    sent.into_iter().try_for_each(|answer| {
        answer
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "WebView2 did not answer the DevTools input call within 5 s".to_string())?
    })
}

/// A gesture with a point outside the web view lands somewhere no click into this view
/// can reach: refuse all of it.
fn check_bounds(gesture: &[Step], width: f64, height: f64) -> Result<(), String> {
    match gesture
        .iter()
        .find(|step| step.x < 0.0 || step.y < 0.0 || step.x > width || step.y > height)
    {
        Some(step) => Err(format!(
            "({}, {}) is outside the web view, which is {width}x{height} CSS px",
            step.x, step.y
        )),
        None => Ok(()),
    }
}

/// How many of a mouse's smooth-scroll units move `pixels` in a web view `view_size` CSS px
/// long on that axis. WebKitGTK scales a mouse's unit by GTK's own scroll step, the view's
/// size to the power 2/3, truncated (`Scrollbar::pixelsPerLineStep(viewWidthOrHeight)`, used
/// by `WebKitWebViewBase`'s scroll handler): 123 px in a view 1378 px tall, measured as the
/// page's `wheel.deltaY`. Not the 40 px line step a touchpad's precise deltas get.
#[cfg(any(target_os = "linux", test))]
fn gtk_scroll_units(pixels: f64, view_size: f64) -> f64 {
    let step = view_size.powf(2.0 / 3.0).trunc();
    if step > 0.0 {
        pixels / step
    } else {
        0.0
    }
}

/// The DevTools `Input.dispatchMouseEvent` for one step. `buttons` says what is held, so a
/// move between a press and its release is a drag.
#[cfg(any(target_os = "windows", test))]
fn devtools_mouse_event(step: Step) -> serde_json::Value {
    let button = if step.right { "right" } else { "left" };
    let held = if step.right { 2 } else { 1 };
    let (x, y) = (step.x, step.y);
    match step.phase {
        Phase::Down => serde_json::json!({ "type": "mousePressed", "x": x, "y": y,
            "button": button, "buttons": held, "clickCount": step.count }),
        Phase::Dragged => serde_json::json!({ "type": "mouseMoved", "x": x, "y": y,
            "button": button, "buttons": held }),
        Phase::Up => serde_json::json!({ "type": "mouseReleased", "x": x, "y": y,
            "button": button, "buttons": 0, "clickCount": step.count }),
        Phase::Wheel => serde_json::json!({ "type": "mouseWheel", "x": x, "y": y,
            "deltaX": step.dx, "deltaY": step.dy }),
    }
}

/// Keep WebKit drawing while the window is hidden (on another space, or covered). WebKit stops
/// painting an occluded window to save power, so `qa-shot` and a ScreenCaptureKit recording of a
/// window the developer is not looking at came back as a blank page. The switch is WebKit SPI
/// (`WKWebViewPrivate.h`, not in the SDK): debug builds only, and asked for before it is used,
/// so a WebKit without it leaves those captures blank rather than crashing. The public
/// `inactiveSchedulingPolicy` covers a web view detached from its window, not an occluded one.
pub(crate) fn keep_drawing_when_hidden(handle: &tauri::AppHandle) {
    #[cfg(all(debug_assertions, target_os = "macos"))]
    {
        use tauri::Manager;
        for window in handle.webview_windows().into_values() {
            let _ = window.with_webview(|webview| {
                use objc2::runtime::AnyObject;
                use objc2::{msg_send, sel};
                // SAFETY: `with_webview` runs this on the main thread with the live WKWebView.
                let view: &AnyObject = unsafe { &*webview.inner().cast::<AnyObject>() };
                let selector = sel!(_setWindowOcclusionDetectionEnabled:);
                let responds: bool = unsafe { msg_send![view, respondsToSelector: selector] };
                if responds {
                    let _: () =
                        unsafe { msg_send![view, _setWindowOcclusionDetectionEnabled: false] };
                }
            });
        }
    }
    #[cfg(not(all(debug_assertions, target_os = "macos")))]
    let _ = handle;
}

#[cfg(test)]
mod tests;
