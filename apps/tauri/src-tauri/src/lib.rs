//! FUTO Notes desktop adapter.
//!
//! Domain behavior lives in the shared `futo-notes-*` crates. This crate owns
//! only Tauri IPC, desktop lifecycle, OS integration, and translation between
//! those two boundaries.

mod app_menu;
mod application;
mod application_state;
mod background_tasks;
mod filesystem_watcher;
mod image_commands;
mod instance_journal;
mod local_notes;
mod panic_reporter;
mod platform_integration;
mod portal_vault;
mod sync;
mod system_trash;
mod updater_commands;
mod vault_location;
mod window_reveal;

pub fn run() {
    application::run();
}
