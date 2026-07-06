pub mod core;
pub mod notes;
pub mod search;
mod panic_reporter;
mod sync;
mod sync_state;

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
        .manage(CoreState::default())
        .manage(sync_state::SyncState::default())
        .manage(search::SearchState::default());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    // In-app updater: desktop only (iOS/Android update via store/sideload).
    // Endpoints + pubkey come from `plugins.updater` in the merged config; dev
    // inherits the production HTTPS endpoint (see updaterConfig.test.ts). Dev
    // builds can't self-update regardless of endpoint: `app_self_update_supported`
    // returns false in any debug build (core.rs gates on `cfg!(debug_assertions)`),
    // so the auto-checker no-ops and UpdateBanner never starts in dev. The Settings
    // "Check for updates" button is still force-shown in dev for manual testing; it
    // queries the prod endpoint but can't swap a dev binary, so registering the
    // plugin in debug keeps that button functional.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|_app| {
            // Install the Rust panic reporter as early as possible so a panic
            // inside the rest of setup still leaves a report on disk.
            if let Ok(root) = core::notes_root(_app.handle()) {
                let crashlogs = root.join(".crashlogs");
                panic_reporter::install(crashlogs.clone());
            }
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
            // On Linux, disable native GTK decorations so the frontend can
            // render its own Breeze-style titlebar consistently across DEs.
            #[cfg(target_os = "linux")]
            {
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
            // Start the on-device search engine. Spawns its own background
            // thread to open the Tantivy indices + reconcile, so this returns
            // immediately and never gates app setup.
            search::init_on_startup(_app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs_list_notes_with_meta,
            fs_save_image,
            fs_paste_clipboard_image,
            fs_start_watcher,
            fs_list_folders,
            fs_delete_folder,
            fs_move_note,
            notes_dir_override_load,
            notes_dir_override_save,
            resolve_default_notes_root,
            app_self_update_supported,
            sync::e2ee_connect,
            sync::e2ee_resume,
            sync::e2ee_disconnect,
            sync::e2ee_status,
            sync::e2ee_sync_run,
            sync::e2ee_start_live,
            sync::e2ee_stop_live,
            sync::e2ee_note_changed,
            // ── Note CRUD (futo-notes-model::crud, Phase 1) ──
            notes::notes_scan,
            notes::notes_scan_folders,
            notes::notes_seed_if_empty,
            notes::notes_read,
            notes::notes_exists,
            notes::notes_write,
            notes::notes_create,
            notes::notes_delete,
            notes::notes_rename,
            notes::notes_move,
            notes::notes_create_folder,
            notes::notes_delete_to_trash,
            notes::notes_rename_folder,
            notes::notes_delete_folder,
            // ── Shared full-text search: Tantivy BM25 ──
            search::search_query,
            search::search_status,
            search::search_rebuild,
            search::search_notify,
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
