//! What a phone gesture reached, as its receipt says it: the field that took the keys, or the
//! row a touch landed on and whether the app received the touch at all.

use super::*;

/// What `type` or `press` sent, and the row that had focus to take it. Android's Back is the
/// system's own key, taken by whatever is on top rather than by a field. `every` is the
/// measured milliseconds a paced key took, None for keys sent at once.
pub(super) fn keys_receipt(before: &View, name: &str, args: &Value, every: Option<u64>) -> Value {
    let sent = match (name, args["count"].as_u64()) {
        ("type", _) => args["text"].clone(),
        (_, Some(count)) if count > 1 => {
            json!(format!("{} ×{count}", args["key"].as_str().unwrap_or("?")))
        }
        _ => args["key"].clone(),
    };
    let into = before
        .rows
        .iter()
        .find(|row| {
            row["flags"]
                .as_array()
                .is_some_and(|flags| flags.contains(&json!("focused")))
        })
        .map(|row| json!({ "ref": row["ref"], "role": row["role"], "text": row["text"] }));
    json!({ "name": name, "sent": sent, "into": into, "every": every })
}

pub(crate) fn render_keys(keys: &Value) -> String {
    if !keys.is_object() {
        return String::new();
    }
    let sent = match keys["name"].as_str() {
        Some("type") => format!("type {}", quoted(&keys["sent"])),
        _ => format!("press {}", keys["sent"].as_str().unwrap_or("?")),
    };
    let sent = match keys["every"].as_u64() {
        Some(every) => format!("{sent} (a key every {every} ms)"),
        None => sent,
    };
    if keys["sent"]
        .as_str()
        .is_some_and(|sent| sent.split(' ').next() == Some("Back"))
    {
        return format!("{sent} (the system's Back, not the app's)\n");
    }
    if keys["into"].is_object() {
        format!("{sent} → {}\n", row_label(&keys["into"]))
    } else {
        format!("{sent} → no field had focus\n")
    }
}

/// The app's count of the touches it has received, before one is sent, and whether a window
/// the recorder does not see is up then (a menu the touch closes is gone by the time the
/// receipt asks). `None` from a build without the recorder: its receipts cannot say whether
/// a touch arrived.
pub(super) fn touch_cursor(target: &Target) -> Result<Option<(u64, bool)>, String> {
    let reply = call_once(target, "touches", &json!({}))?;
    Ok(reply.body["last"]
        .as_u64()
        .filter(|_| reply.status == 200)
        .map(|last| (last, reply.body["covered"] == json!(true))))
}

/// Where the touch landed on the screen as it was, and how many touches the app received:
/// left out under a window the recorder does not see, where the count says nothing.
pub(super) fn touch_receipt(
    target: &Target,
    before: &View,
    args: &Value,
    cursor: Option<(u64, bool)>,
) -> Result<Value, String> {
    let (Some(x), Some(y)) = (args["x"].as_f64(), args["y"].as_f64()) else {
        return Ok(Value::Null);
    };
    let on = row_at(&before.rows, x, y).map(|row| {
        json!({
            "ref": row["ref"], "role": row["role"], "text": row["text"],
            "control": row["handlers"].as_array().is_some_and(|handlers| {
                handlers.iter().any(|handler| handler != "scroll")
            }),
        })
    });
    let mut touch = json!({ "x": x.round() as i64, "y": y.round() as i64, "on": on });
    let Some((cursor, covered_before)) = cursor else {
        return Ok(touch);
    };
    let reply = call_once(target, "touches", &json!({ "since": cursor }))?;
    if !covered_before && reply.body["covered"] != json!(true) {
        touch["received"] = json!(reply.body["touches"].as_array().map_or(0, Vec::len));
    }
    Ok(touch)
}

