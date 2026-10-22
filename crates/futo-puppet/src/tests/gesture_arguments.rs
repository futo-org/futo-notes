use super::*;

#[test]
fn axe_arguments_aim_in_screen_points() {
    // iOS touches are points, so a screen point is sent as it is.
    let frame = Frame {
        scale: 1.0,
        width: 402.0,
        height: 874.0,
    };
    assert_eq!(
        axe_arguments("tap", &json!({"x": 40, "y": 163.5}), frame, "UDID").unwrap(),
        strings(&[
            "touch", "-x", "40.0", "-y", "163.5", "--down", "--up", "--delay", "0.1", "--udid",
            "UDID"
        ])
    );
    assert_eq!(
        axe_arguments(
            "tap",
            &json!({"x": 40, "y": 163.5, "hold": 1}),
            frame,
            "UDID"
        )
        .unwrap(),
        strings(&[
            "touch", "-x", "40.0", "-y", "163.5", "--down", "--up", "--delay", "1.0", "--udid",
            "UDID"
        ])
    );
    assert_eq!(
        axe_arguments(
            "drag",
            &json!({"x": 1, "y": 105.5, "x2": 3, "y2": 107.5, "duration": 0.5}),
            frame,
            "UDID"
        )
        .unwrap(),
        strings(&[
            "drag",
            "--start-x",
            "1.0",
            "--start-y",
            "105.5",
            "--end-x",
            "3.0",
            "--end-y",
            "107.5",
            "--duration",
            "0.5",
            "--udid",
            "UDID"
        ])
    );
    assert_eq!(
        axe_arguments("tap", &json!({"x": 1}), frame, "UDID").unwrap_err(),
        "needs a numeric \"y\""
    );
}

#[test]
fn adb_arguments_scale_screen_dp_into_device_pixels() {
    // Android touches are device pixels: dp times the display density.
    let frame = Frame {
        scale: 2.5,
        width: 288.0,
        height: 640.0,
    };
    assert_eq!(
        adb_arguments("tap", &json!({"x": 40, "y": 144}), frame).unwrap(),
        strings(&["shell", "input", "tap", "100", "360"])
    );
    // A long press is a zero-length swipe, which is how Android spells one.
    assert_eq!(
        adb_arguments("tap", &json!({"x": 40, "y": 144, "hold": 1}), frame).unwrap(),
        strings(&["shell", "input", "swipe", "100", "360", "100", "360", "1000"])
    );
    assert_eq!(
        adb_arguments("drag", &json!({"x": 0, "y": 84, "x2": 4, "y2": 92}), frame).unwrap(),
        strings(&["shell", "input", "swipe", "0", "210", "10", "230", "300"])
    );
    assert_eq!(
        adb_arguments("drag", &json!({"x": 1}), frame).unwrap_err(),
        "needs a numeric \"y\""
    );
}

