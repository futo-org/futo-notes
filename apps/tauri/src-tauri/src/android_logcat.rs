//! Android-only: on startup, scan the system logcat for evidence of a
//! native crash in the previous session (FATAL EXCEPTION, SIGSEGV,
//! chromium renderer death, libc tombstone, Rust panic from JNI). If we
//! find any, package the relevant lines as a `CrashReport`-shaped JSON
//! in `.crashlogs/` so the existing JS reporter ships them to the
//! crashlog server on the next flush cycle.
//!
//! Why this exists: a real force-quit (segfault / OOM kill / abort)
//! never reaches `window.onerror` and never panics Rust — it kills the
//! process between calls. The JS-side reporter is therefore blind to
//! every native-cause crash. Reading logcat after the fact is the
//! cheapest way to recover diagnostic context.
//!
//! Android filters logcat output by UID, so we only see lines that the
//! OS tagged with our app's pid. AndroidRuntime FATAL exceptions,
//! libc tombstones, and chromium renderer logs about *our* process all
//! qualify; we do NOT need the privileged `READ_LOGS` permission.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

const LOGCAT_LINE_LIMIT: usize = 2000;
const REPORTED_HASH_FILE: &str = "last-native-report.hash";
const MAX_REPORT_LINES: usize = 200;
/// Truncate any single logcat line longer than this. Crashpad minidump
/// payloads are filtered out by tag, but this is a defensive cap so any
/// other unexpectedly long line can't bloat the report.
const MAX_LINE_LEN: usize = 500;
/// Hard ceiling on the joined `stack` field. Zulip rejects messages past
/// ~10k chars; staying well under leaves room for the rest of the JSON.
const MAX_STACK_BYTES: usize = 8000;

/// Substrings that flag a logcat line as crash-related. Kept narrow so
/// we don't blow up the report with unrelated chatter.
///
/// **Primary** signals indicate an actual crash — a fatal POSIX signal,
/// a Java FATAL EXCEPTION, a Rust panic, or a tombstone. We require at
/// least one of these to be present before writing a crash report.
///
/// **Secondary** signals are useful as context but also fire on clean
/// force-quits (the system kills the chromium renderer subprocess
/// before the main app, so we see "Renderer process gone" / "WebView
/// crashed" / "Lost connection to chromium" in logcat even when nothing
/// actually crashed). On their own they don't justify a crash report;
/// with a primary signal they get included as supporting context.
const PRIMARY_CRASH_SIGNALS: &[&str] = &[
    "FATAL EXCEPTION",
    "AndroidRuntime: FATAL",
    "SIGSEGV",
    "SIGABRT",
    "signal 11",
    "signal 6",
    "libc    : Fatal",
    "thread '",
    "panicked at",
    "tombstone_",
    "Abort message",
];

const SECONDARY_CRASH_SIGNALS: &[&str] = &[
    "RenderProcessGoneDetail",
    "Renderer process (",
    "WebViewChromium: WebView crashed",
    "SIGTRAP",
    "signal 5",
    "Lost connection to chromium",
];

/// Try to capture a native crash from the previous session into the
/// `.crashlogs/` directory. Best-effort: never panics, swallows all IO
/// errors. Returns whether a report was written.
pub fn capture_previous_native_crash(crashlog_dir: &Path, package: &str) -> bool {
    let Some(lines) = read_logcat() else {
        return false;
    };
    let interesting = filter_interesting_lines(&lines, package);
    if interesting.is_empty() {
        return false;
    }
    // Secondary signals (renderer-gone, WebView crashed, lost connection
    // to chromium, SIGTRAP) also fire on a clean force-quit when the
    // system kills the chromium renderer before the main app. Bail out
    // if we don't have at least one primary signal — otherwise every
    // swipe-away or "Force Stop" surfaces a spurious crash dialog on
    // next launch.
    if !contains_primary_signal(&interesting) {
        return false;
    }
    let hash = hash_lines(&interesting);
    if already_reported(crashlog_dir, &hash) {
        return false;
    }
    if let Err(_) = std::fs::create_dir_all(crashlog_dir) {
        return false;
    }
    let written = write_report(crashlog_dir, &interesting);
    if written {
        let _ = std::fs::write(crashlog_dir.join(REPORTED_HASH_FILE), hash);
    }
    written
}

fn read_logcat() -> Option<Vec<String>> {
    let out = Command::new("logcat")
        .args([
            "-d",
            "-v",
            "threadtime",
            "-t",
            &LOGCAT_LINE_LIMIT.to_string(),
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.to_string())
            .collect(),
    )
}

