# Linux native feel — plan

Status: implemented and locally verified 2026-09-02. Branch `linux-native-feel`, worktree
`~/Developer/futo-notes-linux-native-feel`, based on `main` at f063c98e. The RPM was verified on
Fedora KDE and in a Fedora 43 GNOME Wayland VM; non-Linux desktop checks remain CI/manual follow-up
coverage.

Seven workstreams that make the Tauri desktop app read as a Linux application instead of a web
page in a frame. All of them stay inside the current architecture: Svelte in a WebKitGTK webview
under Tauri. Nothing here depends on the editor swap, the egui spike
(`docs/plan/egui-desktop-spike.md` on `poc/egui-desktop-shell`, killed on its embedding probe), or
a Flatpak manifest, which is deliberately out of scope.

The steps below are a starting shape, not a script. Where a step says "decide", the implementer
picks, records the choice in the commit body, and moves on. Where a step says "measure" or
"verify", the result goes in the commit body too. A workstream that turns out to be wrong on a
real desktop is dropped or reshaped, not forced.

## Ground rules (from AGENTS.md, restated because every workstream touches them)

- Read `apps/tauri/AGENTS.md` before Rust changes and `src/AGENTS.md` before Svelte changes.
  Each names the verification chain for its layer (§7.1, §7.4).
- Never weaken the dev/prod data split (M3). None of this touches vault paths; keep it that way.
- Fix every sibling occurrence (M17). Several workstreams have a copy in `scripts/tauri-dev.mjs`
  or a second CSS file. The steps name the ones found; grep for more.
- Update `docs/spec/` in the same MR as the behavior (M19). The three files touched are
  `docs/spec/nav.md` (§Desktop shell), `docs/spec/app.md` (§Display backend), and
  `docs/spec/settings.md` (Theme). Run `just check` before pushing; it includes the spec checks.
- Commit as `type(scope): imperative summary` with a `Verified:` line.
- Iterate with `just tauri-dev` (dev bundle id, fake vault, port 5180). Test the installed
  experience with `just deploy-rpm`, which is the only way to see the real `.desktop` file, icon,
  and launcher behavior. Neither one touches `~/Documents/futo-notes`.

## Suggested order

| #   | Workstream                                       | Why this position                                                                  |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | GPU renderer gating                              | Smallest change, and every later feel judgment should be made with the GPU path on |
| 2   | Portal plumbing over zbus, plus accent color     | Provides the desktop-settings reader that 3 and 4 also want                        |
| 3   | One header row: window controls in the top band  | Largest visible change                                                             |
| 4   | System font for the interface                    | Depends on 2 if `system-ui` turns out not to follow the GTK font                   |
| 5   | Desktop entry, markdown association, open-a-file | Independent, but the launcher test wants 3 landed so screenshots are final         |
| 6   | File dialogs through the portal                  | Independent, one Cargo change plus verification                                    |
| 7   | Ctrl+Q                                           | Trivial, do it whenever                                                            |

One MR per workstream, branched from `main`, merged into `main`. `linux-native-feel` is the
integration branch for anyone who wants to see them together. Workstreams 1, 6 and 7 are each
small enough to land the same day they are started.

---

## WS1 — Stop disabling the GPU renderer on every Linux machine

