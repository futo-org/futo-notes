//! A gesture's arguments: which each gesture takes, and how the phones' input tools take them —
//! a screen point, checked against the screen and scaled to device units, and the `axe` (iOS)
//! and `adb shell input` (Android) command lines for a `tap`, `drag`, `type` or `press`.

use super::*;

/// What each gesture takes, beside the CLI's own `json`. The phones' tools read only what they
/// know, so a misspelled `hold` sent a short tap: anything else is refused, as desktop's input
/// commands refuse it (`deny_unknown_fields`).
const GESTURE_ARGUMENTS: [(&str, &[&str]); 6] = [
    (
        "click",
        &["x", "y", "ref", "text", "hold", "button", "count"],
    ),
    ("tap", &["x", "y", "ref", "text", "hold"]),
    ("drag", &["x", "y", "x2", "y2", "ref", "text", "duration"]),
    ("scroll", &["x", "y", "ref", "dx", "dy"]),
    ("type", &["text", "delay"]),
    ("press", &["key", "count"]),
];

/// What is wrong with a gesture's arguments before anything is asked: a key it does not take,
/// two aims at once, a hold or duration that is not a number of seconds.
pub(crate) fn gesture_argument_error(name: &str, args: &Value) -> Option<String> {
    let takes = GESTURE_ARGUMENTS
        .iter()
        .find(|(gesture, _)| *gesture == name)?
        .1;
    let given = args.as_object()?;
    let has = |key: &str| given.contains_key(key);
    if matches!(name, "type" | "press") && (has("ref") || has("x") || has("y")) {
        return Some(format!(
            "{name} goes to whatever has focus, not to a point: tap or click the field first, then {name}"
        ));
    }
    if let Some(unknown) = given
        .keys()
        .find(|key| *key != "json" && !takes.contains(&key.as_str()))
    {
        return Some(format!(
            "{name} takes {}, not \"{unknown}\"",
            takes.join(", ")
        ));
    }
    if has("text") && name != "type" && ["x", "y", "x2", "y2", "ref"].iter().any(|key| has(key)) {
        return Some(format!(
            "{name} aims at \"text\" or at \"ref\"/\"x\",\"y\", not both"
        ));
    }
    if has("ref") && (has("x") || has("y")) {
        return Some("give either \"ref\" or \"x\",\"y\", not both".into());
    }
    let seconds = ["hold", "duration"].into_iter().find(|key| {
        given
            .get(*key)
            .is_some_and(|value| !value.as_f64().is_some_and(|seconds| seconds > 0.0))
    })?;
    Some(format!(
        "{name}'s \"{seconds}\" is seconds, a number above 0, not {}",
        given[seconds]
    ))
}

pub(crate) fn number(args: &Value, key: &str) -> Result<f64, String> {
    args[key]
        .as_f64()
        .ok_or_else(|| format!("needs a numeric \"{key}\""))
}

/// A point in the screen units `elements` reports, as the device units a touch is sent in
/// (points on iOS, where the scale is 1; pixels on Android, at the display density).
///
/// Refuses a point off the screen: a coordinate read off a screenshot is in the image's
/// pixels, not the screen's units, and the touch it aims lands somewhere else or nowhere.
/// That failure is invisible — the gesture is delivered, the CLI exits 0, and the receipt
/// says `no change` (AGENTS.md M21) — so it is refused before anything is sent.
fn screen_point(args: &Value, frame: Frame, x: &str, y: &str) -> Result<(f64, f64), String> {
    let (screen_x, screen_y) = (number(args, x)?, number(args, y)?);
    if screen_x < 0.0 || screen_y < 0.0 || screen_x > frame.width || screen_y > frame.height {
        return Err(format!(
            "({screen_x}, {screen_y}) is off the screen, which is {}x{} in the units `elements` \
             reports (points on iOS, dp on Android), not a screenshot's pixels",
            frame.width, frame.height
        ));
    }
    Ok((screen_x * frame.scale, screen_y * frame.scale))
}