fn filter_interesting_lines(lines: &[String], package: &str) -> Vec<String> {
    let native_lib = "futo_notes_tauri_lib";
    let mut hits: Vec<String> = Vec::new();
    let mut in_stack = false;
    let mut stack_remaining: usize = 0;
    for line in lines {
        // Crashpad emits the minidump payload as `F crashpad: <encoded
        // binary>` lines — hundreds of bytes of gibberish per line, with
        // no value to a human reader (decoding needs symbols + the .dmp
        // itself). Drop the whole tag so a stack-capture window after a
        // fatal signal doesn't sweep them in and blow past Zulip limits.
        if is_crashpad_tag(line) {
            continue;
        }
        let is_signal = is_crash_signal(line);
        let mentions_us = line.contains(package) || line.contains(native_lib);
        // Java/native stack frames usually appear on the lines right
        // after a FATAL/SIGSEGV line; keep capturing for a window so
        // the stack survives even though individual frames don't match
        // a signal substring.
        if is_signal {
            hits.push(truncate_line(line));
            in_stack = true;
            stack_remaining = 50;
            continue;
        }
        if in_stack {
            hits.push(truncate_line(line));
            stack_remaining = stack_remaining.saturating_sub(1);
            if stack_remaining == 0 {
                in_stack = false;
            }
            continue;
        }
        if mentions_us {
            hits.push(truncate_line(line));
        }
    }
    if hits.len() > MAX_REPORT_LINES {
        let start = hits.len() - MAX_REPORT_LINES;
        hits.drain(0..start);
    }
    hits
}

fn is_crash_signal(line: &str) -> bool {
    PRIMARY_CRASH_SIGNALS.iter().any(|s| line.contains(s))
        || SECONDARY_CRASH_SIGNALS.iter().any(|s| line.contains(s))
}

fn contains_primary_signal(lines: &[String]) -> bool {
    lines
        .iter()
        .any(|l| PRIMARY_CRASH_SIGNALS.iter().any(|s| l.contains(s)))
}

/// True if the logcat line's tag is `crashpad` (any priority). Format is
/// `MM-DD HH:MM:SS.mmm  PID  TID L tag    : message`, so we look for the
/// priority-letter + tag pair near the start of the line.
fn is_crashpad_tag(line: &str) -> bool {
    for prio in [" F ", " E ", " W ", " I ", " D ", " V "] {
        if let Some(idx) = line.find(prio) {
            let rest = &line[idx + prio.len()..];
            if rest.starts_with("crashpad") {
                return true;
            }
        }
    }
    false
}

fn truncate_line(line: &str) -> String {
    if line.len() <= MAX_LINE_LEN {
        return line.to_string();
    }
    let mut s = line[..MAX_LINE_LEN].to_string();
    s.push_str("…[truncated]");
    s
}

fn cap_stack(stack: String) -> String {
    if stack.len() <= MAX_STACK_BYTES {
        return stack;
    }
    // Keep the head — first crash-signal lines are the most useful.
    let mut s = stack;
    s.truncate(MAX_STACK_BYTES);
    s.push_str("\n…[truncated]");
    s
}

fn hash_lines(lines: &[String]) -> String {
    let mut h = Sha256::new();
    for line in lines {
        h.update(line.as_bytes());
        h.update(b"\n");
    }
    format!("{:x}", h.finalize())
}

fn already_reported(crashlog_dir: &Path, hash: &str) -> bool {
    std::fs::read_to_string(crashlog_dir.join(REPORTED_HASH_FILE))
        .map(|s| s.trim() == hash)
        .unwrap_or(false)
}

fn write_report(crashlog_dir: &Path, lines: &[String]) -> bool {
    let stack = cap_stack(lines.join("\n"));
    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // Pick a representative error message — the first line that looks
    // like a top-level crash signal, otherwise the first line.
    let summary = lines
        .iter()
        .find(|l| {
            l.contains("FATAL EXCEPTION")
                || l.contains("AndroidRuntime: FATAL")
                || l.contains("SIGSEGV")
                || l.contains("signal 11")
                || l.contains("signal 6")
                || l.contains("panicked at")
        })
        .cloned()
        .unwrap_or_else(|| lines[0].clone());
    let report = serde_json::json!({
        "error": format!("Native crash from previous session: {}", short_summary(&summary)),
        "stack": stack,
        "app_version": env!("CARGO_PKG_VERSION"),
        "platform": "tauri-android-native",
        "device_info": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "timestamp": iso_now(),
        "type": "native_crash",
        "route": "/",
    });
    let path: PathBuf = crashlog_dir.join(format!("crash-{ts_ms}-native-logcat.json"));
    std::fs::write(path, serde_json::to_string(&report).unwrap_or_default()).is_ok()
}

