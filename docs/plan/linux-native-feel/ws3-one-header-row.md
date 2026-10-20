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
   `window_controls_layout` returning `{ left: [...], right: [...] }`, because GNOME permits
   supported controls on both sides of the colon. On anything that is not GNOME
   (`XDG_CURRENT_DESKTOP` lacks `GNOME`), return the right-side default; Plasma
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
to the app name. Preserve the configured`FUTO Notes (Dev)`suffix in debug builds. Check whether`document.title` is already maintained anywhere before adding a second writer.
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