/// The `axe` invocation for one gesture, aimed in screen points.
pub(crate) fn axe_arguments(
    gesture: &str,
    args: &Value,
    frame: Frame,
    udid: &str,
) -> Result<Vec<String>, String> {
    let point = |x: &str, y: &str| screen_point(args, frame, x, y);
    let s = |v: f64| format!("{v:.1}");
    let mut out: Vec<String> = match gesture {
        "tap" => {
            let (x, y) = point("x", "y")?;
            // A person's tap lasts about a tenth of a second. `axe tap` lasts none, and
            // SwiftUI's Toggle ignores that: axe exits 0 and the switch stays as it was
            // (measured 2026-09-30, with and without the app's touch recorder).
            let hold = args["hold"].as_f64().unwrap_or(0.1);
            vec![
                "touch".into(),
                "-x".into(),
                s(x),
                "-y".into(),
                s(y),
                "--down".into(),
                "--up".into(),
                "--delay".into(),
                s(hold),
            ]
        }
        "drag" => {
            let (x, y) = point("x", "y")?;
            let (x2, y2) = point("x2", "y2")?;
            let mut v = vec![
                "drag".into(),
                "--start-x".into(),
                s(x),
                "--start-y".into(),
                s(y),
                "--end-x".into(),
                s(x2),
                "--end-y".into(),
                s(y2),
            ];
            if let Some(duration) = args["duration"].as_f64() {
                v.extend(["--duration".into(), s(duration)]);
            }
            v
        }
        // After `--`, so text that starts with a dash is typed, not read as a flag.
        "type" => {
            return Ok(vec![
                "type".into(),
                "--udid".into(),
                udid.into(),
                "--".into(),
                typed_text(args)?,
            ])
        }
        "press" => {
            let code = key_code(args, NativePlatform::Ios)?.to_string();
            match key_count(args)? {
                1 => vec!["key".into(), code],
                count => vec![
                    "key-sequence".into(),
                    "--keycodes".into(),
                    vec![code; count].join(","),
                ],
            }
        }
        other => return Err(format!("no such gesture: {other}")),
    };
    out.extend(["--udid".into(), udid.into()]);
    Ok(out)
}

/// The keys `press` sends, by the names the editor's `Press` verb takes: the HID usage `axe
/// key` sends on iOS and the keycode `input keyevent` sends on Android. `Back` is Android's
/// system Back, which iOS does not have.
const KEYS: [(&str, Option<u16>, u16); 14] = [
    ("Enter", Some(40), 66),
    ("Backspace", Some(42), 67),
    ("Delete", Some(76), 112),
    ("Tab", Some(43), 61),
    ("Escape", Some(41), 111),
    ("Home", Some(74), 122),
    ("End", Some(77), 123),
    ("PageUp", Some(75), 92),
    ("PageDown", Some(78), 93),
    ("ArrowUp", Some(82), 19),
    ("ArrowDown", Some(81), 20),
    ("ArrowLeft", Some(80), 21),
    ("ArrowRight", Some(79), 22),
    ("Back", None, 4),
];

fn key_code(args: &Value, platform: NativePlatform) -> Result<u16, String> {
    let name = args["key"]
        .as_str()
        .ok_or("press needs {\"key\":\"Enter\"}")?;
    let Some((_, ios, android)) = KEYS.iter().find(|(key, ..)| *key == name) else {
        let names: Vec<&str> = KEYS.iter().map(|(key, ..)| *key).collect();
        let character = if matches!(name.as_bytes(), [b' '..=b'~']) {
            format!(
                " A character is typed: type {}.",
                shell_json(&json!({ "text": name }))
            )
        } else {
            String::new()
        };
        return Err(format!(
            "no key named {name:?}; press knows {}.{character} In the editor: {}",
            names.join(", "),
            editor_call("press", args)
        ));
    };
    match platform {
        NativePlatform::Ios => ios.ok_or_else(|| {
            "iOS has no system Back key. The app's own Back is `do GoBack`: its top bar's back \
             button, which the edge swipe also triggers"
                .to_string()
        }),
        NativePlatform::Android => Ok(*android),
    }
}

/// `type`'s `delay`: the milliseconds from one key press to the next, as a person types, to
/// reproduce what only shows at human speed. None sends the text at once.
pub(crate) fn key_delay(args: &Value) -> Result<Option<Duration>, String> {
    match &args["delay"] {
        Value::Null => Ok(None),
        delay => delay
            .as_u64()
            .filter(|ms| (1..=1000).contains(ms))
            .map(|ms| Some(Duration::from_millis(ms)))
            .ok_or_else(|| {
                format!(
                    "type's \"delay\" is the milliseconds between key presses, a whole number \
                     from 1 to 1000, not {delay}"
                )
            }),
    }
}

/// How many times `press` sends its key: `count`, once without one. One command sends them
/// all, so a run of Backspaces is one action with one receipt.
pub(crate) fn key_count(args: &Value) -> Result<usize, String> {
    match &args["count"] {
        Value::Null => Ok(1),
        count => count
            .as_u64()
            .filter(|count| *count >= 1)
            .map(|count| count as usize)
            .ok_or_else(|| {
                format!("press's \"count\" is how many times, a whole number from 1, not {count}")
            }),
    }
}

/// `type`'s text: any but the empty string.
pub(crate) fn text_arg(args: &Value) -> Result<&str, String> {
    args["text"]
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "type needs {\"text\":\"…\"}".to_string())
}

