//! FUTO Notes desktop adapter.
//!
//! Domain behavior lives in the shared `futo-notes-*` crates. This crate owns
//! only Tauri IPC, desktop lifecycle, OS integration, and translation between
//! those two boundaries.

mod application;
mod application_state;
mod background_tasks;
mod filesystem_watcher;
mod image_commands;
mod local_notes;
mod panic_reporter;
mod platform_integration;
mod sync;
mod system_trash;
mod updater_commands;
mod vault_location;

pub fn run() {
    application::run();
}
