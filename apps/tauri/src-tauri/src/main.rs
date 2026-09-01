#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        const WEBKIT_SOFTWARE_RENDER: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

        // Preserve an explicit WebKit setting. Otherwise retain the blank-window
        // workaround only for NVIDIA, with a distro/user escape hatch for
        // machines whose GPU cannot be identified reliably.
        if futo_notes_tauri_lib::linux_should_set_software_render(
            std::env::var_os(WEBKIT_SOFTWARE_RENDER).is_some(),
            std::env::var_os("FUTO_NOTES_SOFTWARE_RENDER").as_deref(),
            futo_notes_tauri_lib::linux_has_nvidia_gpu(),
        ) {
            std::env::set_var(WEBKIT_SOFTWARE_RENDER, "1");
        }
    }

    futo_notes_tauri_lib::run();
}
