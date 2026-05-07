pub mod core;

use core::*;
use tauri::{Emitter, Manager};

fn should_suppress_libsoup_http2_warning(log_domain: Option<&str>, message: &str) -> bool {
    log_domain == Some("libsoup-http2")
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
        |log_domain, log_level, message| {
            if should_suppress_libsoup_http2_warning(log_domain, message) {
                return;
            }
            glib::log_default_handler(log_domain, log_level, Some(message));
        },
    );
}

/// Watch the XDG Desktop Portal for color-scheme changes and emit a Tauri event.
/// This covers GNOME, KDE Plasma, and any DE that implements the portal.
/// Tauri's built-in onThemeChanged doesn't fire on Linux when the DE switches
/// between light and dark mode.
#[cfg(target_os = "linux")]
fn linux_color_scheme_watcher(app: tauri::AppHandle) {
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
    let reader = std::io::BufReader::new(stdout);

    for line in reader.lines() {
        let Ok(line) = line else { break };
        // Match: SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 N>)
        // N: 0 = no preference, 1 = prefer dark, 2 = prefer light
        if !line.contains("color-scheme") || !line.contains("SettingChanged") {
            continue;
        }
        let theme = if line.contains("uint32 1") {
            "dark"
        } else {
            "light"
        };
        let _ = app.emit("linux-theme-changed", theme);
    }
    let _ = child.kill();
}

/// Point ORT at the libonnxruntime.so we ship alongside the binary. Called
/// from the Tauri setup hook before any `Session::builder()` call, so
/// `ort::init` dlopens the right .so. Checks, in order:
///   1. Sibling of the current exe — covers AppImage (`usr/bin/` next to the
///      binary) and dev (`target/{debug,release}/` via fetch-ort-linux.mjs).
///   2. `<exe_dir>/../lib/futo-notes/libonnxruntime.so` — .deb/.rpm install
///      layout (`/usr/bin/futo-notes-tauri` → `/usr/lib/futo-notes/...`).
///
/// Respects ORT_DYLIB_PATH if the user has already set it.
#[cfg(target_os = "linux")]
fn init_ort_dylib_path() {
    if std::env::var_os("ORT_DYLIB_PATH").is_some() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = exe.parent() else {
        return;
    };
    for cand in [
        dir.join("libonnxruntime.so"),
        dir.join("../lib/futo-notes/libonnxruntime.so"),
    ] {
        if cand.exists() {
            std::env::set_var("ORT_DYLIB_PATH", cand);
            return;
        }
    }
}

/// Raise the file-descriptor soft limit. iOS defaults to 256 which is too low
/// for a WebView app that also reads/writes thousands of note files during sync.
#[cfg(unix)]
fn raise_fd_limit() {
    unsafe {
        let mut rlim: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlim) == 0 {
            let target = rlim.rlim_max.min(10240);
            if rlim.rlim_cur < target {
                rlim.rlim_cur = target;
                libc::setrlimit(libc::RLIMIT_NOFILE, &rlim);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(unix)]
    raise_fd_limit();
    #[cfg(target_os = "linux")]
    install_linux_log_filters();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .manage(CoreState::default());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    builder
        .setup(|_app| {
            #[cfg(desktop)]
            {
                if std::env::var("FUTO_NOTES_MULTI_INSTANCE").is_err() {
                    _app.handle().plugin(tauri_plugin_single_instance::init(
                        |app, _args, _cwd| {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.set_focus();
                            }
                        },
                    ))?;
                }
            }
            // On iOS, extend the webview edge-to-edge so CSS env(safe-area-inset-*)
            // reports correct values and the app fills the full screen.
            #[cfg(target_os = "ios")]
            {
                let webview = _app.get_webview_window("main").unwrap();
                webview
                    .with_webview(move |wv| {
                        use objc2::msg_send;
                        use objc2::runtime::AnyObject;
                        unsafe {
                            let wk: *mut AnyObject = wv.inner().cast();
                            // WKWebView.scrollView
                            let scroll_view: *mut AnyObject = msg_send![wk, scrollView];
                            // UIScrollView.contentInsetAdjustmentBehavior = .never (2)
                            let _: () =
                                msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2_isize];
                            // Get the WKWebView's superview (the view controller's view)
                            let superview: *mut AnyObject = msg_send![wk, superview];
                            if !superview.is_null() {
                                // Set insetsLayoutMarginsFromSafeArea = NO
                                let _: () =
                                    msg_send![superview, setInsetsLayoutMarginsFromSafeArea: false];
                            }
                        }
                    })
                    .unwrap();
            }
            // On Linux, disable native GTK decorations so the frontend can
            // render its own Breeze-style titlebar consistently across DEs.
            #[cfg(target_os = "linux")]
            {
                init_ort_dylib_path();
                if let Some(w) = _app.get_webview_window("main") {
                    w.set_decorations(false)?;
                }
                // Monitor system color scheme via XDG Desktop Portal.
                // Tauri's onThemeChanged doesn't fire on Linux when the DE
                // switches between light/dark mode.
                let app_handle = _app.handle().clone();
                std::thread::spawn(move || {
                    linux_color_scheme_watcher(app_handle);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs_set_mtime,
            fs_list_notes_with_meta,
            fs_write_note_atomic,
            fs_save_image,
            fs_paste_clipboard_image,
            fs_start_watcher,
            fs_list_folders,
            fs_create_folder,
            fs_rename_folder,
            fs_delete_folder,
            fs_delete_note_to_trash,
            fs_move_note,
            notes_dir_override_load,
            notes_dir_override_save,
            resolve_default_notes_root,
            core_apply_sync_delta_v2,
            show_soft_keyboard,
            // Phase 2 dev-only smoke test for on-device embedding. Gated at
            // the module level in core::inference_dev so the command only
            // exists in debug builds and non-iOS targets.
            inference_test_embed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::should_suppress_libsoup_http2_warning;

    #[test]
    fn suppresses_only_the_known_libsoup_http2_warning() {
        assert!(should_suppress_libsoup_http2_warning(
            Some("libsoup-http2"),
            "Unexpected state changed WRITE_DATA -> READ_DATA_START, expected to be from READ_HEADERS",
        ));
        assert!(!should_suppress_libsoup_http2_warning(
            Some("webkit2gtk"),
            "Unexpected state changed WRITE_DATA -> READ_DATA_START, expected to be from READ_HEADERS",
        ));
        assert!(!should_suppress_libsoup_http2_warning(
            Some("libsoup-http2"),
            "Some other warning",
        ));
    }
}
