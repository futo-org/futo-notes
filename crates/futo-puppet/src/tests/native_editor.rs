use super::*;

/// A phone listener with a native editor and no WebView. Queries still travel
/// through the real CLI transport and screen-reading path.
fn phone_editor(surface: &'static str, webview: bool) -> Target {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = [0; 4096];
            let count = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            let route = request.split_whitespace().nth(1).unwrap_or("");
            let (status, body) = match route {
                "/state" => (
                    200,
                    json!({
                        "screen": "editor:note", "sheet": null,
                        "editor": {"surface": surface, "ready": true}
                    }),
                ),
                "/tree" => (
                    200,
                    json!({
                        "screen": {"w": 402, "h": 874}, "scale": 1,
                        "webview": if webview { json!({"x": 0, "y": 100, "w": 402, "h": 500}) } else { Value::Null },
                        "nodes": [{"id": "text-first-editor", "role": "field", "text": "words",
                            "x": 0, "y": 154, "w": 402, "h": 500, "section": "editor",
                            "actions": ["tap"], "flags": ["focused"]}]
                    }),
                ),
                "/trace" if request.contains("begin") => {
                    (200, json!({"eventCursor": 0, "before": 1}))
                }
                "/trace" => (
                    200,
                    json!({"kind": "gesture", "before": 1, "after": 2,
                    "events": [0, 0], "diff": {"doc": {"line": 1, "removed": "a", "inserted": "ab"}}}),
                ),
                "/events" => (200, json!({"last": 0, "events": []})),
                "/elements" => (200, json!({"elements": [], "scroll": []})),
                "/doc" => (
                    200,
                    json!({"docVersion": 9, "lines": [
                        {"line": 1, "at": 0, "end": 5, "kind": "paragraph", "text": "words"}
                    ]}),
                ),
                "/show" if request.contains("offscreen") => {
                    (409, json!({"ok": false, "error": "ScrollToLine"}))
                }
                "/show" => (
                    200,
                    json!({"line": 1, "rect": {"x": 20, "y": 180, "w": 80, "h": 24}}),
                ),
                "/at" => (200, json!({"point": {"x": 25, "y": 190}, "position": 2})),
                _ => (404, json!({"error": "unexpected route"})),
            };
            let body = body.to_string();
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    Target::Native(NativePlatform::Android, port, "test-phone".into())
}

#[test]
fn native_editor_document_reads_do_not_require_a_webview() {
    let reply = query(&phone_editor("native", false), "doc", &json!({})).unwrap();
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["lines"][0]["text"], "words");
}

#[test]
fn native_editor_geometry_is_already_in_screen_points_and_refusals_survive() {
    let target = phone_editor("native", false);
    let shown = query(&target, "show", &json!({"text": "words"})).unwrap();
    assert_eq!(shown.status, 200, "{}", shown.body);
    assert_eq!(shown.body["rect"]["y"], 180);
    let at = query(&target, "at", &json!({"x": 25, "y": 190})).unwrap();
    assert_eq!(at.status, 200, "{}", at.body);
    assert_eq!(at.body["point"], json!({"x": 25, "y": 190}));
    let refused = query(&target, "show", &json!({"text": "offscreen"})).unwrap();
    assert_eq!(refused.status, 409);
    assert_eq!(refused.body["error"], "ScrollToLine");
}

#[test]
fn native_editor_text_aims_at_its_line_not_the_whole_body_field() {
    let target = phone_editor("native", false);
    let before = screen::view(&target).unwrap();
    let mut tap = json!({"text": "words"});
    assert!(screen::aim(&target, &before, "tap", &mut tap)
        .unwrap()
        .is_none());
    assert_eq!(tap, json!({"x": 60.0, "y": 192.0}));
}

#[test]
fn native_document_or_selection_changes_are_real_changes_without_dom_events() {
    assert!(app::editor_changed(&json!({"events": [0, 0], "diff": {
        "doc": {"line": 1, "removed": "a", "inserted": "ab"}
    }})));
    assert!(app::editor_changed(&json!({"events": [0, 0], "diff": {
        "selection": [{"from": 1, "to": 1}, {"from": 2, "to": 2}]
    }})));
    assert!(!app::editor_changed(&json!({"events": [0, 0], "diff": {}})));
}

#[test]
fn untagged_phone_editors_keep_the_existing_webview_requirement_and_offset() {
    let native_screen = phone_editor("", false);
    assert_eq!(
        query(&native_screen, "doc", &json!({})).unwrap().status,
        409
    );
    let webview = phone_editor("", true);
    let shown = query(&webview, "show", &json!({"text": "words"})).unwrap();
    assert_eq!(shown.status, 200);
    assert_eq!(shown.body["rect"]["y"], 280);
    let explicit_native = phone_editor("native", true);
    let shown = query(&explicit_native, "show", &json!({"text": "words"})).unwrap();
    assert_eq!(
        shown.body["rect"]["y"], 180,
        "a hidden stale WebView is not the native editor"
    );
}

#[test]
fn native_trace_preserves_document_receipts_without_claiming_dom_events() {
    let target = phone_editor("native", false);
    let mut delivered = false;
    let receipt = traced(&target, || {
        delivered = true;
        Ok(())
    })
    .unwrap();
    assert!(delivered);
    assert_eq!(receipt.status, 200);
    assert_eq!(event_count(&receipt.body), 0);
    assert_eq!(receipt.body["diff"]["doc"]["inserted"], "ab");
    assert!(app::editor_changed(&receipt.body));
}

#[test]
fn native_gesture_receipts_name_the_observed_screen_after_input() {
    let target = phone_editor("native", false);
    let before = screen::view(&target).unwrap();
    let mut after = before.clone();
    for destination in ["editor:note", "list"] {
        after.screen = destination.into();
        for name in ["tap", "type", "press"] {
            let mut receipt = traced(&target, || Ok(())).unwrap();
            screen::merge_change(&mut receipt.body, &before, &after);
            let rendered = render_gesture(name, &receipt);
            assert!(
                rendered.starts_with(&format!("OK {name} · screen {destination}\n")),
                "{rendered}"
            );
            assert_eq!(receipt.body["diff"]["doc"]["inserted"], "ab");
        }
    }
}
