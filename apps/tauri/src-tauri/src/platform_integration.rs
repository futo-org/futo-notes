//! Operating-system startup integration, isolated from application composition.

use tauri::Manager;

#[cfg(target_os = "linux")]
use tauri::Emitter;

pub(crate) fn prepare_process() {
    #[cfg(unix)]
    raise_fd_limit();
    #[cfg(target_os = "linux")]
    install_linux_log_filters();
}

pub(crate) fn configure_app(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(desktop)]
    if std::env::var("FUTO_NOTES_MULTI_INSTANCE").is_err() {
        app.plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
            },
        ))?;
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(window) = app.get_webview_window("main") {
            window.set_decorations(false)?;
        }
        let app = app.clone();
        crate::background_tasks::spawn("futo-linux-theme", move || watch_linux_theme(app))?;
    }

    Ok(())
}

#[cfg(any(test, target_os = "linux"))]
fn should_suppress_libsoup_warning(domain: Option<&str>, message: &str) -> bool {
    domain == Some("libsoup-http2")
        && message.contains("Unexpected state changed WRITE_DATA -> READ_DATA_START")
        && message.contains("expected to be from READ_HEADERS")
}

#[cfg(target_os = "linux")]
fn install_linux_log_filters() {
    glib::log_set_handler(
        Some("libsoup-http2"),
        glib::LogLevels::LEVEL_WARNING,
        false,
        false,
        |domain, level, message| {
            if !should_suppress_libsoup_warning(domain, message) {
                glib::log_default_handler(domain, level, Some(message));
            }
        },
    );
}

#[cfg(target_os = "linux")]
fn watch_linux_theme(app: tauri::AppHandle) {
    use std::io::BufRead;
    use std::process::{Command, Stdio};

    let Ok(mut child) = Command::new("gdbus")
        .args([
            "monitor",
            "--session",
            "--dest",
            "org.freedesktop.portal.Desktop",
            "--object-path",
            "/org/freedesktop/portal/desktop",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        return;
    };

    for line in std::io::BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line.contains("color-scheme") && line.contains("SettingChanged") {
            let theme = if line.contains("uint32 1") {
                "dark"
            } else {
                "light"
            };
            let _ = app.emit("linux-theme-changed", theme);
        }
    }
    let _ = child.kill();
}

#[cfg(unix)]
fn raise_fd_limit() {
    unsafe {
        let mut limit: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
            let target = limit.rlim_max.min(10_240);
            if limit.rlim_cur < target {
                limit.rlim_cur = target;
                libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! Tests for operating-system integration policy.
    use super::*;

    #[test]
    fn warning_filter_is_narrow() {
        let warning =
            "Unexpected state changed WRITE_DATA -> READ_DATA_START, expected to be from READ_HEADERS";
        assert!(should_suppress_libsoup_warning(
            Some("libsoup-http2"),
            warning
        ));
        assert!(!should_suppress_libsoup_warning(
            Some("webkit2gtk"),
            warning
        ));
        assert!(!should_suppress_libsoup_warning(
            Some("libsoup-http2"),
            "different warning"
        ));
    }
}
