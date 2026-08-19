//! Desktop application composition root.

use crate::application_state::AppState;

/// The debug-only QA bridge, bound to loopback on a per-worktree base port.
///
/// Two deliberate departures from the plugin's defaults, each a fix for
/// repeatedly reported friction:
///
/// * **`127.0.0.1`, not `0.0.0.0`.** The plugin picks a port by trying to BIND
///   it. Binding `0.0.0.0:9223` succeeds even while another process holds
///   `127.0.0.1:9223` (a browser's remote-debugging socket does exactly this),
///   so the plugin logged 9223 as its own while every client — all of which dial
///   `127.0.0.1` — reached the OTHER process. That surfaced as
///   `Could not connect to ws://127.0.0.1:9223` from a perfectly healthy app,
///   and worse, as a harness driving a foreign process. Binding the address
///   clients actually dial makes the scan see what they see, so a squatter
///   pushes the bridge to the next free port instead of aliasing it.
///
/// * **Per-worktree base port.** `FUTO_MCP_BASE_PORT` is set by
///   `scripts/tauri-dev.mjs` from the worktree slot (`scripts/lib/slot.mjs`,
///   the single owner of slot derivation — do not re-derive it here). Parallel
///   worktrees then never contend for one 9223 like they used to.
#[cfg(debug_assertions)]
fn mcp_bridge_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let mut builder = tauri_plugin_mcp_bridge::Builder::new().bind_address("127.0.0.1");
    if let Some(port) = std::env::var("FUTO_MCP_BASE_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
    {
        builder = builder.base_port(port);
    }
    builder.build()
}

pub(crate) fn run() {
    crate::platform_integration::prepare_process();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(mcp_bridge_plugin());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            let handle = app.handle();
            if let Ok(root) = crate::vault_location::root(handle) {
                crate::panic_reporter::install(root.join(".crashlogs"));
            }
            crate::platform_integration::configure_app(handle)?;
            crate::instance_journal::install(handle);
            crate::local_notes::init_on_startup(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::image_commands::fs_save_image,
            crate::image_commands::fs_paste_clipboard_image,
            crate::filesystem_watcher::fs_start_watcher,
            crate::vault_location::notes_dir_override_load,
            crate::vault_location::notes_dir_override_save,
            crate::vault_location::resolve_default_notes_root,
            crate::updater_commands::app_self_update_supported,
            crate::sync::tauri_commands::e2ee_connect,
            crate::sync::tauri_commands::e2ee_resume,
            crate::sync::tauri_commands::e2ee_disconnect,
            crate::sync::tauri_commands::e2ee_status,
            crate::sync::tauri_commands::e2ee_sync_run,
            crate::sync::tauri_commands::e2ee_start_live,
            crate::sync::tauri_commands::e2ee_stop_live,
            crate::sync::tauri_commands::e2ee_note_changed,
            crate::sync::tauri_commands::e2ee_classify_open_note,
            crate::sync::password_store::e2ee_password_get,
            crate::sync::password_store::e2ee_password_set,
            crate::sync::password_store::e2ee_password_delete,
            crate::local_notes::local_notes_bootstrap,
            crate::local_notes::local_notes_startup_listing,
            crate::local_notes::local_notes_snapshot,
            crate::local_notes::local_notes_inventory,
            crate::local_notes::local_notes_read,
            crate::local_notes::local_notes_exists,
            crate::local_notes::local_notes_save,
            crate::local_notes::local_notes_flush_draft,
            crate::local_notes::local_notes_delete,
            crate::local_notes::local_notes_move,
            crate::local_notes::local_notes_create_folder,
            crate::local_notes::local_notes_rename_folder,
            crate::local_notes::local_notes_move_folder,
            crate::local_notes::local_notes_delete_folder,
            crate::local_notes::local_notes_reset,
            crate::local_notes::local_notes_search,
            crate::local_notes::local_notes_wait_until_search_ready,
            crate::local_notes::local_notes_rescan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