/// Keys go to whatever has focus, through the same tools a tap does: `axe type`/`axe key`,
/// and `input text`/`input keyevent` in the device's shell.
#[test]
fn type_and_press_become_real_key_presses() {
    let frame = Frame {
        scale: 2.0,
        width: 300.0,
        height: 600.0,
    };
    assert_eq!(
        axe_arguments("type", &json!({"text": "-it's"}), frame, "U").unwrap(),
        strings(&["type", "--udid", "U", "--", "-it's"])
    );
    assert_eq!(
        axe_arguments("press", &json!({"key": "Enter"}), frame, "U").unwrap(),
        strings(&["key", "40", "--udid", "U"])
    );
    assert_eq!(
        adb_arguments("type", &json!({"text": "it's a b"}), frame).unwrap(),
        strings(&["shell", "input", "text", r"'it'\''s%sa%sb'"])
    );
    assert_eq!(
        adb_arguments("press", &json!({"key": "Back"}), frame).unwrap(),
        strings(&["shell", "input", "keyevent", "4"])
    );
    // A count is one command: a run of Backspaces is one action.
    assert_eq!(
        axe_arguments(
            "press",
            &json!({"key": "Backspace", "count": 3}),
            frame,
            "U"
        )
        .unwrap(),
        strings(&["key-sequence", "--keycodes", "42,42,42", "--udid", "U"])
    );
    assert_eq!(
        adb_arguments("press", &json!({"key": "Backspace", "count": 3}), frame).unwrap(),
        strings(&["shell", "input", "keyevent", "67", "67", "67"])
    );
    assert!(
        adb_arguments("press", &json!({"key": "Enter", "count": 0}), frame)
            .unwrap_err()
            .contains("whole number from 1")
    );
    // iOS has no system Back: the refusal names the app's own.
    assert!(axe_arguments("press", &json!({"key": "Back"}), frame, "U")
        .unwrap_err()
        .contains("do GoBack"));
    // A key `press` lacks names the calls that send it.
    let unknown = adb_arguments("press", &json!({"key": "F1"}), frame).unwrap_err();
    assert!(unknown.contains("press knows Enter, Backspace"));
    assert!(unknown.ends_with(r#"In the editor: do Press '{"key":"F1"}'"#));
    assert!(adb_arguments("press", &json!({"key": "a"}), frame)
        .unwrap_err()
        .contains(r#"A character is typed: type '{"text":"a"}'."#));
    // Only what a US keyboard types, with the editor's typing for the rest; a line break
    // is the Enter key.
    let accented = adb_arguments("type", &json!({"text": "caf\u{e9}"}), frame).unwrap_err();
    assert!(accented.contains("US-keyboard characters, not '\u{e9}'"));
    assert!(accented.contains("In the editor: do Type '{\"text\":\"caf\u{e9}\"}'"));
    // Paced, a `type` is one key press a character, `delay` ms apart.
    let paced: Vec<Vec<String>> = screen::one_key_each(&json!({"text": "a b", "delay": 150}))
        .iter()
        .map(|one| adb_arguments("type", one, frame).unwrap())
        .collect();
    assert_eq!(
        paced,
        [
            strings(&["shell", "input", "text", "'a'"]),
            strings(&["shell", "input", "text", "'%s'"]),
            strings(&["shell", "input", "text", "'b'"]),
        ]
    );
    assert_eq!(key_delay(&json!({"text": "a"})), Ok(None));
    assert_eq!(
        key_delay(&json!({"delay": 150})),
        Ok(Some(Duration::from_millis(150)))
    );
    for delay in [json!(0), json!(1001), json!(1.5), json!("150")] {
        assert!(key_delay(&json!({ "delay": delay }))
            .unwrap_err()
            .contains("from 1 to 1000"));
    }
    let lines = adb_arguments("type", &json!({"text": "two\nlines"}), frame).unwrap_err();
    assert!(lines.contains(r#"press '{"key":"Enter"}' between the lines"#));
    assert!(lines.ends_with(r#"do Type '{"text":"two\nlines"}'"#));
}

/// Android's `input text` types `%s` as a space, and has no way to type it as written.
#[test]
fn android_refuses_text_its_input_tool_would_change() {
    let frame = Frame {
        scale: 2.0,
        width: 300.0,
        height: 600.0,
    };
    let error = adb_arguments("type", &json!({"text": "50%sale"}), frame).unwrap_err();
    assert!(error.contains("%s") && error.contains("do Type"), "{error}");
    assert_eq!(
        adb_arguments("type", &json!({"text": "50% off"}), frame).unwrap(),
        strings(&["shell", "input", "text", "'50%%soff'"])
    );
}

/// Desktop types its keys at once, so a `delay` it cannot honour is refused, not dropped.
#[test]
fn desktop_refuses_a_typing_pace() {
    assert!(desktop_keys("type", &json!({"text": "a", "delay": 100}))
        .unwrap_err()
        .contains("delay"));
}