**Today.** `apps/tauri/src-tauri/src/main.rs:8` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`
unconditionally on Linux, with the comment "blank windows / crashes on many Wayland + NVIDIA
configurations". `scripts/tauri-dev.mjs:31` sets the same variable for dev. WebKitGTK then
composites without its DMA-BUF path on Intel and AMD too, which costs scroll smoothness and CPU
on the machines that never had the problem.

**Goal.** The workaround applies only where the failure was observed, the user can force it
either way, and the dev recipe matches release behavior.

**Steps.**

1. Measure first, so the change has a number attached. On this machine (Fedora 44, WebKitGTK
   2.52), run the dev app twice, once with the variable and once with it removed from
   `scripts/tauri-dev.mjs`. Open a long note and scroll for ten seconds each. Two cheap
   instruments: `perf stat -p <pid>` or `top` for CPU of the `WebKitWebProcess`, and a
   requestAnimationFrame frame-time sampler injected through the MCP bridge
   (`webview_execute_js`) that logs p95 frame interval. Record both numbers in the commit body.
   If they are the same, stop here and record that too; the rest of WS1 is then not worth a
   risk on NVIDIA.
2. In `main.rs`, replace the unconditional set with a decision:
   - If `WEBKIT_DISABLE_DMABUF_RENDERER` is already in the environment, leave it alone. The user
     or a distro wrapper has spoken.
   - Else, set it only when an NVIDIA GPU is present. Detect by reading
     `/sys/class/drm/card*/device/vendor` for `0x10de`, or `/proc/modules` for a line starting
     with `nvidia`. Prefer the sysfs read; it works without the module loaded. Put the detector
     in `platform_integration.rs` as a pure function over a string so it has a unit test, with
     the env logic in `main.rs` calling it.
   - Offer an explicit override, `FUTO_NOTES_SOFTWARE_RENDER=1`, that forces the old behavior.
     Document it in `docs/spec/app.md` §Display backend next to the Wayland line.
3. Remove the variable from `scripts/tauri-dev.mjs` so dev exercises the same decision as
   release. That is the M17 sibling.
4. Optional, decide after step 1: WebKitGTK versions from 2.44 onward reportedly fixed most of
   the NVIDIA blank-window cases. If the AppImage's bundled WebKitGTK and the deb/rpm floor are
   both at or above a version you can confirm, the NVIDIA branch can be dropped entirely. Do
   not do this from memory; find the upstream bug and cite it in the commit.

**Verify.** Step 1 numbers. `cargo test -p futo-notes-tauri` for the detector. If an NVIDIA
machine is reachable, launch the installed rpm on it once. Spec: `docs/spec/app.md` §Display
backend gains one line for the rule and one for the override.

**Risk.** A detection miss on NVIDIA gives a blank window with no in-app way out. The env
override is the recovery path, so it must be documented where a user with a blank window can
find it (the README's Linux section, not only the spec).

---

## WS2 — Read desktop settings over D-Bus, and follow the accent color

**Today.** `platform_integration.rs` `watch_linux_theme` spawns `gdbus monitor` and greps its
stdout for `color-scheme` and `uint32 1`. That binary is not in the AppImage and not on every
distro, and the watcher only reports changes, never the current value. `zbus = "5"` is already a
Linux dependency of the crate. Accent color is not read at all; `--color-primary` in
`src/styles/theme.css:3` and `:33` is fixed orange.

**Goal.** One small Rust module that reads and watches `org.freedesktop.portal.Settings`, emits
the current value at startup and every change afterward, and covers both `color-scheme` and
`accent-color`. The frontend can follow the desktop accent when the user wants it.

**Steps.**

1. New file `apps/tauri/src-tauri/src/desktop_settings.rs` (Linux only via `#[cfg]`). Use the
   zbus blocking API inside the existing `background_tasks::spawn` thread, matching how
   `watch_linux_theme` is spawned today. Talk to `org.freedesktop.portal.Desktop` at
   `/org/freedesktop/portal/desktop`, interface `org.freedesktop.portal.Settings`:
   - `ReadOne("org.freedesktop.appearance", "color-scheme")` → `u32`: 1 dark, 0 or 2 light.
   - `ReadOne("org.freedesktop.appearance", "accent-color")` → `(ddd)` in 0..1, or values out of
     range meaning "no preference". Older portals lack `ReadOne`; fall back to `Read`, which
     wraps the value in an extra variant. Older portals also lack `accent-color`; treat a
     missing key as "no preference", not an error.
   - Subscribe to the `SettingChanged(namespace, key, value)` signal and re-emit on those two
     keys.
2. Parsing from `zbus::zvariant::Value` into a small enum (`ColorScheme::{Light, Dark}`,
   `Accent::{None, Rgb(f64,f64,f64)}`) lives in pure functions with unit tests. Include the
   `Read`-wrapped shape and the out-of-range accent case.
