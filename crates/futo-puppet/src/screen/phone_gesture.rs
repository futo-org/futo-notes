//! `tap`/`drag` on a phone, or `type`/`press` into whatever has focus, sent by `axe` or `adb`;
//! its receipt closes on the screen before and after.

use super::gesture_receipt::{keys_receipt, touch_cursor, touch_receipt, unreceived};
use super::*;

/// `tap`/`drag` on a phone, aimed at screen units (or any row's ref, or text on screen), or
/// `type`/`press` into whatever has focus, sent by `axe` or `adb`. With the editor up the page's
/// own trace brackets it too, so the receipt keeps the events and handlers; either way it
/// closes on the screen before and after.
pub(crate) fn gesture(target: &Target, name: &str, args: &Value) -> Result<Reply, String> {
    if let Some(reason) = wrong_input_model(target, name) {
        return Err(reason);
    }
    let Target::Native(platform, _, device) = target else {
        return Err("phone gestures are the phones'".into());
    };
    let before = view(target)?;
    let mut args = args.clone();
    if let Some(refusal) = aim(target, &before, name, &mut args)? {
        return Ok(refusal);
    }
    let frame = before.frame();
    let tool = match platform {
        NativePlatform::Ios => "axe",
        NativePlatform::Android => "adb",
    };
    let arguments = |args: &Value| match platform {
        NativePlatform::Ios => axe_arguments(name, args, frame, device),
        NativePlatform::Android => adb_arguments(name, args, frame)
            .map(|gesture| [vec!["-s".to_string(), device.clone()], gesture].concat()),
    };
    let whole = arguments(&args)?;
    // Paced, every character is its own key press.
    let delay = if name == "type" {
        key_delay(&args)?
    } else {
        None
    };
    let sends = match delay {
        None => vec![whole.clone()],
        Some(_) => one_key_each(&args)
            .iter()
            .map(arguments)
            .collect::<Result<Vec<_>, String>>()?,
    };
    let keys = matches!(name, "type" | "press");
    let app_before = app::read(target)?;
    let touches = if keys { None } else { touch_cursor(target)? };
    let pace = std::cell::Cell::new(None);
    let deliver = || -> Result<(), String> {
        pace.set(send(tool, &sends, delay)?);
        Ok(())
    };
    // The page answers for a gesture while the editor is up, unless it left the editor (Back, a
    // sheet over it): then the page is no longer what answers for the screen.
    let traced_by_page = match before.webview {
        Some(_) => Some(traced(target, deliver)?).filter(|record| record.status == 200),
        None => {
            deliver()?;
            None
        }
    };
    let after = settle(target, &before, false)?;
    let (kind, reached) = if keys {
        ("keys", keys_receipt(&before, name, &args, pace.get()))
    } else {
        ("touch", touch_receipt(target, &before, &args, touches)?)
    };
    if let Some(why) = unreceived(*platform, name, tool, &reached) {
        return Ok(Reply::refusal(409, why));
    }
    let page = traced_by_page.is_some();
    let mut receipt = match (traced_by_page, before.page_offset()) {
        (Some(mut record), Some(offset)) => {
            shift(&mut record.body, offset);
            merge_change(&mut record.body, &before, &after);
            record.body
        }
        _ => json!({ "kind": name, "screen": before.screen, "diff": change(&before, &after) }),
    };
    app::record(&mut receipt, &app_before, &app::read(target)?);
    let untouched = event_count(&receipt) == 0 && after.same_as(&before);
    if name == "type" && untouched && !app::changed(&receipt) {
        return Ok(typed_into_nothing(&args));
    }
    // A touch inside the web view that the page never saw was taken by something native on
    // top of it: the predictive-text bar, a Paste callout (AGENTS.md M21). One on the chrome
    // around it is the chrome's, and its receipt is the screen.
    if page && !keys && untouched && in_page(&before, &args) {
        return Ok(Reply::refusal(
            409,
            format!(
                "{name} at {} produced NO page events and changed nothing: something native over \
                 the editor took it (on iOS the predictive-text bar over the lines below the \
                 caret, a Paste/Select callout). `elements` shows what is on top.",
                compact(&args)
            ),
        ));
    }
    if let Some(object) = receipt.as_object_mut() {
        object.insert(
            "gesture".into(),
            json!({ "name": name, "args": args, "command": [tool, whole] }),
        );
        object.insert(kind.into(), reached);
    }
    Ok(Reply {
        status: 200,
        body: receipt,
    })
}

