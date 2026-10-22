//! One real input on desktop, and what every gesture shares: the input model a target has,
//! aiming at a ref or at text, the page's own trace around the input, and waiting for the page
//! to settle. A phone's gesture is `screen::gesture`.

use super::*;

/// A gesture has settled when this long passes with no new event, or the ceiling hits, read
/// every poll. On desktop the input is handed to the web view before `puppet_pointer` returns,
/// so only its dispatch is left: 120 ms of quiet caught every event in 60 measured gestures,
/// where 400 ms cost ~0.3 s a gesture for nothing. The phones' `axe` and `adb` inject touches
/// on their own schedule, so they keep 400 ms until measured the same way.
pub(crate) const SETTLE_QUIET_DESKTOP: Duration = Duration::from_millis(120);

pub(crate) const SETTLE_POLL_DESKTOP: Duration = Duration::from_millis(25);

pub(crate) const SETTLE_QUIET_PHONE: Duration = Duration::from_millis(400);

pub(crate) const SETTLE_POLL_PHONE: Duration = Duration::from_millis(100);

pub(crate) const SETTLE_CEILING: Duration = Duration::from_secs(3);

/// The desktop's own input commands — `puppet_pointer` (`apps/tauri/src-tauri/src/puppet_input.rs`)
/// and `puppet_key` (`puppet_keys.rs`) — reached through the same bridge as everything else.
/// The app aims the events at its own window, so nothing maps a point on desktop.
pub(crate) fn desktop_input_script(command: &str, input: &Value) -> String {
    let argument = if command == "puppet_key" {
        "keys"
    } else {
        "pointer"
    };
    format!(
        "await window.__TAURI__.core.invoke({command:?}, {})",
        json!({ argument: input })
    )
}

/// The `puppet_key` argument for a desktop `type` or `press`: the keys go to whatever has
/// focus in the window, as a keyboard's do; the app checks the key names.
pub(crate) fn desktop_keys(name: &str, args: &Value) -> Result<Value, String> {
    let mut keys = json!({ "kind": name });
    if name == "type" {
        if !args["delay"].is_null() {
            return Err(
                "desktop types its keys at once: \"delay\" paces a phone's keyboard".into(),
            );
        }
        keys["text"] = json!(text_arg(args)?);
    } else {
        keys["key"] = args["key"]
            .as_str()
            .map(|key| json!(key))
            .ok_or("press needs {\"key\":\"Enter\"} (or a chord: \"Mod-b\", \"Shift-Tab\")")?;
        if !args["count"].is_null() {
            keys["count"] = json!(key_count(args)?);
        }
    }
    Ok(keys)
}

/// Poll `events` until the page has been quiet for the target's settle window (or the ceiling passes).
pub(crate) fn wait_for_settle(target: &Target, mut cursor: u64) -> Result<(), String> {
    let (quiet, poll) = match target {
        Target::Desktop(_) => (SETTLE_QUIET_DESKTOP, SETTLE_POLL_DESKTOP),
        Target::Native(..) => (SETTLE_QUIET_PHONE, SETTLE_POLL_PHONE),
    };
    let started = Instant::now();
    let mut last_change = Instant::now();
    while started.elapsed() < SETTLE_CEILING {
        std::thread::sleep(poll);
        // Once, not `call`: a touch that left the editor (Back) leaves no page to ask, and
        // retrying that refusal as "not ready yet" cost 5 s a poll.
        let reply = call_once(target, "events", &json!({ "since": cursor }))?;
        if reply.status != 200 {
            return Ok(());
        }
        let last = reply.body["last"].as_u64().unwrap_or(cursor);
        if last != cursor {
            cursor = last;
            last_change = Instant::now();
        } else if last_change.elapsed() >= quiet {
            return Ok(());
        }
    }
    Ok(())
}