/// A touch aimed at a row the app reported, which the app then never received: the one
/// failure the tool's exit status hides, so the action is refused with it. Not claimed when
/// nothing the app reported is under the point (a keyboard key goes to the keyboard, not
/// the app), nor while a window the recorder does not see was on top (an Android dialog),
/// where the receipt has no count.
pub(super) fn unreceived(
    platform: NativePlatform,
    name: &str,
    tool: &str,
    touch: &Value,
) -> Option<String> {
    touch["on"].as_object()?;
    if touch["received"] != json!(0) {
        return None;
    }
    let cause = match platform {
        NativePlatform::Ios => {
            "Usually DeviceHub (Xcode 27's simulator window): while it runs it takes every \
             booted simulator's touches. Quit it; `elements` and `do` still work."
        }
        NativePlatform::Android => {
            "Something outside the app is in front of it: another app, or a system dialog."
        }
    };
    Some(format!(
        "{name} at {},{} on {} never reached the app: {tool} exited 0, but the app \
         received no touch, so nothing was tried. {cause}",
        touch["x"],
        touch["y"],
        row_label(&touch["on"]),
    ))
}

/// The row a touch at a point reaches: the topmost one under it, taken as the last. Both
/// listeners send windows bottom to top. Within one, Android sends paint order (Compose's
/// semantics are z-sorted, a control after the row it sits in); iOS sends accessibility order,
/// not paint order, and drops clipped elements, so its rows there do not overlap. The editor
/// page's rows follow the native ones here, but the page is drawn under every native row over
/// its web view (a keyboard toolbar), so a native row comes first.
fn row_at(rows: &[Value], x: f64, y: f64) -> Option<&Value> {
    let side = |row: &Value, key: &str| row["rect"][key].as_f64().unwrap_or(0.0);
    rows.iter()
        .enumerate()
        .filter(|(_, row)| {
            let (left, top) = (side(row, "x"), side(row, "y"));
            x >= left && y >= top && x < left + side(row, "w") && y < top + side(row, "h")
        })
        .max_by_key(|(order, row)| (row["section"] != "editor", *order))
        .map(|(_, row)| row)
}

/// The receipt's first line on a phone: where the touch landed.
pub(crate) fn render_touch(touch: &Value) -> String {
    if !touch.is_object() {
        return String::new();
    }
    let at = format!("touch @{},{}", touch["x"], touch["y"]);
    let unreceived = if touch["received"] == json!(0) {
        " (the app received no touch)"
    } else {
        ""
    };
    match touch["on"].as_object() {
        None => format!("{at} → nothing the app reported{unreceived}\n"),
        Some(row) => format!(
            "{at} → {}{}{unreceived}\n",
            row_label(&touch["on"]),
            if row["control"] == json!(true) {
                ""
            } else {
                " (not a control)"
            },
        ),
    }
}

