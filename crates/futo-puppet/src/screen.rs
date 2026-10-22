//! One phone screen, one outline: what `elements` shows and what every receipt diffs, the
//! same on a native screen and in the editor.
//!
//! A phone screen is the native views the app's accessibility reports (`/tree`, read into
//! rows by native.rs) and, while a note is open, the editor's web page beside them. They
//! are one screen to a person, so they are one list here, in one coordinate space: the
//! page's CSS pixels are shifted by the web view's place on screen into the points (iOS)
//! or dp (Android) the native rows use, and every point the agent sends back is shifted
//! the other way. Desktop has no native half: its window is the page, which answers for
//! itself (desktop_bridge.rs).

use super::*;

mod gesture_receipt;
mod outline;
mod phone_gesture;
mod row_verbs;

pub(crate) use gesture_receipt::{not_a_control_hint, render_keys, render_touch};
pub(crate) use outline::render_outline;
pub(crate) use phone_gesture::gesture;
#[cfg(test)]
pub(crate) use phone_gesture::{aim, one_key_each};
pub(crate) use row_verbs::{needs_row, row_refusal};

const NATIVE_REFS_FILE: &str = ".puppet/native-refs.json";

/// A phone screen as a person sees it right now.
#[derive(Clone)]
pub(crate) struct View {
    pub screen: String,
    pub size: native::Rect,
    /// Device units per screen unit: 1 on iOS (points), the density on Android (pixels).
    pub scale: f64,
    pub platform: NativePlatform,
    pub rows: Vec<Value>,
    pub scroll: Vec<Value>,
    /// With the editor on screen (no sheet over it): the web view's box in screen units.
    pub webview: Option<native::Rect>,
    /// A push or presentation is still running, so this is not yet what the screen will show.
    pub moving: bool,
    /// The editor's page says its note has loaded (`state.editor.ready`).
    pub ready: bool,
}

impl View {
    pub fn unit(&self) -> &'static str {
        match self.platform {
            NativePlatform::Ios => "pt",
            NativePlatform::Android => "dp",
        }
    }

    /// The whole screen as the box a touch is aimed into.
    pub fn frame(&self) -> Frame {
        Frame {
            scale: self.scale,
            width: self.size.w,
            height: self.size.h,
        }
    }

    pub fn body(&self) -> Value {
        json!({
            "screen": self.screen,
            "size": {
                "w": self.size.w.round() as i64,
                "h": self.size.h.round() as i64,
                "unit": self.unit(),
            },
            "elements": self.rows,
            "scroll": self.scroll,
        })
    }

    /// Where the page's CSS pixels sit in screen units, when the editor is up.
    pub fn page_offset(&self) -> Option<(f64, f64)> {
        self.webview.map(|rect| (rect.x, rect.y))
    }

    fn same_as(&self, other: &View) -> bool {
        self.screen == other.screen && self.rows == other.rows
    }
}

