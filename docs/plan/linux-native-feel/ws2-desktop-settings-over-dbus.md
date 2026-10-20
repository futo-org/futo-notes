## WS2 — Read desktop settings over D-Bus

**Today.** `platform_integration.rs` `watch_linux_theme` spawns `gdbus monitor` and greps its
stdout for `color-scheme` and `uint32 1`. That binary is not in the AppImage and not on every
distro, and the watcher only reports changes, never the current value. `zbus = "5"` is already a
Linux dependency of the crate.

**Goal.** One small Rust module that reads and watches `org.freedesktop.portal.Settings` for
`color-scheme`, and emits the current value at startup and every change afterward.

**Accent color: dropped in review.** An earlier revision also read
`org.freedesktop.appearance accent-color` and recoloured `--color-primary` from it, on by
default. Review rejected it: no other platform follows the desktop accent, and recolouring the
primary token repaints the brand mark. `--color-primary` stays brand orange everywhere; the
steps below keep only the `color-scheme` half.

**Steps.**

1. New file `apps/tauri/src-tauri/src/desktop_settings.rs` (Linux only via `#[cfg]`). Use the
   zbus blocking API inside the existing `background_tasks::spawn` thread, matching how
   `watch_linux_theme` is spawned today. Talk to `org.freedesktop.portal.Desktop` at
   `/org/freedesktop/portal/desktop`, interface `org.freedesktop.portal.Settings`:
   - `ReadOne("org.freedesktop.appearance", "color-scheme")` → `u32`: 1 dark, 0 or 2 light.
     Older portals lack `ReadOne`; fall back to `Read`, which wraps the value in an extra
     variant.
   - Subscribe to the `SettingChanged(namespace, key, value)` signal and re-emit on that key.
2. Parsing from `zbus::zvariant::Value` into a small enum (`ColorScheme::{Light, Dark}`) lives in
   pure functions with unit tests. Include the `Read`-wrapped shape.
3. Emit `linux-theme-changed` exactly as today (payload `"dark"` or `"light"`) so
   `src/features/system/theme.ts` `watchSystemThemeTauri` keeps working unchanged. Emit it once
   at startup with the current value; today the app only learns the desktop theme when it
   changes, and `docs/spec/settings.md:5-9` says the webview cannot observe it on its own.
   Verify whether a fresh launch on a dark desktop with Auto currently renders light for a
   moment or for good; the answer decides whether this is a bug fix or a tidy-up, and belongs in
   the commit.
4. ~~Follow the desktop accent color~~ (dropped in review — see above).
5. Delete `watch_linux_theme` and the `gdbus` dependency.

**Verify.** `gsettings set org.gnome.desktop.interface color-scheme prefer-dark` flips the app
live, both directions, and a fresh launch picks up the current value — also from the AppImage,
since that build has no `gdbus`. Rust unit tests for the parser. Spec: `docs/spec/settings.md`
Theme paragraph loses the "cannot observe" caveat if step 3 fixes startup, and records that the
app never follows the desktop accent.

---