/// Said when a touch changed nothing and landed on something that takes no touch.
pub(crate) fn not_a_control_hint(touch: &Value) -> Option<String> {
    let row = touch["on"]
        .as_object()
        .filter(|row| row["control"] == json!(false))?;
    Some(format!(
        "{} is not a control, so nothing takes a touch there: aim at a row `elements` lists with tap\n",
        row["ref"].as_str().unwrap_or("?")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_line_says_what_was_sent_and_what_had_focus() {
        let field = json!({"ref": "n9", "role": "field", "text": "Find in note"});
        assert_eq!(
            render_keys(&json!({"name": "type", "sent": "seed", "into": field})),
            "type \"seed\" → n9 field \"Find in note\"\n"
        );
        assert_eq!(
            render_keys(&json!({"name": "press", "sent": "Enter", "into": null})),
            "press Enter → no field had focus\n"
        );
        assert_eq!(
            render_keys(&json!({"name": "press", "sent": "Back", "into": field})),
            "press Back (the system's Back, not the app's)\n"
        );
        assert_eq!(
            render_keys(&json!({"name": "press", "sent": "Backspace ×14", "into": field})),
            "press Backspace ×14 → n9 field \"Find in note\"\n"
        );
        assert_eq!(
            render_keys(&json!({"name": "type", "sent": "lease", "into": field, "every": 201})),
            "type \"lease\" (a key every 201 ms) → n9 field \"Find in note\"\n"
        );
        assert_eq!(render_keys(&Value::Null), "");
    }

    /// In the order a listener sends them: the row before the controls drawn in it.
    fn heading_and_button() -> Vec<Value> {
        vec![
            json!({"ref": "n6", "role": "row", "text": "recipes", "handlers": ["tap", "hold"],
                   "rect": {"x": 0, "y": 0, "w": 402, "h": 874}}),
            json!({"ref": "n1", "role": "button", "text": "Settings", "handlers": ["tap"],
                   "rect": {"x": 20, "y": 66, "w": 41, "h": 36}}),
            json!({"ref": "n58", "role": "heading", "text": "Notes", "handlers": [],
                   "rect": {"x": 16, "y": 120, "w": 94, "h": 41}}),
        ]
    }

    fn touch_on(rows: &[Value], x: f64, y: f64, received: usize) -> Value {
        let row = row_at(rows, x, y).unwrap();
        json!({"x": x as i64, "y": y as i64, "received": received, "on": {
            "ref": row["ref"], "role": row["role"], "text": row["text"],
            "control": row["handlers"].as_array().is_some_and(|h| !h.is_empty()),
        }})
    }

    #[test]
    fn a_touch_names_the_row_under_it_and_whether_it_is_a_control() {
        let rows = heading_and_button();
        let button = touch_on(&rows, 40.0, 84.0, 1);
        assert_eq!(
            render_touch(&button),
            "touch @40,84 → n1 button \"Settings\"\n"
        );
        assert_eq!(not_a_control_hint(&button), None);
        let heading = touch_on(&rows, 30.0, 140.0, 1);
        assert_eq!(
            render_touch(&heading),
            "touch @30,140 → n58 heading \"Notes\" (not a control)\n"
        );
        assert!(not_a_control_hint(&heading)
            .unwrap()
            .starts_with("n58 is not a control"));
    }

    /// A tap on the keyboard toolbar's Dismiss button, whose rect overlaps the end of the
    /// formatting strip scrolled under it and the editor's lines beneath the toolbar: the touch
    /// reached the button drawn on top, not the smaller row under it.
    #[test]
    fn a_touch_names_the_topmost_row_where_rects_overlap() {
        let rows = vec![
            json!({"ref": "n20", "role": "button", "text": "Heading 1", "handlers": ["tap"],
                   "section": "keyboard toolbar", "rect": {"x": 330, "y": 520, "w": 30, "h": 44}}),
            json!({"ref": "n21", "role": "button", "text": "Dismiss keyboard", "handlers": ["tap"],
                   "section": "keyboard toolbar", "rect": {"x": 340, "y": 520, "w": 62, "h": 44}}),
            json!({"ref": "e4", "role": "text", "text": "a line", "handlers": ["click"],
                   "section": "editor", "rect": {"x": 0, "y": 500, "w": 402, "h": 40}}),
        ];
        assert_eq!(row_at(&rows, 350.0, 530.0).unwrap()["ref"], "n21");
        assert_eq!(row_at(&rows, 335.0, 530.0).unwrap()["ref"], "n20");
        assert_eq!(row_at(&rows, 20.0, 510.0).unwrap()["ref"], "e4");
    }

    #[test]
    fn a_touch_the_app_never_received_fails_unless_nothing_reported_was_there_or_a_dialog_was_up() {
        let rows = heading_and_button();
        let missed = touch_on(&rows, 40.0, 84.0, 0);
        let error = unreceived(NativePlatform::Ios, "tap", "axe", &missed).unwrap();
        assert!(
            error.contains("on n1 button \"Settings\" never reached the app"),
            "{error}"
        );
        assert!(error.contains("DeviceHub"), "{error}");
        // Under a dialog the recorder does not see, the receipt has no count to go by.
        let mut covered = missed.clone();
        covered.as_object_mut().unwrap().remove("received");
        assert_eq!(
            unreceived(NativePlatform::Android, "tap", "adb", &covered),
            None
        );
        assert_eq!(
            unreceived(
                NativePlatform::Ios,
                "tap",
                "axe",
                &touch_on(&rows, 40.0, 84.0, 1)
            ),
            None
        );
        let on_nothing = json!({"x": 1, "y": 900, "on": null, "received": 0});
        assert_eq!(
            unreceived(NativePlatform::Ios, "tap", "axe", &on_nothing),
            None
        );
    }
}
