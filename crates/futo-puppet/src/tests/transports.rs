use super::*;

#[test]
fn forward_script_quotes_command_and_args_as_js_literals() {
    assert_eq!(
        forward_script("do", &json!({"verb":"Select","args":{"expect":"a\"b"}})),
        r#"window.__futoPuppet ? await window.__futoPuppet.run("do", "{\"args\":{\"expect\":\"a\\\"b\"},\"verb\":\"Select\"}") : null"#
    );
}

#[test]
fn forwarded_replies_split_into_status_and_body() {
    let reply = parse_forwarded(&json!(
        r#"{"status":409,"body":{"ok":false,"error":"moved"}}"#
    ))
    .unwrap();
    assert_eq!(
        (reply.status, reply.body["error"].as_str()),
        (409, Some("moved"))
    );
    assert_eq!(parse_forwarded(&Value::Null).unwrap().status, 503);
    assert!(parse_forwarded(&json!(7)).is_err());
}

#[test]
fn http_responses_parse_status_and_json_body() {
    let reply =
        parse_http_response(b"HTTP/1.1 409 Conflict\r\nContent-Length: 11\r\n\r\n{\"ok\":false}")
            .unwrap();
    assert_eq!((reply.status, reply.body), (409, json!({"ok": false})));
    assert!(parse_http_response(b"garbage").is_err());
}

/// The serial and device end a host port is forwarded to, from `adb forward --list`.
#[test]
fn a_forward_names_the_device_it_reaches() {
    let forwards =
        "emulator-5604 tcp:9503 localabstract:futo-puppet\nemulator-5556 tcp:9520 tcp:9430\n";
    assert_eq!(
        forward_of(forwards, 9503),
        Some(("emulator-5604", "localabstract:futo-puppet"))
    );
    assert_eq!(
        forward_of(forwards, 9520),
        Some(("emulator-5556", "tcp:9430"))
    );
    assert_eq!(forward_of(forwards, 950), None);
    assert_eq!(forward_of("", 9503), None);
}

/// An app that does not answer ends the command at once, not after a timeout per read.
#[test]
fn a_silent_app_fails_the_reads_around_a_verb_instead_of_emptying_them() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    let target = Target::Desktop(port);
    assert!(app::read(&target).is_err());
    assert!(menu(&target).is_err());
}