3. Emit `linux-theme-changed` exactly as today (payload `"dark"` or `"light"`) so
   `src/features/system/theme.ts` `watchSystemThemeTauri` keeps working unchanged. Emit it once
   at startup with the current value; today the app only learns the desktop theme when it
   changes, and `docs/spec/settings.md:5-9` says the webview cannot observe it on its own.
   Verify whether a fresh launch on a dark desktop with Auto currently renders light for a
   moment or for good; the answer decides whether this is a bug fix or a tidy-up, and belongs in
   the commit.
4. Add `linux-accent-changed` with payload `{ r, g, b }` or `null`.
5. Frontend, `src/features/system/`: a new small module (`accent.ts`) that maps the payload to
   `--color-primary` on the root element and derives the hover and dark-mode variants with
   `color-mix()` rather than shipping a palette. Grep `src/styles` and `src/features` for the
   literal `#f26b1f` and `#ff7a33` first; every copy either moves onto the token or is listed in
   the commit as deliberately left alone (M17).
6. Decide the default. Native GNOME and Plasma apps follow the accent without asking. The brand
   orange is a product choice. Recommendation: Appearance settings gain a **Follow system accent
   color** toggle, default on for Linux desktop, persisted next to the theme preference in
   `createAppBootstrap.svelte.ts`. When the portal reports no preference the brand color stays.
7. Delete `watch_linux_theme` and the `gdbus` dependency.

**Verify.** `gsettings set org.gnome.desktop.interface color-scheme prefer-dark` flips the app
live, both directions, and a fresh launch picks up the current value. `gsettings set
org.gnome.desktop.interface accent-color teal` (GNOME 47+) recolors buttons and links live. Both
also from the AppImage, since that build has no `gdbus`. Rust unit tests for the parsers; a
vitest for the accent → CSS mapping. Spec: `docs/spec/settings.md` Theme paragraph loses the
"cannot observe" caveat if step 3 fixes startup, and gains the accent toggle line.

---

## WS3 — One header row: window controls in the top band

**Today.** `platform_integration::configure_app` calls `set_decorations(false)` on Linux, and
`src/App.svelte:50` renders `TitleBar.svelte`, a 36px bar holding the static text "FUTO Notes"
and three buttons, above `DesktopTopBand.svelte`, which holds the sidebar toggle and the tabs.
Commit 578bab81 (2026-03-17) introduced this to "render its own Breeze-style titlebar
consistently across DEs". It ignores the user's button placement and decoration theme, and it
gives Linux two rows of chrome where macOS gets one.

**Goal.** A single header row, the top band, that carries the window controls where the
desktop puts them, drags the window from every empty pixel, and reads like a libadwaita header
bar on GNOME and like an ordinary client-decorated window elsewhere.

**Steps.**

1. Spend ten minutes on the alternative before building anything. Comment out
   `set_decorations(false)`, run `just tauri-dev`, and look at the result on GNOME and, if a
   Plasma session or VM is at hand, on KDE. GTK3 will draw a client-side title bar on GNOME and
   the compositor draws server-side decorations on KDE and wlroots. If the doubled chrome and
   the plain GTK3 bar are acceptable to Justin, the rest of WS3 collapses to that one-line
   change plus removing `TitleBar.svelte`. Expected outcome: it is not acceptable on GNOME, and
   the plan continues.
2. Keep decorations off. Move the three controls into `DesktopTopBand.svelte` as a
   `WindowControls` cluster (new component next to the band, reuse the SVGs from
   `TitleBar.svelte`). Default placement is trailing, after the tab strip.
3. Honor the desktop's placement. On GNOME the source is
   `org.gnome.desktop.wm.preferences button-layout`, a string like `appmenu:minimize,maximize,close`
   or `close,minimize,maximize:appmenu`; the colon separates left from right. Read it in Rust
   (`gsettings get`, or the `gio` crate's `Settings` if the schema is installed; a subprocess with
   a parsed result and a default on any failure is fine here) and expose it as a Tauri command
   `window_controls_layout` returning `{ side: 'left' | 'right', buttons: [...] }`. On anything
   that is not GNOME (`XDG_CURRENT_DESKTOP` lacks `GNOME`), return the right-side default; Plasma
   keeps its layout in `kwinrc` and reading it is not worth the code. Parsing is a pure function
   with tests for both orders, an empty string, and a missing `close`.