/// The text `type` sends as key presses. `axe` and `adb input` type what a US keyboard has
/// and nothing else, so anything outside printable ASCII is refused rather than dropped.
fn typed_text(args: &Value) -> Result<String, String> {
    let text = text_arg(args)?;
    if let Some(other) = text.chars().find(|c| !(' '..='~').contains(c)) {
        let editor = editor_call("type", args);
        return Err(if other == '\n' {
            format!(
                "type sends real key presses, and a line break is the Enter key: \
                 press '{{\"key\":\"Enter\"}}' between the lines, or in the editor {editor}"
            )
        } else {
            format!(
                "type sends real key presses, and the simulator's and emulator's keyboards type \
                 only US-keyboard characters, not {other:?}. In the editor: {editor}; another \
                 field has its own verb in `actions`"
            )
        });
    }
    Ok(text.to_string())
}

/// `input text` runs in the device's shell, which splits on spaces: quoted whole, a space
/// spelled `%s` the way `input` reads it.
fn adb_text(text: &str) -> String {
    format!("'{}'", text.replace(' ', "%s").replace('\'', r"'\''"))
}

/// The `adb` invocation for one gesture. `input` aims in device pixels and takes
/// whole numbers; a hold is a zero-length swipe, which is how Android spells a
/// long press. The caller names the device, this worktree's claim.
pub(crate) fn adb_arguments(
    gesture: &str,
    args: &Value,
    frame: Frame,
) -> Result<Vec<String>, String> {
    let point = |x: &str, y: &str| screen_point(args, frame, x, y);
    let s = |v: f64| format!("{}", v.round() as i64);
    let ms = |seconds: f64| format!("{}", (seconds * 1000.0).round() as i64);
    let mut out: Vec<String> = vec!["shell".into(), "input".into()];
    match gesture {
        "tap" => {
            let (x, y) = point("x", "y")?;
            match args["hold"].as_f64() {
                Some(hold) => out.extend(["swipe".into(), s(x), s(y), s(x), s(y), ms(hold)]),
                None => out.extend(["tap".into(), s(x), s(y)]),
            }
        }
        "drag" => {
            let (x, y) = point("x", "y")?;
            let (x2, y2) = point("x2", "y2")?;
            out.extend([
                "swipe".into(),
                s(x),
                s(y),
                s(x2),
                s(y2),
                ms(args["duration"].as_f64().unwrap_or(0.3)),
            ]);
        }
        "type" => {
            let text = typed_text(args)?;
            // `input text` reads `%s` as a space and has no way to type it as written.
            if text.contains("%s") {
                return Err(format!(
                    "Android's `input text` types \"%s\" as a space: send it as two types, the \
                     first ending in % and the next starting with s, or in the editor {}",
                    editor_call("type", args)
                ));
            }
            out.extend(["text".into(), adb_text(&text)]);
        }
        "press" => {
            let code = key_code(args, NativePlatform::Android)?.to_string();
            out.push("keyevent".into());
            out.extend(vec![code; key_count(args)?]);
        }
        other => return Err(format!("no such gesture: {other}")),
    }
    Ok(out)
}

/// A phone's screen as the box a touch is aimed into: its size in the units `elements`
/// reports, and how many device units one of them is.
#[derive(Clone, Copy)]
pub(crate) struct Frame {
    pub(crate) scale: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[cfg(test)]
mod frame_tests {
    use super::{screen_point, Frame};
    use serde_json::json;

    /// An Android phone: 360×800 dp at a density of 3.
    const SCREEN: Frame = Frame {
        scale: 3.0,
        width: 360.0,
        height: 800.0,
    };

    #[test]
    fn a_screen_point_becomes_device_units() {
        let point = screen_point(&json!({"x": 58, "y": 100}), SCREEN, "x", "y").expect("on screen");
        assert_eq!(point, (174.0, 300.0));
    }

    /// A coordinate read off a screenshot is in the image's pixels, so it aims somewhere
    /// else or off the screen, and the delivered touch reads as an app that ignored it.
    /// Refuse instead (AGENTS.md M21).
    #[test]
    fn a_point_off_the_screen_is_refused_with_its_size() {
        let error = match screen_point(&json!({"x": 1080, "y": 112}), SCREEN, "x", "y") {
            Err(error) => error,
            Ok(point) => panic!("expected a refusal, got {point:?}"),
        };
        assert!(error.contains("off the screen"), "{error}");
        assert!(error.contains("360"), "{error}");
        assert!(screen_point(&json!({"x": 10, "y": -1}), SCREEN, "x", "y").is_err());
    }
}
