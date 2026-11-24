//! A quit the OS asks for goes through the window's close handler, which saves.
//!
//! Closing the main window raises `CloseRequested`: the page's close handler
//! (`startNativeShell.ts`) flushes the pending save and exits, and the close deadline
//! (close_deadline.rs) ends a page that cannot answer. macOS reaches this from
//! `applicationShouldTerminate:` (macos_terminate.rs). Linux reaches it from SIGTERM
//! and SIGHUP (logout, shutdown, `systemctl poweroff`, `kill`), whose default action
//! ends the process without `RunEvent::Exit`, so its final save never ran and up to
//! the host's 2 s of edits were lost. Nothing in tao, wry or Tauri handles them.

/// Closes the main window to start the quit. Returns false when there is no window
/// to close (no page, so nothing to save): the caller then ends the app itself.
pub(crate) fn close_main_window(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    app.get_webview_window("main")
        .is_some_and(|window| window.close().is_ok())
}

/// Routes SIGTERM and SIGHUP through the close handler. glib runs the handler on
/// the main loop, not in signal context. Call it from `setup`, on the main thread:
/// `unix_signal_add_local` panics on a thread that does not own the default main
/// context, and the GTK main thread is the one that does.
#[cfg(target_os = "linux")]
pub(crate) fn install_signal_handlers(app: &tauri::AppHandle) {
    for signal in [libc::SIGTERM, libc::SIGHUP] {
        let app = app.clone();
        glib::unix_signal_add_local(signal, move || {
            if !close_main_window(&app) {
                app.exit(0);
            }
            glib::ControlFlow::Continue
        });
    }
}