4. When the controls are on the left they sit in `topband-chrome` before the sidebar toggle,
   which is exactly the slot macOS reserves for its traffic lights through
   `--macos-traffic-lights-width` in `desktop-shell.css:41-62`. Reuse that reservation mechanism
   with a Linux variable rather than a second layout path; `configureWindowChrome.ts` already
   branches on `isTauri && isLinux` and is where the new variable is set.
5. Drag and double-click. `data-tauri-drag-region` is already on the band and the chrome column
   (`DesktopTopBand.svelte:17-18`); Tauri handles double-click-to-maximize on drag regions. Keep
   the buttons outside the drag region. Check the tab strip's own drag handling still wins over
   window drag when the pointer starts on a tab.
6. Remove `TitleBar.svelte`, its render in `App.svelte`, `--titlebar-height` from
   `configureWindowChrome.ts` and its consumer at `app-shell.css:7`, and the `showLinuxTitlebar`
   field. Delete `TitleBar` mentions from `docs/spec/nav.md`.
7. The window title. The old bar showed the constant "FUTO Notes". The compositor's overview and
   Alt+Tab show the window title, so set it from the active note: `getCurrentWindow().setTitle(
\`${noteTitle} — FUTO Notes\`)`from the tabs feature when the active tab changes, falling back
to the app name. Check whether`document.title` is already maintained anywhere before adding
   a second writer.
8. Styling. Adwaita header-bar buttons are 24px circles with a faint background on hover and no
   red close button; Breeze differs. Pick the Adwaita look since GNOME is where the doubled chrome
   hurt most, keep it in the existing tokens (`--color-muted`, `color-mix` on `--color-text`),
   and do not try to theme-match per desktop.

**Verify.** On GNOME: `gsettings set org.gnome.desktop.wm.preferences button-layout
'close,minimize,maximize:'` moves the controls left on the next launch (live update is a nice
extra, not required). Drag from the band, double-click maximizes, controls work, sidebar collapse
keeps its 20px air rule from `nav.md`. Existing `DesktopTopBand.test.ts` and `TabsStrip.test.ts`
extended for the controls slot; `configureWindowChrome` gets a test for the Linux variable.
Rust tests for the layout parser. Spec: rewrite the three Linux lines in `docs/spec/nav.md`
§Desktop shell (title bar, drag, window appearance mention of "the app draws its own title bar").

---

## WS4 — System font for the interface

**Outcome (2026-09-02).** Dropped after review of the installed build. The interface and editor
both retain the original Barlow styling, there is no font preference, and previously persisted
`interfaceFont` values are ignored and removed on the next preference save.

**Today.** `src/styles/theme.css:28` sets `--font-sans: 'Barlow', system-ui, ...` for the whole
UI, and `src/features/editor/createMarkdownEditorRuntime.ts:99` hardcodes `'Barlow', system-ui,
sans-serif` for the editor content separately. GNOME renders in Cantarell and Plasma in Noto
Sans; Barlow marks the window as foreign.

**Goal.** Interface chrome (sidebar, tabs, menus, settings, dialogs) uses the desktop's UI font
on Linux desktop. The editor keeps Barlow by default. Both are overridable from Appearance
settings.

**Steps.**

1. Find out what `system-ui` resolves to in this WebKitGTK. In the dev app, set
   `--font-sans: system-ui` on the root through devtools and change the GNOME font
   (`gsettings set org.gnome.desktop.interface font-name 'Noto Sans 11'`). If the UI follows,
   `system-ui` reads the GTK setting and step 3 is CSS only. If it does not, add
   `org.gnome.desktop.interface font-name` (and `XDG_CURRENT_DESKTOP`-appropriate fallbacks) to
   the WS2 settings reader and emit it as `--font-system` on the root. Record which path was
   taken.
