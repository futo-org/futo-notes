//! The macOS application menu.
//!
//! On macOS an app's command surface lives in the menu bar, and NSApplication
//! resolves a menu item's key equivalent BEFORE the keystroke reaches the
//! webview. Tauri's stock menu (`Menu::default`) therefore silently owned ⌘W
//! through `PredefinedMenuItem::close_window`, so the frontend's own ⌘W
//! ("close tab", registerNotesShellShortcuts.ts) could never run — ⌘W closed
//! the whole window instead. Owning the menu here fixes that and makes every
//! app-level accelerator discoverable where macOS users look for it.
//!
//! Items the frontend performs are forwarded to it as an `app-menu` event
//! carrying the command id; the ids are the same strings the frontend
//! shortcut registry dispatches on, which `frontend_commands_match_the_shell`
//! locks. Window-level items (close window, minimize, fullscreen) are handled
//! natively and never cross the IPC boundary.
//!
//! Windows and Linux deliberately get no menu: `Builder::menu` renders an
//! in-window menu bar there, which this app does not want. Their accelerators
//! stay with the frontend keydown handler.

/// Event name that carries a menu command id to the frontend.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const MENU_EVENT: &str = "app-menu";

/// Commands the frontend performs, in menu order. Every id here must be
/// handled by `src/app/registerNotesShellShortcuts.ts`.
///
/// Only the macOS `install` reads these, but the contract test below asserts on
/// them on every platform, so they are compiled everywhere rather than
/// `cfg`-gated away.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const FRONTEND_COMMANDS: &[&str] = &[
    "new-note",
    "new-tab",
    "reopen-tab",
    "search",
    "close-tab",
    "settings",
    "toggle-sidebar",
];

/// Handled in Rust, not forwarded.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CLOSE_WINDOW: &str = "close-window";

#[cfg(target_os = "macos")]
pub(crate) fn install(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    use tauri::{Emitter, Manager};

    let package = app.package_info();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+Comma")
        .build(app)?;
    let new_note = MenuItemBuilder::with_id("new-note", "New Note")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_tab = MenuItemBuilder::with_id("new-tab", "New Tab")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let reopen_tab = MenuItemBuilder::with_id("reopen-tab", "Reopen Closed Tab")
        .accelerator("Shift+CmdOrCtrl+T")
        .build(app)?;
    let search = MenuItemBuilder::with_id("search", "Search Notes…")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    // ⌘W closes the TAB (Safari's model). Deliberately not
    // `PredefinedMenuItem::close_window`, whose accelerator is hard-wired to
    // ⌘W in muda and cannot be re-bound — including it anywhere in the menu
    // would take ⌘W back off the tab.
    let close_tab = MenuItemBuilder::with_id("close-tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let close_window = MenuItemBuilder::with_id(CLOSE_WINDOW, "Close Window")
        .accelerator("Shift+CmdOrCtrl+W")
        .build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+Backslash")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, package.name.clone())
        .about(Some(about))
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_note)
        .item(&new_tab)
        .item(&reopen_tab)
        .separator()
        .item(&search)
        .separator()
        .item(&close_tab)
        .item(&close_window)
        .build()?;

    // The standard Edit items are load-bearing, not decoration: on macOS
    // ⌘X/⌘C/⌘V/⌘Z/⌘A only reach a webview through these predefined items.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .separator()
        .fullscreen()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()?;

    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id.0.as_str();
        if id == CLOSE_WINDOW {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
            return;
        }
        if FRONTEND_COMMANDS.contains(&id) {
            let _ = app.emit(MENU_EVENT, id);
        }
    });

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install(_app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(test)]
mod tests {
    //! The menu's half of the two-sided command contract.
    use super::*;

    /// Every id the menu emits must be dispatched by the frontend registry.
    /// Without this a renamed command is a menu item that silently does
    /// nothing — the failure mode is invisible until someone clicks it.
    #[test]
    fn frontend_commands_match_the_shell() {
        let registry = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/app/registerNotesShellShortcuts.ts"
        ))
        .expect("frontend shortcut registry is readable from the crate");

        for command in FRONTEND_COMMANDS {
            assert!(
                registry.contains(&format!("'{command}'")),
                "menu command '{command}' is not dispatched by registerNotesShellShortcuts.ts"
            );
        }
    }

    #[test]
    fn close_window_is_not_forwarded_to_the_frontend() {
        assert!(!FRONTEND_COMMANDS.contains(&CLOSE_WINDOW));
    }
}