/// begin → real touch → settle → end. The page brackets; this process only aims.
/// A mouse and a touch screen are different input models, and the gesture
/// names say which one is meant: `click` has a button and a click count, `tap`
/// has a hold, `scroll` is a wheel and a phone scrolls by swiping (`drag`).
/// Refuse the wrong one instead of translating it silently.
pub(crate) fn wrong_input_model(target: &Target, name: &str) -> Option<String> {
    match (target, name) {
        (Target::Native(..), "scroll") => Some(
            "a phone scrolls by swiping: use `drag` from where the finger lands to where it lifts \
             '{\"x\":N,\"y\":N,\"x2\":N,\"y2\":N}' (a swipe up, y2 < y, scrolls down)"
                .into(),
        ),
        (Target::Desktop(_), "tap") => Some(
            "desktop has a mouse, not a touch screen: use `click` \
             '{\"x\":N,\"y\":N[,\"button\":\"right\"][,\"count\":2]}'"
                .into(),
        ),
        (Target::Native(..), "click") => Some(
            "a phone has a touch screen, not a mouse: use `tap` '{\"x\":N,\"y\":N[,\"hold\":seconds]}'"
                .into(),
        ),
        _ => None,
    }
}

/// The `puppet_pointer` argument for a desktop gesture: the CLI's args plus the
/// gesture name as `kind`. Only presence is checked here; the app owns the
/// bounds check because it knows the web view's size.
pub(crate) fn desktop_pointer(name: &str, args: &Value) -> Result<Value, String> {
    number(args, "x")?;
    number(args, "y")?;
    if name == "scroll" && !(args["dy"].is_number() || args["dx"].is_number()) {
        return Err("scroll needs a numeric \"dy\" (down is positive) or \"dx\"".into());
    }
    if name == "drag" {
        number(args, "x2")?;
        number(args, "y2")?;
    }
    let mut pointer = args.clone();
    pointer["kind"] = json!(name);
    Ok(pointer)
}

/// `{"ref":"e12"}` in place of `x`,`y`: the centre of that element, as `show`
/// reports it. A rect's corner is where a click misses (it is the container's
/// padding); its centre is where a user clicks.
pub(crate) fn aim_at_ref(target: &Target, args: &mut Value) -> Result<(), String> {
    aim_args(args, |reference| {
        let shown = call(target, "show", &json!({ "ref": reference }))?;
        if shown.status != 200 {
            return Err(format!(
                "{reference}: {}",
                shown.body["error"].as_str().unwrap_or("no such element")
            ));
        }
        aim_of(&shown.body).ok_or_else(|| format!("{reference} has no rect to aim at"))
    })
}

/// `{"ref":…}` in the args as the point `aim` finds for it, written as `x`,`y`.
pub(crate) fn aim_args(
    args: &mut Value,
    aim: impl FnOnce(&str) -> Result<(f64, f64), String>,
) -> Result<(), String> {
    let Some(reference) = args["ref"].as_str().map(str::to_owned) else {
        return Ok(());
    };
    let (x, y) = aim(&reference)?;
    let object = args
        .as_object_mut()
        .ok_or("gesture args must be a JSON object")?;
    object.remove("ref");
    object.insert("x".into(), json!(x));
    object.insert("y".into(), json!(y));
    Ok(())
}

/// Where a tap or click on a row lands: the point the app says reaches it (`aim`, when
/// something covers its centre), else its centre.
pub(crate) fn aim_of(row: &Value) -> Option<(f64, f64)> {
    match (row["aim"]["x"].as_f64(), row["aim"]["y"].as_f64()) {
        (Some(x), Some(y)) => Some((x, y)),
        _ => centre_of(&row["rect"]),
    }
}

pub(crate) fn centre_of(rect: &Value) -> Option<(f64, f64)> {
    let side = |key: &str| rect[key].as_f64();
    let (x, y, w, h) = (side("x")?, side("y")?, side("w")?, side("h")?);
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    Some(((x + w / 2.0).round(), (y + h / 2.0).round()))
}

/// `{"text":"…"}` on a tap, click or drag, the text this gesture aims at; `type` takes `text`
/// as what it types, so it is never aimed.
pub(crate) fn aimed_text(name: &str, args: &Value) -> Option<String> {
    matches!(name, "tap" | "click" | "drag")
        .then(|| args["text"].as_str().map(str::to_owned))
        .flatten()
}

