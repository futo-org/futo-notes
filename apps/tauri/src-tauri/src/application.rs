//! Desktop application composition root.

use crate::application_state::AppState;

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
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            let handle = app.handle();
            if let Ok(root) = crate::vault_location::root(handle) {
                crate::panic_reporter::install(root.join(".crashlogs"));
            }
            crate::platform_integration::configure_app(handle)?;
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
            crate::sync::password_store::e2ee_password_get,
            crate::sync::password_store::e2ee_password_set,
            crate::sync::password_store::e2ee_password_delete,
            crate::local_notes::local_notes_bootstrap,
            crate::local_notes::local_notes_snapshot,
            crate::local_notes::local_notes_inventory,
            crate::local_notes::local_notes_read,
            crate::local_notes::local_notes_exists,
            crate::local_notes::local_notes_save,
            crate::local_notes::local_notes_delete,
            crate::local_notes::local_notes_move,
            crate::local_notes::local_notes_create_folder,
            crate::local_notes::local_notes_rename_folder,
            crate::local_notes::local_notes_delete_folder,
            crate::local_notes::local_notes_reset,
            crate::local_notes::local_notes_search,
            crate::local_notes::local_notes_search_status,
            crate::local_notes::local_notes_rescan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
