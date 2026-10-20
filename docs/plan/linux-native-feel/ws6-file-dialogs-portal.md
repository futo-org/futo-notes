## WS6 — File dialogs through the desktop portal

**Today.** `Cargo.lock` shows `rfd` built with `gtk-sys`: the dialog plugin's default `gtk3`
feature. Outside a sandbox that is a GTK3 file chooser everywhere, foreign on Plasma. The plugin
exposes an `xdg-portal` feature (`tauri-plugin-dialog` 2.7.0 `Cargo.toml` features: `gtk3 =
["rfd/gtk3"]`, `xdg-portal = ["rfd/xdg-portal", "rfd/tokio", "rfd/wayland"]`), which asks
`xdg-desktop-portal` and gets the desktop's own chooser: GTK4 on GNOME, the KDE dialog on Plasma.

**Steps.**

1. Inventory every dialog call on desktop: grep `plugin-dialog` and `@tauri-apps/plugin-dialog`
   under `src/lib/platform/tauri/` and `src/features/`. Expect the folder picker behind Settings
   **Change directory**, and possibly `ask`/`message`/`confirm`. Message dialogs matter: rfd's
   portal backend has no portal for message boxes and falls back to spawning `zenity` or
   `kdialog`, which may be absent. Every `ask`/`message` found either moves to an in-app dialog
   in this MR or the workstream stops with that finding.
2. `apps/tauri/src-tauri/Cargo.toml`: change the common entry to `tauri-plugin-dialog = {
version = "2.7", default-features = false }` and add, in the existing
   `[target.'cfg(target_os = "linux")'.dependencies]` table, `tauri-plugin-dialog = { version =
"2.7", default-features = false, features = ["xdg-portal"] }`. Features unify per crate, so
   this drops `gtk3` everywhere and adds the portal only on Linux; macOS and Windows never used
   `gtk3`. Confirm the macOS CI build still compiles rather than assuming.
3. `portal_vault.rs` already handles document-portal paths. Outside a sandbox the portal returns
   real paths, so nothing changes for the vault code; inside a Flatpak nothing changes either,
   because GTK3 was already redirected to the portal there.

**Verify.** On GNOME, Settings → Change directory opens the GTK4 chooser (it looks like Files,
not like the GTK3 dialog). On Plasma, if reachable, the KDE chooser. Cancel and pick both work
and the chosen vault loads. `cargo build` on all three desktop targets via the MR pipeline. Spec:
`docs/spec/settings.md` storage paragraph mentions the dialog is the desktop's own.

---