/// Shift every point and rect in a page reply by `(dx, dy)`: CSS pixels to screen units
/// and back. A point is any object with a numeric `x` and `y`: rects, event positions.
pub(crate) fn shift(value: &mut Value, (dx, dy): (f64, f64)) {
    match value {
        Value::Object(object) => {
            if let (Some(x), Some(y)) = (
                object.get("x").and_then(Value::as_f64),
                object.get("y").and_then(Value::as_f64),
            ) {
                object.insert("x".into(), json!((x + dx).round() as i64));
                object.insert("y".into(), json!((y + dy).round() as i64));
            }
            for child in object.values_mut() {
                if child.is_object() || child.is_array() {
                    shift(child, (dx, dy));
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| shift(item, (dx, dy))),
        _ => {}
    }
}

/// The phone's screen: its native rows, plus the page's while the editor is up.
pub(crate) fn view(target: &Target) -> Result<View, String> {
    let Target::Native(platform, port, device) = target else {
        return Err("a native view is the phones'".into());
    };
    let state = call(target, "state", &json!({}))?;
    let screen = state.body["screen"].as_str().unwrap_or("").to_string();
    let editor = screen.starts_with("editor:") && state.body["sheet"].is_null();
    let body = phone_tree(*platform, *port, device)?;
    let tree = native::from_tree(&body);
    let reported = body["nodes"]
        .as_array()
        .is_some_and(|nodes| !nodes.is_empty());
    if *platform == NativePlatform::Ios && !reported && accessibility_off(device) {
        return Err(accessibility_off_error(device));
    }
    let mut rows = with_refs(*platform, |refs| refs.rows(&tree.nodes));
    let mut scroll = tree.scroll;
    let moving = tree.moving;
    let webview = if editor && body["webview"].is_object() {
        let side = |key: &str| body["webview"][key].as_f64().unwrap_or(0.0) / tree.scale;
        Some(native::Rect {
            x: side("x"),
            y: side("y"),
            w: side("w"),
            h: side("h"),
        })
    } else {
        None
    };
    if let Some(rect) = webview {
        let mut page = call(target, "elements", &json!({}))?;
        // A page left out would read as a screen with no editor on it.
        if page.status != 200 {
            return Err(format!(
                "the editor is on screen but its page did not answer `elements` (HTTP {}): {}",
                page.status,
                compact(&page.body)
            ));
        }
        shift(&mut page.body, (rect.x, rect.y));
        for mut row in page.body["elements"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            row["section"] = json!("editor");
            rows.push(row);
        }
        for mut entry in page.body["scroll"].as_array().cloned().unwrap_or_default() {
            entry["section"] = json!("editor");
            scroll.push(entry);
        }
    }
    Ok(View {
        screen,
        size: tree.screen,
        scale: tree.scale,
        platform: *platform,
        rows,
        scroll,
        webview,
        moving,
        ready: state.body["editor"]["ready"] == json!(true),
    })
}

/// Whether the simulator has application accessibility switched off. The iOS reader walks the
/// app's accessibility tree, which iOS builds only while it is on, so every read is empty —
/// an empty screen that looks like an answer. Asked only when a read came back empty (a
/// `simctl` round trip costs about 0.25 s); a setting it cannot read counts as off.
fn accessibility_off(udid: &str) -> bool {
    Command::new("xcrun")
        .args([
            "simctl",
            "spawn",
            udid,
            "defaults",
            "read",
            "com.apple.Accessibility",
        ])
        .arg("ApplicationAccessibilityEnabled")
        .output()
        .map_or(true, |output| {
            String::from_utf8_lossy(&output.stdout).trim() != "1"
        })
}

fn accessibility_off_error(udid: &str) -> String {
    format!(
        "the iOS app cannot read its own screen: accessibility is switched OFF on simulator {udid}.\n\
         The screen reader walks the app's accessibility tree, and iOS builds that tree only while \
         the simulator's ApplicationAccessibilityEnabled setting is on, so every read is empty.\n\
         Fix: just ios-native   (switches it on, then reinstalls and relaunches the app)\n\
         By hand: xcrun simctl spawn {udid} defaults write com.apple.Accessibility \
         ApplicationAccessibilityEnabled -bool true\n\
         then relaunch the app: it reads the setting at launch."
    )
}

/// Native refs outlive the call that made them, per phone, in `.puppet/`. One call at a time
/// reads and rewrites them (two at once each numbered from where the file left off and handed
/// one ref to two elements), and the file is replaced whole, so a reader never sees half of it.
fn with_refs(
    platform: NativePlatform,
    assign: impl FnOnce(&mut native::Refs) -> Vec<Value>,
) -> Vec<Value> {
    let path = repo_root().join(NATIVE_REFS_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    // Held until it drops, at the end of this call.
    let lock = std::fs::File::create(path.with_extension("lock"));
    if let Ok(lock) = &lock {
        lock.lock().ok();
    }
    let mut stored: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let key = platform.name();
    let mut refs = native::Refs::from_json(&stored[key]);
    let rows = assign(&mut refs);
    stored[key] = refs.to_json();
    let written = path.with_extension("json.tmp");
    if std::fs::write(&written, stored.to_string()).is_ok() {
        std::fs::rename(&written, &path).ok();
    }
    rows
}

/// Read the screen until it has held still for the phone's settle window: a push, a
/// sheet's slide and a fling's momentum all end there. A read costs tens of milliseconds,
/// and a touch is injected on the device's own schedule, so a read or two right after it
/// can still show the screen before it (measured: a GoBack's sheet still sliding away).
/// `quick`: an editor verb whose page already settled — one read, and the wait only when
/// that read shows the screen moved, so typing does not pay the window every keystroke.
pub(crate) fn settle(target: &Target, before: &View, quick: bool) -> Result<View, String> {
    let started = Instant::now();
    let mut last = view(target)?;
    if quick && !last.moving && last.same_as(before) {
        return Ok(last);
    }
    let mut still_since = Instant::now();
    loop {
        std::thread::sleep(SETTLE_POLL_PHONE);
        let next = view(target)?;
        // A note that just opened is still loading until its page says it is ready.
        let loading = next.webview.is_some() && !next.ready;
        if !next.same_as(&last) || loading || next.moving {
            still_since = Instant::now();
        }
        last = next;
        if still_since.elapsed() >= SETTLE_QUIET_PHONE || started.elapsed() > SETTLE_CEILING {
            return Ok(last);
        }
    }
}

/// What an action changed: the rows that came, went or changed on a screen that stayed,
/// or, on a new screen, everything it now shows (`now`).
pub(crate) fn change(before: &View, after: &View) -> Value {
    if after.screen == before.screen {
        json!({ "elements": native::diff(&before.rows, &after.rows) })
    } else {
        json!({ "screen": [before.screen, after.screen], "now": after.rows })
    }
}

/// Put the whole screen's change into a page receipt, in place of the page's own element
/// diff (CSS pixels, page rows only): the document, selection and shell keys stay.
pub(crate) fn merge_change(receipt: &mut Value, before: &View, after: &View) {
    if let (Some(diff), Value::Object(whole)) = (app::receipt_diff(receipt), change(before, after))
    {
        diff.remove("elements");
        diff.extend(whole);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_points_and_rects_shift_into_screen_units_and_nothing_else_moves() {
        let mut reply = json!({
            "elements": [{"ref": "e1", "rect": {"x": 10, "y": 20, "w": 100, "h": 30}}],
            "events": [{"type": "click", "x": 5, "y": 6}],
            "doc": {"from": 3, "to": 9},
        });
        shift(&mut reply, (0.0, 258.0));
        assert_eq!(
            reply["elements"][0]["rect"],
            json!({"x": 10, "y": 278, "w": 100, "h": 30})
        );
        assert_eq!(reply["events"][0]["y"], json!(264));
        assert_eq!(reply["doc"], json!({"from": 3, "to": 9}));
    }
}
