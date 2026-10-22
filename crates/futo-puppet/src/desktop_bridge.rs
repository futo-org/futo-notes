//! The desktop's transport: the mcp-bridge WebSocket a debug build exposes, which evaluates the
//! in-page call (`window.__futoPuppet`) and answers with the inspector's reply.

use super::*;

/// The in-page call the desktop evaluates. Awaited: `search` answers with a promise, and
/// awaiting any other command's plain string is a no-op.
pub(crate) fn forward_script(command: &str, args: &Value) -> String {
    format!(
        "window.__futoPuppet ? await window.__futoPuppet.run({}, {}) : null",
        Value::String(command.into()),
        Value::String(args.to_string())
    )
}

pub(crate) fn desktop_call(port: u16, command: &str, args: &Value) -> Result<Reply, String> {
    parse_forwarded(&bridge_execute_js(port, &forward_script(command, args))?)
}

/// How long the desktop app may take to answer one bridge call. The bridge itself
/// gives up on a script after 5 s (`tauri-plugin-mcp-bridge`'s execute_js timeout)
/// and says so, and every CLI call is one short script — an async verb answers
/// 202 at once and is polled — so only a hung or starved app gets this far.
pub(crate) const BRIDGE_REPLY_TIMEOUT: Duration = Duration::from_secs(10);

/// mcp-bridge WebSocket: `{id, command:"execute_js", args:{script}}` → `{id, success, data|error}`.
pub(crate) fn bridge_execute_js(port: u16, script: &str) -> Result<Value, String> {
    bridge_command(
        port,
        "execute_js",
        json!({ "script": script }),
        BRIDGE_REPLY_TIMEOUT,
    )
}

/// One mcp-bridge command — `execute_js`, `capture_native_screenshot` — and its `data`.
pub(crate) fn bridge_command(
    port: u16,
    command: &str,
    args: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let unreachable = |e: &dyn std::fmt::Display| {
        format!("could not reach the desktop debug bridge on port {port}: {e}")
    };
    let silent = || {
        format!(
            "the desktop app on port {port} accepted the connection but did not answer within {}s: \
             it is hung or starved. Bring its window forward, or restart it with `just tauri-dev`.",
            timeout.as_secs_f64()
        )
    };
    let stream = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), timeout)
        .map_err(|e| unreachable(&e))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();
    let is_timeout = |e: &std::io::Error| {
        matches!(
            e.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        )
    };
    let (mut socket, _) =
        tungstenite::client(format!("ws://127.0.0.1:{port}"), stream).map_err(|e| match e {
            tungstenite::HandshakeError::Interrupted(_) => silent(),
            tungstenite::HandshakeError::Failure(tungstenite::Error::Io(io)) if is_timeout(&io) => {
                silent()
            }
            tungstenite::HandshakeError::Failure(e) => unreachable(&e),
        })?;
    let request = json!({ "id": "futo-puppet", "command": command, "args": args });
    let read_error = |e: tungstenite::Error| match e {
        tungstenite::Error::Io(io) if is_timeout(&io) => silent(),
        e => e.to_string(),
    };
    socket
        .send(tungstenite::Message::Text(request.to_string().into()))
        .map_err(read_error)?;
    let response = loop {
        let message = socket.read().map_err(read_error)?;
        if let tungstenite::Message::Text(text) = message {
            let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if value["id"] == "futo-puppet" {
                break value;
            }
        }
    };
    socket.close(None).ok();
    if response["success"] != true {
        return Err(format!(
            "{command} failed: {}",
            response["error"].as_str().unwrap_or("unknown error")
        ));
    }
    Ok(response["data"].clone())
}

pub(crate) fn parse_forwarded(data: &Value) -> Result<Reply, String> {
    match data {
        Value::Null => Ok(Reply::refusal(
            503,
            "the page has no puppet inspector; is this a dev or VITE_INCLUDE_TEST_HOOKS=true build?",
        )),
        Value::String(text) => {
            let value: Value = serde_json::from_str(text)
                .map_err(|e| format!("inspector returned non-JSON: {e}"))?;
            let status = value["status"]
                .as_u64()
                .ok_or("inspector reply has no status")? as u16;
            Ok(Reply {
                status,
                body: value["body"].clone(),
            })
        }
        other => Err(format!("unexpected execute_js data: {other}")),
    }
}

#[cfg(test)]
mod bridge_timeout_tests {
    use super::bridge_command;
    use serde_json::json;
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    fn assert_names_a_silent_app(error: String, started: Instant) {
        assert!(error.contains("did not answer within"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "gave up late: {:?}",
            started.elapsed()
        );
    }

    /// A starved app still has its socket in the kernel's backlog, so the
    /// connect succeeds and, without a timeout, the handshake read waits forever.
    #[test]
    fn an_app_that_accepts_but_never_upgrades_is_an_error_not_a_hang() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let started = Instant::now();
        let error = bridge_command(
            port,
            "execute_js",
            json!({ "script": "1" }),
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert_names_a_silent_app(error, started);
        drop(listener);
    }

    #[test]
    fn an_app_that_upgrades_but_never_replies_is_an_error_not_a_hang() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut socket = tungstenite::accept(stream).expect("upgrade");
            let _ = socket.read(); // the request, never answered
            std::thread::sleep(Duration::from_secs(1));
        });
        let started = Instant::now();
        let error = bridge_command(
            port,
            "execute_js",
            json!({ "script": "1" }),
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert_names_a_silent_app(error, started);
        server.join().ok();
    }
}