/// Aim a gesture at the text that shows in `rect`: a tap or click on its middle, a drag across.
pub(crate) fn aim_across(name: &str, args: &mut Value, rect: &Value) -> Result<(), String> {
    let side = |key: &str| rect[key].as_f64().unwrap_or(0.0);
    let (x, y, w, h) = (side("x"), side("y"), side("w"), side("h"));
    let object = args
        .as_object_mut()
        .ok_or("gesture args must be a JSON object")?;
    object.remove("text");
    let middle = (y + h / 2.0).round();
    if name == "drag" {
        object.insert("x".into(), json!((x + 1.0).round()));
        object.insert("y".into(), json!(middle));
        object.insert("x2".into(), json!((x + w - 1.0).round()));
        object.insert("y2".into(), json!(middle));
    } else {
        object.insert("x".into(), json!((x + w / 2.0).round()));
        object.insert("y".into(), json!(middle));
    }
    Ok(())
}

/// One real input on desktop, `text` or `ref` aimed first (`show`): text off screen is refused
/// with the way to bring it on, before anything is sent.
pub(crate) fn desktop_gesture(
    target: &Target,
    name: &str,
    mut args: Value,
) -> Result<Reply, String> {
    if let Some(text) = aimed_text(name, &args) {
        let shown = call(target, "show", &json!({ "text": text }))?;
        if shown.status != 200 {
            return Ok(shown);
        }
        aim_across(name, &mut args, &shown.body["rect"])?;
    }
    aim_at_ref(target, &mut args)?;
    gesture(target, name, &args)
}

/// begin → `deliver` → settle → end: the page's own trace around one real input, and the record
/// it closes with. Once begun it is closed on every way out: an open bracket cancels every drag
/// in the app until the next gesture ends one (puppetTrace.ts `beginGesture`).
pub(crate) fn traced(
    target: &Target,
    deliver: impl FnOnce() -> Result<(), String>,
) -> Result<Reply, String> {
    let begun = call(target, "trace", &json!({ "begin": true }))?;
    if begun.status != 200 {
        return Err(format!(
            "the page did not begin a trace: {}",
            compact(&begun.body)
        ));
    }
    // Once, not `call`: a touch that left the editor (Back) leaves no page to close it in.
    let end = || call_once(target, "trace", &json!({ "end": true }));
    if let Err(error) = deliver() {
        end().ok();
        return Err(error);
    }
    let settled = wait_for_settle(target, begun.body["eventCursor"].as_u64().unwrap_or(0));
    let ended = end();
    settled?;
    ended
}

/// One real input on desktop, bracketed by the page's own trace. Everything that can fail on
/// the way in is resolved before the bracket opens.
pub(crate) fn gesture(target: &Target, name: &str, args: &Value) -> Result<Reply, String> {
    if let Some(reason) = wrong_input_model(target, name) {
        return Err(reason);
    }
    let Target::Desktop(port) = target else {
        return Err("a phone's gestures go through screen::gesture".into());
    };
    let (command, input) = if matches!(name, "type" | "press") {
        ("puppet_key", desktop_keys(name, args)?)
    } else {
        ("puppet_pointer", desktop_pointer(name, args)?)
    };
    let app_before = app::read(target)?;
    let mut record = traced(target, || {
        bridge_execute_js(*port, &desktop_input_script(command, &input)).map(drop)
    })?;
    if record.status != 200 {
        return Ok(record);
    }
    // An input the page never saw is a failure, not an app that shrugged: its receipt would say
    // `no change`, as for a click the app ignored (M21).
    if event_count(&record.body) == 0 {
        return Ok(Reply::refusal(
            409,
            format!(
                "{name} at {} produced NO page events: the input was delivered but nothing in \
                 the web view received it. Usually a native window over it (a file picker, a \
                 system dialog). Screenshot the window to see what covers it, clear it, and try \
                 again.",
                compact(args)
            ),
        ));
    }
    if let Some(body) = record.body.as_object_mut() {
        body.insert(
            "gesture".into(),
            json!({ "name": name, "args": args, "command": [command, input] }),
        );
    }
    app::record(&mut record.body, &app_before, &app::read(target)?);
    Ok(record)
}
