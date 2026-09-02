//! FUTO Notes desktop adapter.
//!
//! Domain behavior lives in the shared `futo-notes-*` crates. This crate owns
//! only Tauri IPC, desktop lifecycle, OS integration, and translation between
//! those two boundaries.

mod app_menu;
mod application;
mod application_state;
mod background_tasks;
mod desktop_settings;
mod external_file_open;
mod filesystem_watcher;
mod image_commands;
mod instance_journal;
mod license;
#[cfg(test)]
mod linux_packaging;
mod local_notes;
mod panic_reporter;
mod platform_integration;
mod portal_vault;
mod sync;
mod system_trash;
mod updater_commands;
mod vault_location;
mod window_controls;
mod window_reveal;

#[cfg(target_os = "linux")]
pub fn linux_has_nvidia_gpu() -> bool {
    platform_integration::linux_has_nvidia_gpu()
}

#[cfg(target_os = "linux")]
pub fn linux_should_set_software_render(
    webkit_override_exists: bool,
    futo_override: Option<&std::ffi::OsStr>,
    has_nvidia_gpu: bool,
) -> bool {
    platform_integration::linux_should_set_software_render(
        webkit_override_exists,
        futo_override,
        has_nvidia_gpu,
    )
}

pub fn run() {
    application::run();
}