2. Scope: `html.desktop-chrome` is the existing desktop-only hook (`desktop-native.css`). Add a
   Linux marker class in `configureWindowChrome.ts` (`linux-desktop`) so the mobile embed and
   the browser harness are untouched, and override `--font-sans` under it.
3. Keep the editor on Barlow. The runtime's inline font is the second copy of the family list;
   turn it into a read of a `--font-editor` token so there is one place to change. Reading
   fonts is a product decision, so do not switch the editor by default; note the option in the
   commit.
4. Appearance settings (`AppearanceSettingsSection.svelte`) gain **Interface font: System /
   Barlow** with System the default on Linux desktop and Barlow elsewhere, persisted like the
   theme preference. An **Editor font** control is optional; add it only if step 3 leaves the
   plumbing at a point where it is a few lines.
5. Stretch, only if cheap after step 1: GNOME's Large Text (`text-scaling-factor`). Check whether
   WebKitGTK already scales CSS pixels with it. If not, apply it to the root font size on Linux
   desktop from the same settings reader.

**Verify.** Screenshot sidebar and settings before and after on GNOME; font change through
gsettings propagates without restart if step 1 took the CSS path. Vitest on the settings
persistence. `pnpm run check:svelte` and the rest of `src/AGENTS.md`'s chain. Spec:
`docs/spec/settings.md` Appearance gains the font line(s) with a `(desktop)` tag;
`docs/spec/editor-visual.md` notes the editor stays on Barlow unless changed.

---

## WS5 — Desktop entry, markdown association, open a file

**Today.** The installed `/usr/share/applications/FUTO Notes.desktop` on this machine is
`Categories=` (empty), `Exec=futo-notes-tauri`, `StartupWMClass=futo-notes-tauri`,
`Icon=futo-notes-tauri`, `Name=FUTO Notes`, `Terminal=false`, `Type=Application`. No `Comment`,
no `Keywords`, no `MimeType`. `apps/tauri/src-tauri/tauri.conf.json` has no `category`, no
descriptions, and no `fileAssociations`. Nothing in `application.rs` or the single-instance
callback reads command-line arguments, so a file passed by the file manager is ignored.

**Goal.** The app files correctly in every launcher, can be searched by what it does, appears in
"Open with" for markdown files, and opens the file it is handed.

**Steps.**

1. `tauri.conf.json` `bundle`: add `"category": "Office"`, `"shortDescription"` and
   `"longDescription"` (the bundler writes `Comment` from the short one), and
   `"fileAssociations": [{ "ext": ["md", "markdown"], "mimeType": "text/markdown", "name":
"Markdown", "description": "Markdown document", "role": "Editor" }]`. On Linux the bundler
   emits `MimeType=text/markdown;` into the desktop entry; on macOS it writes the Info.plist
   document types, which is a welcome side effect but check it does not change macOS behavior
   the spec does not describe.
2. `Keywords=notes;markdown;` and `StartupNotify=true` are not produced by the stock template.
   If wanted, set `bundle.linux.deb.desktopTemplate` (and the rpm equivalent) to a copy of the
   bundler's Handlebars template with the two lines added; the template lives in the bundler
   crate under `src/bundle/linux/templates/main.desktop`. Keep the copy minimal and comment where
   it came from.
3. Arguments. Two entry points hand the app a path: `std::env::args().skip(1)` on a cold launch,
   and the `_arguments` parameter of the `tauri_plugin_single_instance::init` callback in
   `platform_integration.rs:21` when a window already exists. Route both through one function,
   `open_external_path(app, path)`, that emits an `open-note-request` event to the frontend once
   the window exists (buffer the cold-launch one until the frontend signals ready; the reveal
   call in `window_reveal` is a reasonable hook).
4. Policy for the path. The app is vault-scoped. Decide between:
   - Inside the vault: open it in a tab. This is the required half.
   - Outside the vault: do not silently move or copy. A small in-app dialog offering **Copy into
     notes** or **Cancel** is the recommended first iteration; opening it in place is not
     available in this model. Whatever is chosen, the path goes through Rust
     `safe_note_path`, never a hand-built join, and the copy is a Rust store call so the note
     cache learns about it the normal way.
     Check `git log feat/open-note-disposition-desktop` (worktree
     `~/Developer/futo-notes-open-note-desktop`) before designing the frontend half; that branch
     works on how an externally opened note is presented and may already own the event name.
