use super::*;

/// A click is a mouse and a tap is a finger; the CLI never translates one
/// into the other, it says which one this target has.
#[test]
fn the_wrong_input_model_for_the_target_is_refused_by_name() {
    let desktop = Target::Desktop(1);
    let phone = Target::Native(NativePlatform::Ios, 1, String::new());
    assert!(wrong_input_model(&desktop, "tap")
        .unwrap()
        .contains("use `click`"));
    assert!(wrong_input_model(&phone, "click")
        .unwrap()
        .contains("use `tap`"));
    assert!(wrong_input_model(&phone, "scroll")
        .unwrap()
        .contains("use `drag`"));
    // Desktop has a keyboard: its keys are real key presses (puppet_keys.rs).
    assert!(wrong_input_model(&desktop, "type").is_none());
    assert_eq!(
        desktop_keys("press", &json!({"key": "Mod-b", "count": 2})).unwrap(),
        json!({"kind": "press", "key": "Mod-b", "count": 2})
    );
    assert_eq!(
        desktop_input_script("puppet_key", &json!({"kind": "type", "text": "a"})),
        r#"await window.__TAURI__.core.invoke("puppet_key", {"keys":{"kind":"type","text":"a"}})"#
    );
    for (target, name) in [
        (&desktop, "click"),
        (&desktop, "drag"),
        (&desktop, "scroll"),
        (&phone, "tap"),
        (&phone, "drag"),
    ] {
        assert!(
            wrong_input_model(target, name).is_none(),
            "{name} belongs on this target"
        );
    }
}

#[test]
fn a_desktop_pointer_carries_the_gesture_as_kind_and_checks_the_coordinates_first() {
    assert_eq!(
        desktop_pointer("click", &json!({"x": 10, "y": 20, "count": 2})).unwrap(),
        json!({"kind": "click", "x": 10, "y": 20, "count": 2})
    );
    assert!(desktop_pointer("drag", &json!({"x": 1, "y": 2}))
        .unwrap_err()
        .contains("x2"));
    assert_eq!(
        desktop_pointer("scroll", &json!({"x": 1, "y": 2, "dy": 300})).unwrap(),
        json!({"kind": "scroll", "x": 1, "y": 2, "dy": 300})
    );
    assert!(desktop_pointer("scroll", &json!({"x": 1, "y": 2}))
        .unwrap_err()
        .contains("dy"));
    assert!(desktop_pointer("click", &json!({"y": 2}))
        .unwrap_err()
        .contains("\"x\""));
    assert_eq!(
        desktop_input_script("puppet_pointer", &json!({"kind": "click", "x": 1, "y": 2})),
        r#"await window.__TAURI__.core.invoke("puppet_pointer", {"pointer":{"kind":"click","x":1,"y":2}})"#
    );
}

#[test]
fn a_ref_aims_at_the_element_centre_and_a_flat_rect_at_nothing() {
    assert_eq!(
        centre_of(&json!({"x": 8, "y": 348, "w": 263, "h": 48})),
        Some((140.0, 372.0))
    );
    assert_eq!(centre_of(&json!({"x": 0, "y": 0, "w": 0, "h": 0})), None);
    assert_eq!(centre_of(&json!({"x": 1})), None);
}

/// A fake mcp-bridge that answers each `execute_js` by `answer` and records its scripts.
pub(super) fn fake_bridge(
    answer: fn(&str) -> Value,
) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let scripts = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = scripts.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let Ok(mut socket) = tungstenite::accept(stream) else {
                continue;
            };
            let Ok(tungstenite::Message::Text(text)) = socket.read() else {
                continue;
            };
            let request: Value = serde_json::from_str(&text).unwrap_or_default();
            let script = request["args"]["script"].as_str().unwrap_or("").to_string();
            let reply = answer(&script);
            seen.lock().unwrap().push(script);
            let _ = socket.send(tungstenite::Message::Text(reply.to_string().into()));
        }
    });
    (port, scripts)
}

/// A gesture whose settle read fails still closes the page's trace: an open one cancels every
/// drag in the app until the next gesture.
#[test]
fn a_failed_settle_read_still_ends_the_trace() {
    let (port, scripts) = fake_bridge(|script| {
        let page = |body: Value| {
            json!({"id": "futo-puppet", "success": true,
                   "data": json!({"status": 200, "body": body}).to_string()})
        };
        if script.contains("\"events\"") {
            json!({"id": "futo-puppet", "success": false, "error": "the page navigated"})
        } else if script.contains("begin") {
            page(json!({"eventCursor": 3}))
        } else {
            page(json!({"ok": true}))
        }
    });
    let Err(error) = traced(&Target::Desktop(port), || Ok(())) else {
        panic!("a failed settle read fails the gesture");
    };
    assert!(error.contains("the page navigated"), "{error}");
    let scripts = scripts.lock().unwrap();
    assert!(scripts.last().unwrap().contains("end"), "{scripts:?}");
}

