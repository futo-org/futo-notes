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
            crate::search_commands::init_on_startup(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::legacy_filesystem_commands::fs_list_notes_with_meta,
            crate::image_commands::fs_save_image,
            crate::image_commands::fs_paste_clipboard_image,
            crate::filesystem_watcher::fs_start_watcher,
            crate::legacy_filesystem_commands::fs_list_folders,
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
            crate::note_commands::notes_scan,
            crate::note_commands::notes_seed_if_empty,
            crate::note_commands::notes_read,
            crate::note_commands::notes_exists,
            crate::note_commands::notes_write,
            crate::note_commands::notes_create,
            crate::note_commands::notes_delete,
            crate::note_commands::notes_rename,
            crate::note_commands::notes_move,
            crate::folder_commands::notes_create_folder,
            crate::note_commands::notes_delete_to_trash,
            crate::folder_commands::notes_rename_folder,
            crate::folder_commands::notes_delete_folder,
            crate::search_commands::search_query,
            crate::search_commands::search_status,
            crate::search_commands::search_rebuild,
            crate::search_commands::search_notify,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
