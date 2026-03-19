pub mod core;
pub mod graph_clusters;
pub mod graph_positions;

use core::*;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CoreState::default());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }

    builder
        .setup(|_app| {
            #[cfg(desktop)]
            {
                _app.handle().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.set_focus();
                    }
                }))?;
            }
            // On iOS, extend the webview edge-to-edge so CSS env(safe-area-inset-*)
            // reports correct values and the app fills the full screen.
            #[cfg(target_os = "ios")]
            {
                let webview = _app.get_webview_window("main").unwrap();
                webview.with_webview(move |wv| {
                    use objc2::runtime::AnyObject;
                    use objc2::msg_send;
                    unsafe {
                        let wk: *mut AnyObject = wv.inner().cast();
                        // WKWebView.scrollView
                        let scroll_view: *mut AnyObject = msg_send![wk, scrollView];
                        // UIScrollView.contentInsetAdjustmentBehavior = .never (2)
                        let _: () = msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2_isize];
                        // Get the WKWebView's superview (the view controller's view)
                        let superview: *mut AnyObject = msg_send![wk, superview];
                        if !superview.is_null() {
                            // Set insetsLayoutMarginsFromSafeArea = NO
                            let _: () = msg_send![superview, setInsetsLayoutMarginsFromSafeArea: false];
                        }
                    }
                }).unwrap();
            }
            // On Linux, disable native GTK decorations so the frontend can
            // render its own Breeze-style titlebar consistently across DEs.
            #[cfg(target_os = "linux")]
            {
                if let Some(w) = _app.get_webview_window("main") {
                    w.set_decorations(false)?;
                }
            }
            Ok(())
        })
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
            supersearch_note_vector,
            supersearch_all_note_vectors,
            fs_save_image,
            fs_save_image_bytes,
            fs_get_image_path,
            fs_start_watcher,
            app_get_config,
            app_save_config,
            app_set_notes_dir,
            app_get_version,
            app_get_platform,
            core_rebuild_index,
            core_get_note_previews,
            core_keyword_search,
            core_prepare_sync_payload,
            core_apply_sync_delta,
            core_prepare_image_sync,
            core_read_image_bytes,
            core_write_synced_image,
            core_apply_image_sync_delta,
            core_list_image_files,
            core_delete_image_file,
            engagement_load,
            engagement_track_open,
            engagement_track_edit,
            engagement_remove,
            engagement_rename,
            engagement_get_all,
            engagement_flush,
            supersearch_is_ready,
            supersearch_get_state,
            graph_positions::graph_compute_positions,
            graph_clusters::graph_compute_clusters,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
