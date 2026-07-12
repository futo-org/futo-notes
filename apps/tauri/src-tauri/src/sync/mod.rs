//! Desktop adapter for the shared end-to-end encrypted sync crate.

mod cycle_runner;
mod frontend_contract;
pub(crate) mod password_store;
pub(crate) mod session_state;
pub(crate) mod tauri_commands;
mod tauri_events;