5. Wayland grouping. GNOME matches the window's `app_id` against the desktop file name and
   falls back to `StartupWMClass`. After `just deploy-rpm`, open the app and confirm the dock
   and Alt+Tab show the FUTO icon, not a generic one. If they do not, the fix is renaming the
   desktop file to match the `app_id` (`futo-notes-tauri.desktop`) through the bundler's
   `productName`/`mainBinaryName` settings, and that becomes its own commit because it changes
   the installed filename the rpm/deb repos already ship.

**Verify.** `desktop-file-validate "/usr/share/applications/FUTO Notes.desktop"` clean after
`just deploy-rpm`. Right-click a `.md` in Nautilus or Dolphin shows FUTO Notes under "Open
with". `xdg-open ~/Documents/fake-notes/x.md` while the dev app is running opens the note in a
tab (dev build uses the dev vault; test against that, never the release vault). Rust unit test
for the argument parsing. Spec: `docs/spec/nav.md` or `docs/spec/app.md` gains a `(desktop)`
line for the file-open behavior including the outside-the-vault policy.

---

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

## WS7 — Ctrl+Q quits

**Today.** `src/app/registerNotesShellShortcuts.ts:88-118` maps Ctrl (Cmd on macOS) plus
`p n , \ t w 1-9`, and Ctrl+Tab / Ctrl+PageUp / Ctrl+PageDown. No quit binding. macOS gets ⌘Q
from the application menu in `app_menu.rs`; GNOME's guidelines expect Ctrl+Q.

**Steps.**

1. Add a `quit-app` command to the registry, bound to the primary modifier plus `q` when not on
   macOS (macOS already has it natively and a second handler would double-fire). Windows gets it
   too; it is harmless there.
2. The handler must take the same path a window-close takes so pending saves flush. Find how
   close is handled today (there is no `on_window_event` in `application.rs`, so it is Tauri's
   default) and call `getCurrentWindow().close()` rather than `process.exit`, unless closing the
   last window turns out not to end the process on Linux, in which case use the process plugin
   after the close resolves.
3. `app_menu.rs` has a test that every menu id is dispatched by the frontend; a frontend-only
   command does not affect it, but run `cargo test -p futo-notes-tauri` anyway.

**Verify.** Ctrl+Q with a dirty note: the note is on disk afterward (check the dev vault file
mtime and content). Vitest alongside the existing shortcut tests. Spec: the shortcut table in
`docs/spec/nav.md` gains the line with a `(desktop, not macOS)` tag.

---

## Cross-cutting verification before each MR

- `just check` (lint, svelte-check, format, unit tests, Rust conformance, spec checks).
- `cargo test -p futo-notes-tauri` for anything under `apps/tauri`.
- `just tauri-dev` walk-through of the changed surface on GNOME, screenshots in the MR.
- `just deploy-rpm` for WS3 and WS5, since only the installed build shows the desktop entry
  and compositor grouping. Uninstall or reinstall the previous release afterward if this machine
  is also a daily-use machine; `just deploy-rpm` replaces `/usr/bin/futo-notes-tauri`.
- A Plasma check is wanted for WS3, WS4 and WS6. A Fedora KDE VM is enough; the display-backend
  learning in `docs/learnings/appimage-forced-x11.md` describes how to prove which backend the
  window is on if something looks wrong.

## Recorded implementation decisions

1. Follow the system accent by default on Linux, with a persisted opt-out.
2. Keep both the interface and editor on Barlow, with no font changer.
3. Prompt to copy an outside-vault markdown file into notes or cancel; never edit it in place or
   copy it silently.
4. Installed KDE testing showed a generic Alt+Tab icon because `FUTO Notes.desktop` did not match
   the `futo-notes-tauri` Wayland app ID. Keep that visible launcher for existing pins and add a
   hidden `futo-notes-tauri.desktop` identity alias to Debian and RPM packages.
