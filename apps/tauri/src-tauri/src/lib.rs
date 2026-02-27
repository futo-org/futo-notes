pub mod core;

use core::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(CoreState::default())
        .invoke_handler(tauri::generate_handler![
            fs_list_note_files,
            fs_read_note,
            fs_write_note,
            fs_delete_note_file,
            fs_note_exists,
            fs_delete_all_content,
            appdata_read,
            appdata_write,
            appdata_delete,
            appdata_list,
            appdata_read_binary,
            appdata_write_binary,
            supersearch_has_artifacts,
            supersearch_download,
            supersearch_query,
            fs_save_image,
            fs_get_image_path,
            fs_start_watcher,
            app_get_config,
            app_save_config,
            app_get_version,
            app_get_platform,
            core_rebuild_index,
            core_get_note_previews,
            core_keyword_search,
            core_prepare_sync_payload,
            core_apply_sync_delta,
            engagement_load,
            engagement_track_open,
            engagement_track_edit,
            engagement_remove,
            engagement_rename,
            engagement_get_all,
            engagement_flush,
            supersearch_is_ready,
            supersearch_get_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
