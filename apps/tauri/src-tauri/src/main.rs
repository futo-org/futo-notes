#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Disable DMA-BUF renderer on Linux — WebKitGTK's default causes blank
    // windows / crashes on many Wayland + NVIDIA configurations.
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    futo_notes_tauri_lib::run();
}
