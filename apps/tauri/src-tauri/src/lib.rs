pub mod core;

use core::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .manage(CoreState::default())
        .setup(|_app| {
            // On iOS, extend the webview edge-to-edge so CSS env(safe-area-inset-*)
            // reports correct values and the app fills the full screen.
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
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
            fs_save_image,
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
            engagement_load,
            engagement_track_open,
            engagement_track_edit,
            engagement_remove,
            engagement_rename,
            engagement_get_all,
            engagement_flush,
            supersearch_is_ready,
            supersearch_get_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