fn short_summary(line: &str) -> String {
    // Drop the threadtime prefix (timestamp + pids) for readability.
    let trimmed = line.trim();
    let suffix = match trimmed.find(": ") {
        Some(i) => &trimmed[i + 2..],
        None => trimmed,
    };
    let mut s = suffix.to_string();
    if s.len() > 200 {
        s.truncate(200);
    }
    s
}

fn iso_now() -> String {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_fatal_exception_and_captures_stack() {
        let lines = vec![
            "05-11 15:00:00.000  100  100 I some_unrelated_tag".to_string(),
            "05-11 15:00:01.000  200  200 E AndroidRuntime: FATAL EXCEPTION: main".to_string(),
            "05-11 15:00:01.001  200  200 E AndroidRuntime: Process: com.futo.notes, PID: 200".to_string(),
            "05-11 15:00:01.002  200  200 E AndroidRuntime: java.lang.NullPointerException".to_string(),
            "05-11 15:00:01.003  200  200 E AndroidRuntime:   at com.example.foo(Foo.java:10)".to_string(),
            "05-11 15:00:02.000  300  300 I other_unrelated".to_string(),
        ];
        let hits = filter_interesting_lines(&lines, "com.futo.notes");
        assert!(hits.iter().any(|l| l.contains("FATAL EXCEPTION")));
        assert!(hits.iter().any(|l| l.contains("NullPointerException")));
        assert!(hits.iter().any(|l| l.contains("Foo.java:10")));
    }

    #[test]
    fn detects_native_sigsegv() {
        let lines = vec![
            "05-11 15:00:00.000  200  200 F libc    : Fatal signal 11 (SIGSEGV)".to_string(),
            "05-11 15:00:00.500  201  201 F DEBUG   :   #00 pc 0000abcd  libfuto_notes_tauri_lib.so".to_string(),
        ];
        let hits = filter_interesting_lines(&lines, "com.futo.notes");
        assert!(hits.iter().any(|l| l.contains("SIGSEGV")));
        assert!(hits.iter().any(|l| l.contains("futo_notes_tauri_lib")));
    }

    #[test]
    fn detects_rust_panic() {
        let lines = vec![
            "05-11 15:00:00.000  200  200 E RustStdoutStderr: thread 'main' panicked at apps/tauri/src.rs:5:9:".to_string(),
            "05-11 15:00:00.001  200  200 E RustStdoutStderr: something went terribly wrong".to_string(),
        ];
        let hits = filter_interesting_lines(&lines, "com.futo.notes");
        assert!(hits.iter().any(|l| l.contains("panicked at")));
        assert!(hits.iter().any(|l| l.contains("RustStdoutStderr")));
    }

    #[test]
    fn ignores_plain_rust_stdout_startup_logs() {
        let lines = vec![
            "05-11 15:00:00.000  200  200 I RustStdoutStderr: [MCP][PLUGIN][INFO] MCP Bridge plugin initialized for 'FUTO Notes Dev'".to_string(),
            "05-11 15:00:00.001  200  200 I RustStdoutStderr: [MCP][WS_SERVER][INFO] WebSocket server listening".to_string(),
        ];
        let hits = filter_interesting_lines(&lines, "com.futo.notes.dev");
        assert!(hits.is_empty(), "startup logs should not become native crash reports: {hits:#?}");
    }

    #[test]
    fn ignores_unrelated_chatter() {
        let lines = vec![
            "05-11 15:00:00.000  100  100 I some_unrelated_tag: hello world".to_string(),
            "05-11 15:00:00.001  100  100 D another_tag: more debug noise".to_string(),
        ];
        let hits = filter_interesting_lines(&lines, "com.futo.notes");
        assert!(hits.is_empty());
    }

    #[test]
    fn dedupe_via_hash_matches() {
        let a = vec!["line one".to_string(), "line two".to_string()];
        let b = vec!["line one".to_string(), "line two".to_string()];
        let c = vec!["line one".to_string(), "line three".to_string()];
        assert_eq!(hash_lines(&a), hash_lines(&b));
        assert_ne!(hash_lines(&a), hash_lines(&c));
    }

    #[test]
    fn contains_primary_signal_requires_real_crash() {
        // Renderer-gone / WebView-crashed / Lost-connection-to-chromium /
        // SIGTRAP can all fire on a clean force-quit. Without a primary
        // signal alongside them, we should NOT treat the previous
        // session as crashed.
        let force_quit = vec![
            "05-11 15:00:00.000  200  200 W AwContents: RenderProcessGoneDetail{didCrash=true, rendererPriorityAtExit=0}".to_string(),
            "05-11 15:00:00.001  200  200 W cr_AwContents: Renderer process (pid 1234) crashed or was killed".to_string(),
            "05-11 15:00:00.002  200  200 E chromium: Lost connection to chromium".to_string(),
        ];
        assert!(!contains_primary_signal(&force_quit));

        let real_crash = vec![
            "05-11 15:00:00.000  200  200 F libc    : Fatal signal 11 (SIGSEGV)".to_string(),
            "05-11 15:00:00.001  200  200 W AwContents: RenderProcessGoneDetail{didCrash=true}".to_string(),
        ];
        assert!(contains_primary_signal(&real_crash));
    }

    #[test]
    fn short_summary_strips_threadtime_prefix() {
        let line = "05-11 15:00:01.000  200  200 E AndroidRuntime: FATAL EXCEPTION: main";
        assert_eq!(short_summary(line), "FATAL EXCEPTION: main");
    }

    #[test]
    fn drops_crashpad_minidump_payload_lines() {
        let gibberish: String = (0..800).map(|i| (b'!' + (i % 90) as u8) as char).collect();
        let lines = vec![
            "05-11 15:51:09.236 21259 21259 F libc    : Fatal signal 5 (SIGTRAP)".to_string(),
            format!("05-11 15:51:09.300 21433 21433 F crashpad: {gibberish}"),
            format!("05-11 15:51:09.301 21433 21433 F crashpad: {gibberish}"),
            "05-11 15:51:09.346 21438 21438 F DEBUG   : backtrace:".to_string(),
            "05-11 15:51:09.346 21438 21438 F DEBUG   :   #00 pc 00000000069307bc /lib.so".to_string(),
            "05-11 15:56:32.721 22572 22572 F crashpad: -----BEGIN CRASHPAD MINIDUMP-----".to_string(),
        ];
        let hits = filter_interesting_lines(&lines, "com.futo.notes.dev");
        assert!(hits.iter().any(|l| l.contains("Fatal signal 5")));
        assert!(hits.iter().any(|l| l.contains("backtrace:")));
        assert!(hits.iter().any(|l| l.contains("#00 pc")));
        // No crashpad-tagged lines survive — even the MINIDUMP markers
        // are dropped because their contents are useless without the
        // actual .dmp file.
        assert!(
            !hits.iter().any(|l| l.contains(" F crashpad:")),
            "crashpad lines leaked into report: {hits:#?}"
        );
        assert!(
            !hits.iter().any(|l| l.contains("BEGIN CRASHPAD MINIDUMP")),
            "minidump marker leaked into report"
        );
    }

    #[test]
    fn truncates_oversized_lines() {
        let long: String = "x".repeat(MAX_LINE_LEN + 200);
        let lines = vec![
            "05-11 15:00:00.000  200  200 F libc    : Fatal signal 11 (SIGSEGV)".to_string(),
            format!("05-11 15:00:00.001  200  200 F DEBUG   : {long}"),
        ];
        let hits = filter_interesting_lines(&lines, "com.futo.notes");
        let stack_line = hits
            .iter()
            .find(|l| l.contains("DEBUG"))
            .expect("debug line captured");
        assert!(stack_line.len() <= MAX_LINE_LEN + "…[truncated]".len());
        assert!(stack_line.ends_with("…[truncated]"));
    }

    #[test]
    fn cap_stack_keeps_head_when_oversized() {
        let stack = "head\n".to_string() + &"x".repeat(MAX_STACK_BYTES * 2);
        let capped = cap_stack(stack);
        assert!(capped.len() <= MAX_STACK_BYTES + "\n…[truncated]".len());
        assert!(capped.starts_with("head\n"));
        assert!(capped.ends_with("…[truncated]"));
    }

    #[test]
    fn is_crashpad_tag_matches_priority_letters() {
        assert!(is_crashpad_tag(
            "05-11 15:51:09.300 21433 21433 F crashpad: payload"
        ));
        assert!(is_crashpad_tag(
            "05-11 15:51:09.300 21433 21433 E crashpad: error"
        ));
        assert!(!is_crashpad_tag(
            "05-11 15:51:09.300 21433 21433 F DEBUG   : note about crashpad"
        ));
        assert!(!is_crashpad_tag(
            "05-11 15:51:09.300 21433 21433 F libc    : Fatal signal"
        ));
    }
}
