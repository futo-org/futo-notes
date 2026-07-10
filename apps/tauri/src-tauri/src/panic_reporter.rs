//! Rust panic reporter — writes a CrashReport-shaped JSON to the same
//! `.crashlogs/` dir the JS reporter scans on next launch. Lets us catch
//! Tauri-side panics that `window.onerror` can't see because the JS
//! handler never gets a chance to run before the process unwinds.

use std::path::PathBuf;
use std::sync::OnceLock;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// Resolved at startup once we know the notes root. The hook must not
/// touch Tauri's AppHandle from the panic path (it may already be
/// poisoned by the time we run).
static CRASHLOG_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn install(crashlog_dir: PathBuf) {
    if CRASHLOG_DIR.set(crashlog_dir).is_err() {
        return;
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write_report(info);
        prev(info);
    }));
}

fn write_report(info: &std::panic::PanicHookInfo<'_>) {
    let Some(dir) = CRASHLOG_DIR.get() else {
        return;
    };
    let _ = std::fs::create_dir_all(dir);

    let msg = if let Some(s) = info.payload().downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "panic with non-string payload".to_string()
    };
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "unknown".to_string());
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
    let timestamp = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| String::new());
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let report = build_report_json(&msg, &location, &backtrace, &timestamp);
    let filename = format!("crash-{ts_ms}-rust-panic.json");
    let _ = std::fs::write(
        dir.join(filename),
        serde_json::to_string(&report).unwrap_or_default(),
    );
}

/// Shape the JSON to match the JS `CrashReport` interface so the existing
/// reporter picks it up on next launch without any schema branching.
fn build_report_json(
    msg: &str,
    location: &str,
    backtrace: &str,
    timestamp: &str,
) -> serde_json::Value {
    serde_json::json!({
        "error": format!("Rust panic at {location}: {msg}"),
        "stack": backtrace,
        "app_version": env!("CARGO_PKG_VERSION"),
        "platform": "tauri-rust",
        "device_info": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "timestamp": timestamp,
        "type": "rust_panic",
        "route": "/",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_json_matches_crash_report_interface() {
        let report = build_report_json(
            "something went wrong",
            "src/foo.rs:10:5",
            "fake backtrace",
            "2026-05-11T20:00:00Z",
        );
        assert!(report["error"]
            .as_str()
            .unwrap()
            .contains("src/foo.rs:10:5"));
        assert!(report["error"]
            .as_str()
            .unwrap()
            .contains("something went wrong"));
        assert_eq!(report["stack"].as_str().unwrap(), "fake backtrace");
        assert_eq!(report["type"].as_str().unwrap(), "rust_panic");
        assert_eq!(
            report["timestamp"].as_str().unwrap(),
            "2026-05-11T20:00:00Z"
        );
        assert!(!report["app_version"].as_str().unwrap().is_empty());
        assert!(!report["platform"].as_str().unwrap().is_empty());
        assert!(!report["device_info"].as_str().unwrap().is_empty());
    }

    #[test]
    fn install_creates_target_dir_and_returns_idempotently() {
        let temp = std::env::temp_dir().join(format!("futo-panic-test-{}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        install(temp.clone());
        install(temp.join("ignored"));
        assert_eq!(CRASHLOG_DIR.get(), Some(&temp));
        let _ = std::fs::remove_dir_all(&temp);
    }
}