/// Aim `{"ref"}` at that row, and `{"text"}` at the one place on screen that shows it: a native
/// row, or that text in the editor's page, in screen units. Text two places show is refused
/// with both, as the page refuses two occurrences; text nothing shows, with the page's way to
/// bring it on.
pub(crate) fn aim(
    target: &Target,
    before: &View,
    name: &str,
    args: &mut Value,
) -> Result<Option<Reply>, String> {
    if let Some(text) = aimed_text(name, args) {
        let native_rows: Vec<&Value> = before
            .rows
            .iter()
            .filter(|row| {
                row["section"] != "editor"
                    && row["text"]
                        .as_str()
                        .is_some_and(|shown| shown.contains(&text))
            })
            .collect();
        let page = match before.page_offset() {
            Some(offset) => {
                let mut shown = call(target, "show", &json!({ "text": text }))?;
                if shown.status == 200 {
                    shift(&mut shown.body, offset);
                }
                Some(shown)
            }
            None => None,
        };
        let mut places: Vec<String> = native_rows
            .iter()
            .map(|row| format!("{} {}", row["ref"].as_str().unwrap_or("?"), row["text"]))
            .collect();
        if let Some(shown) = page.as_ref().filter(|shown| shown.status == 200) {
            places.push(format!("the editor's line {}", shown.body["line"]));
        }
        if places.len() > 1 {
            return Ok(Some(Reply::refusal(
                409,
                format!(
                    "{} places on this screen show {text:?} ({}): aim by `ref`, or extend the \
                     text until one place shows it",
                    places.len(),
                    places.join(", ")
                ),
            )));
        }
        match (native_rows.first(), page) {
            // A tap lands where its row takes one, as `{"ref"}` does.
            (Some(row), _) if name != "drag" => {
                args["ref"] = row["ref"].clone();
                if let Some(object) = args.as_object_mut() {
                    object.remove("text");
                }
            }
            (Some(row), _) => aim_across(name, args, &row["rect"])?,
            (None, Some(shown)) if shown.status == 200 => {
                aim_across(name, args, &shown.body["rect"])?
            }
            (None, Some(refused)) => return Ok(Some(refused)),
            (None, None) => {
                return Ok(Some(Reply::refusal(
                    404,
                    format!(
                        "no row on this screen ({}) shows {text:?}: `elements` lists what does",
                        before.screen
                    ),
                )))
            }
        }
    }
    aim_args(args, |reference| {
        let row = before
            .rows
            .iter()
            .find(|row| row["ref"] == json!(reference))
            .ok_or_else(|| {
                format!(
                    "{reference} is not on this screen ({}); `elements` lists what is",
                    before.screen
                )
            })?;
        aim_of(row).ok_or_else(|| format!("{reference} has no size"))
    })?;
    Ok(None)
}

/// Run each of `tool`'s command lines, a paced `type`'s at start + i × delay: a send slower than
/// the delay (an iOS one connects for ~115 ms) goes at once, so the pace is the delay or the
/// fastest the tool sends, whichever is slower. Answers the milliseconds a paced key took.
fn send(tool: &str, sends: &[Vec<String>], delay: Option<Duration>) -> Result<Option<u64>, String> {
    let start = Instant::now();
    let mut last_sent = Duration::ZERO;
    for (index, tool_args) in sends.iter().enumerate() {
        if let Some(due) = delay.map(|delay| start + delay * index as u32) {
            std::thread::sleep(due.saturating_duration_since(Instant::now()));
        }
        last_sent = start.elapsed();
        let output = Command::new(tool)
            .args(tool_args)
            .output()
            .map_err(|e| format!("could not run {tool}: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "{tool} {} failed: {}",
                tool_args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    Ok((delay.is_some() && sends.len() > 1)
        .then(|| last_sent.as_millis() as u64 / (sends.len() as u64 - 1)))
}

/// Whether the gesture's point is inside the editor's web view.
fn in_page(before: &View, args: &Value) -> bool {
    let (Some(webview), Some(x), Some(y)) =
        (before.webview, args["x"].as_f64(), args["y"].as_f64())
    else {
        return false;
    };
    x >= webview.x && y >= webview.y && x <= webview.x + webview.w && y <= webview.y + webview.h
}

/// A paced `type` as its key presses: one `type` of each character.
pub(crate) fn one_key_each(args: &Value) -> Vec<Value> {
    let text = args["text"].as_str().unwrap_or_default();
    text.chars()
        .map(|character| {
            let mut one = args.clone();
            one["text"] = json!(character.to_string());
            one
        })
        .collect()
}

/// Text typed with nothing focused went nowhere, and saying `no change` would read as a
/// field that ignored it.
fn typed_into_nothing(args: &Value) -> Reply {
    Reply::refusal(
        409,
        format!(
            "type {} changed nothing: no field had the keyboard's focus. Tap one first \
             (`elements` flags the focused row)",
            compact(&args["text"])
        ),
    )
}
