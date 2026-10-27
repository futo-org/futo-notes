//! The phones' transport: loopback HTTP to the debug listener (`PuppetServer.swift` on iOS,
//! `PuppetServer.kt` on Android, reached through `adb forward`), and its `/tree`.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

/// Whether this process has held the iOS app on its port to this worktree's simulator yet.
static IOS_APP_IS_OURS: AtomicBool = AtomicBool::new(false);

/// Loopback HTTP to a native shell's listener. On iOS the process's first request asks the app
/// which simulator it runs on, and refuses one that is not `device`: two worktrees in one slot
/// share the port, the second app cannot bind it, and the first answers for both. At the first
/// request, not when the target resolves: `relaunch` reaches a device whose app is down.
fn http(
    platform: NativePlatform,
    port: u16,
    device: &str,
    method: &str,
    path: &str,
    body: &str,
) -> Result<Reply, String> {
    if platform == NativePlatform::Ios && !IOS_APP_IS_OURS.load(Ordering::Relaxed) {
        let tree = request(platform, port, device, "GET", "/tree", "")?;
        ios_app_runs_on(&tree.body, port, device)?;
        IOS_APP_IS_OURS.store(true, Ordering::Relaxed);
    }
    request(platform, port, device, method, path, body)
}

/// `just ios-native` run bare takes the first booted simulator, which can be another
/// worktree's claim.
fn ios_app_runs_on(tree: &Value, port: u16, device: &str) -> Result<(), String> {
    let udid = tree["udid"]
        .as_str()
        .ok_or("the app is not running in a simulator (no SIMULATOR_UDID)")?;
    if udid == device {
        return Ok(());
    }
    Err(format!(
        "the app answering on 127.0.0.1:{port} runs on simulator {udid}, not {device}, \
         this worktree's: launch it there with `{}`",
        NativePlatform::Ios.launch_command(device)
    ))
}

/// One request, `Connection: close`, so the body is everything after the headers.
fn request(
    platform: NativePlatform,
    port: u16,
    device: &str,
    method: &str,
    path: &str,
    body: &str,
) -> Result<Reply, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| {
            format!(
                "nothing is listening on 127.0.0.1:{port}; launch the debug app with `{}`",
                platform.launch_command(device)
            )
        })?;
    stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    // An empty reply is NOT a malformed one, and on Android it is the common
    // case: `adb forward` binds the host port whether or not anything is
    // listening inside the device, so the connect above always succeeds and the
    // "nothing is listening" message never fires. Saying "malformed HTTP
    // response" there blames the protocol for an app that is simply not up —
    // a pilot agent hit exactly this, believed the tool was broken, and never
    // reached for it again in the rest of its run.
    if raw.is_empty() {
        return Err(format!(
            "127.0.0.1:{port} accepted the connection but the app answered nothing. \
             The debug app is not running, or is a build without the listener \
             (release builds carry none). Launch it with `{}`.",
            platform.launch_command(device)
        ));
    }
    parse_http_response(&raw)
}

pub(crate) fn parse_http_response(raw: &[u8]) -> Result<Reply, String> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or("the listener replied without an HTTP header block")?;
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("malformed HTTP status line")?;
    let body = if body.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(body).map_err(|e| e.to_string())?
    };
    Ok(Reply { status, body })
}

pub(crate) fn native_call(
    platform: NativePlatform,
    port: u16,
    device: &str,
    command: &str,
    args: &Value,
) -> Result<Reply, String> {
    match command {
        "actions" => http(platform, port, device, "GET", "/actions", ""),
        "do" => {
            let verb = args["verb"].as_str().unwrap_or_default();
            http(
                platform,
                port,
                device,
                "POST",
                &format!("/do/{verb}"),
                &args["args"].to_string(),
            )
        }
        query => http(
            platform,
            port,
            device,
            "POST",
            &format!("/{query}"),
            &args.to_string(),
        ),
    }
}

/// The listener's `/tree`: the screen, what is on it, and the editor web view's box in device
/// units when the editor is on screen (`webview`, else null), which is where the page's CSS
/// pixels sit (screen.rs).
pub(crate) fn phone_tree(
    platform: NativePlatform,
    port: u16,
    device: &str,
) -> Result<Value, String> {
    let reply = http(platform, port, device, "GET", "/tree", "")?;
    if reply.status != 200 {
        return Err(format!("tree: {}", compact(&reply.body)));
    }
    Ok(reply.body)
}

#[cfg(test)]
mod transport_tests {
    use super::{http, native_call, NativePlatform};
    use serde_json::json;
    use std::io::Read;
    use std::net::TcpListener;

    /// `adb forward` binds the host port whether or not the app inside the
    /// device is listening, so a connect always succeeds and an empty reply
    /// comes back. That must read as "the app is not running", not as a
    /// protocol complaint — a pilot agent read the old wording as a broken
    /// tool and never tried the CLI again.
    #[test]
    fn an_accepted_connection_that_answers_nothing_names_the_launch_command() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut scratch = [0u8; 1024];
                let _ = stream.read(&mut scratch);
                // Drop without writing: exactly what a dangling forward does.
            }
        });

        let error = match http(
            NativePlatform::Android,
            port,
            "emulator-5554",
            "GET",
            "/actions",
            "",
        ) {
            Err(error) => error,
            Ok(_) => panic!("an empty reply must be an error"),
        };
        assert!(error.contains("answered nothing"), "{error}");
        // Run bare, the recipe installs on the only device attached, which may not be the claim.
        assert!(
            error.contains("ANDROID_SERIAL=emulator-5554 just android-native"),
            "{error}"
        );
        assert!(!error.contains("malformed"), "{error}");
    }

    /// An iOS app this worktree launched onto another worktree's simulator (`just ios-native`
    /// run bare takes the first booted one), or another worktree's app on this slot's port, is
    /// refused before any call reaches it, not only the screen reads.
    #[test]
    fn an_ios_app_on_another_simulator_is_refused_before_any_call_reaches_it() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let asked = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut scratch = [0u8; 1024];
            let read = stream.read(&mut scratch).unwrap_or(0);
            let body = r#"{"nodes":[],"udid":"THEIRS"}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = std::io::Write::write_all(&mut stream, reply.as_bytes());
            String::from_utf8_lossy(&scratch[..read]).to_string()
        });

        let error = match native_call(NativePlatform::Ios, port, "MINE", "state", &json!({})) {
            Err(error) => error,
            Ok(_) => panic!("another simulator's app must be refused"),
        };
        assert!(error.contains("THEIRS"), "{error}");
        assert!(error.contains("SIM=MINE just ios-native"), "{error}");
        let request = asked.join().expect("the listener thread");
        assert!(request.starts_with("GET /tree "), "{request}");
    }
}
