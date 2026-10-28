//! One call to the app, whichever the target: retried while the app says it is not ready yet
//! (503), and an async verb's 202 polled until its record settles.

use super::*;

const NOT_READY_RETRY_WINDOW: Duration = Duration::from_secs(5);

/// How long `do` waits for an async verb's record to settle before handing back `pending`.
const PENDING_CEILING: Duration = Duration::from_secs(5);

/// How often `do` re-reads a pending record: a note switch settles in tens of milliseconds and
/// each read costs a few, so a slower poll only adds latency to every switch.
const PENDING_POLL: Duration = Duration::from_millis(20);

/// A 202 receipt names an action still running in the page (an async verb: a
/// vault write, a sync). Poll its record until it settles, then answer with the
/// verb's own status and result plus the diff; past the ceiling, hand back the
/// pending record so the agent can `diff {"action"}` later — a verb awaiting a
/// dialog stays pending until the dialog's verb runs.
pub(crate) fn await_pending(target: &Target, accepted: Reply) -> Result<Reply, String> {
    let Some(action) = accepted.body["action"].as_u64() else {
        return Ok(accepted);
    };
    let started = Instant::now();
    loop {
        let record = call(target, "diff", &json!({ "action": action }))?;
        if record.status != 200 {
            return Ok(record);
        }
        if record.body["pending"] != json!(true) {
            let status = record.body["status"].as_u64().unwrap_or(200) as u16;
            let mut body = record.body["result"].clone();
            if let Some(receipt) = body.as_object_mut() {
                receipt.insert("action".into(), json!(action));
                if !record.body["diff"].is_null() {
                    receipt.insert("diff".into(), record.body["diff"].clone());
                }
                receipt.insert("events".into(), json!(event_count(&record.body)));
            }
            return Ok(Reply { status, body });
        }
        if started.elapsed() >= PENDING_CEILING {
            return Ok(Reply {
                status: 202,
                body: record.body,
            });
        }
        std::thread::sleep(PENDING_POLL);
    }
}

pub(crate) fn event_count(record: &Value) -> u64 {
    // The listener's own numbers: a malformed record counts nothing rather than panicking.
    record["events"][1]
        .as_u64()
        .unwrap_or(0)
        .saturating_sub(record["events"][0].as_u64().unwrap_or(0))
}

pub(crate) fn call_once(target: &Target, command: &str, args: &Value) -> Result<Reply, String> {
    let mut reply = match target {
        Target::Desktop(port) => desktop_call(*port, command, args),
        Target::Native(platform, port, device) => {
            native_call(*platform, *port, device, command, args)
        }
    }?;
    if command == "actions" {
        answer_through_dialog(&mut reply.body);
    }
    Ok(reply)
}

pub(crate) fn call(target: &Target, command: &str, args: &Value) -> Result<Reply, String> {
    // 503 is the app saying "not yet" (store scanning, editor bridge loading);
    // waiting on that condition is the harness's job, not the agent's.
    let deadline = Instant::now() + NOT_READY_RETRY_WINDOW;
    loop {
        let reply = call_once(target, command, args)?;
        if reply.status != 503 {
            return Ok(reply);
        }
        if Instant::now() > deadline {
            return match target {
                Target::Native(platform, _, device) if no_inspector(&reply.body) => {
                    Err(no_inspector_error(*platform, device))
                }
                _ => Ok(reply),
            };
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The phone listeners' "the editor page has no `window.__futoPuppet`" refusal.
fn no_inspector(body: &Value) -> bool {
    body["error"]
        .as_str()
        .is_some_and(|error| error.contains("no puppet inspector"))
}

/// A page still without its inspector after the whole retry window is not loading: its
/// editor.html was built without the inspector.
fn no_inspector_error(platform: NativePlatform, device: &str) -> String {
    let reinstall = platform.launch_command(device);
    format!(
        "the editor page has no puppet inspector ({}s after asking), so nothing in the editor \
         can be read or driven. The debug app was built from an editor.html staged without \
         VITE_INCLUDE_TEST_HOOKS=true: by a release script, `just test-android-perf`, or `vite \
         build --config vite.editor.config.ts` run by hand.\nFix: {reinstall}   (reinstalls \
         the debug app with the inspector in its editor bundle)",
        NOT_READY_RETRY_WINDOW.as_secs()
    )
}