/// An Android screen showing `rows`, with the editor's web view at `webview` when it is up.
fn phone_view(rows: Vec<Value>, webview: Option<crate::native::Rect>) -> screen::View {
    screen::View {
        screen: "list".into(),
        size: crate::native::Rect {
            x: 0.0,
            y: 0.0,
            w: 402.0,
            h: 874.0,
        },
        scale: 1.0,
        platform: NativePlatform::Android,
        rows,
        scroll: vec![],
        webview,
        moving: false,
        ready: false,
    }
}

/// On a phone's native screen there is no page to ask where text shows: the native row that
/// shows it is the aim, a tap landing where its row takes one.
#[test]
fn text_on_a_native_phone_screen_aims_at_the_row_that_shows_it() {
    let before = phone_view(
        vec![
            json!({"ref": "n4", "role": "button", "text": "Sort by Name", "section": "menu",
                          "rect": {"x": 20, "y": 300, "w": 200, "h": 48}}),
        ],
        None,
    );
    let target = Target::Native(NativePlatform::Android, 1, "emulator-5554".into());
    let mut tap = json!({"text": "Name"});
    assert!(screen::aim(&target, &before, "tap", &mut tap)
        .unwrap()
        .is_none());
    assert_eq!(tap, json!({"x": 120.0, "y": 324.0}));
    let mut drag = json!({"text": "Name"});
    assert!(screen::aim(&target, &before, "drag", &mut drag)
        .unwrap()
        .is_none());
    assert_eq!(
        drag,
        json!({"x": 21.0, "y": 324.0, "x2": 219.0, "y2": 324.0})
    );
    let missing = screen::aim(&target, &before, "tap", &mut json!({"text": "Date"}))
        .unwrap()
        .expect("text no row shows is refused");
    assert_eq!(missing.status, 404);
}

/// Text two places on a phone's screen show is refused with both, as the page refuses two
/// occurrences: two native rows, or a native row and the editor's words. Text one place shows
/// is aimed there.
#[test]
fn text_two_places_on_a_phone_screen_show_is_refused_with_both() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = [0u8; 4096];
            let read = std::io::Read::read(&mut stream, &mut request).unwrap_or(0);
            let (status, body) = if String::from_utf8_lossy(&request[..read]).contains("Groceries")
            {
                (
                    200,
                    json!({"line": 1, "rect": {"x": 10, "y": 20, "w": 80, "h": 20}}),
                )
            } else {
                (409, json!({"ok": false, "error": "not in the note"}))
            };
            let body = body.to_string();
            let reply = format!(
                "HTTP/1.1 {status} X\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = std::io::Write::write_all(&mut stream, reply.as_bytes());
        }
    });
    let target = Target::Native(NativePlatform::Android, port, "emulator-5554".into());
    let row = |reference: &str, text: &str| {
        json!({"ref": reference, "role": "button", "text": text, "section": "top bar",
               "rect": {"x": 0, "y": 40, "w": 200, "h": 48}})
    };
    let refused = |before: &screen::View, text: &str| {
        let reply = screen::aim(&target, before, "tap", &mut json!({ "text": text }))
            .unwrap()
            .expect("two places are refused");
        assert_eq!(reply.status, 409);
        reply.body["error"].as_str().unwrap().to_string()
    };

    let list = phone_view(vec![row("n1", "milk"), row("n2", "milk shake")], None);
    let error = refused(&list, "milk");
    assert!(error.contains("n1 \"milk\", n2 \"milk shake\""), "{error}");
    assert!(error.contains("`ref`"), "{error}");

    let webview = Some(crate::native::Rect {
        x: 0.0,
        y: 100.0,
        w: 402.0,
        h: 700.0,
    });
    let editor = phone_view(vec![row("n3", "Groceries"), row("n5", "Find")], webview);
    let error = refused(&editor, "Groceries");
    assert!(
        error.contains("n3 \"Groceries\", the editor's line 1"),
        "{error}"
    );
    let mut tap = json!({"text": "Find"});
    assert!(screen::aim(&target, &editor, "tap", &mut tap)
        .unwrap()
        .is_none());
    assert_eq!(tap, json!({"x": 100.0, "y": 64.0}));
}
