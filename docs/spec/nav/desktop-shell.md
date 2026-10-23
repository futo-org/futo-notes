## Desktop shell _(desktop)_

- The sidebar is persistent and resizable (drag the divider, clamped
  240–600px so the full **FUTO Notes** brand remains on one line). A
  single collapse/expand toggle lives in the full-width desktop top band (its
  leading `topband-chrome`, which mirrors the sidebar column) and flips icon +
  label by state; it is the only sidebar toggle on desktop. Width and collapsed
  state persist across sessions. → DrawerSidebar.svelte, NotesShell.svelte,
  DesktopTopBand.svelte, TabsStrip.svelte
- On macOS the native traffic lights are overlaid on our chrome
  (`titleBarStyle: Overlay`); the top band's `topband-chrome` reserves a fixed
  leading gutter (`--macos-traffic-lights-width`) for them in one place,
  independent of sidebar state — so collapsing the sidebar never exposes or
  crowds the buttons. → configureWindowChrome.ts, desktop-shell.css
- On macOS the traffic lights sit on the sidebar toggle's center line, with even
  spacing above them and to their left. → tauri.conf.json,
  configureWindowChrome.ts
- With the sidebar collapsed the toggle carries 20px of visible air on each
  side — to the last traffic light and to the first tab. → desktop-shell.css,
  tabsStrip.css
- On Linux the undecorated window uses one header row: minimize, maximize and
  close live in the desktop top band rather than in a second title row. GNOME's
  `org.gnome.desktop.wm.preferences button-layout` decides left/right placement
  and button order, including layouts split across both sides; other desktops use the trailing
  minimize/maximize/close default. → DesktopTopBand.svelte,
  WindowControls.svelte, window_controls.rs
- Left-side Linux controls reserve their own leading gutter through
  `--linux-window-controls-width`, parallel to the macOS traffic-light gutter,
  so the sidebar toggle and tabs never overlap them. → configureWindowChrome.ts,
  desktop-shell.css
- Every empty area of the top band drags the window — the gaps around the tabs
  and the whole chrome column, traffic-light gutter included; only the buttons
  take clicks. → DesktopTopBand.svelte, TabsStrip.svelte,
  WindowControls.svelte
- The native window title is the active note title followed by "— FUTO Notes";
  Home falls back to the app name. The app name follows the selected language,
  and changing the language keeps the active note in the title. Debug builds
  retain the `FUTO Notes (Dev)` identity in both forms, so tab changes cannot
  erase the dev/prod distinction. This is the title shown by the compositor in
  Alt+Tab and overview surfaces. → TabsStrip.svelte, App.svelte,
  windowTitle.ts, tauri.dev.conf.json
- A `just tauri-dev` instance names itself after its git branch, verbatim, so
  parallel dev instances are distinguishable: the window title's dev identity
  becomes `FUTO Notes (Dev) · <branch>`, the branch shows under the sidebar's
  DEV badge, and the macOS Dock and Cmd-Tab entry reads
  `FUTO Notes (Dev) · <branch>`. A detached HEAD keeps the plain dev identity.
  → tauri-dev.mjs, App.svelte, SidebarHeader.svelte, dev_app_name.rs
- Debian and RPM packages install a hidden `futo-notes-tauri.desktop` identity
  alias matching the native Wayland app ID, so compositors resolve the FUTO
  Notes icon in Alt+Tab. The visible `FUTO Notes.desktop` launcher remains in
  place for existing taskbar pins and Markdown associations. →
  linux/futo-notes-tauri.desktop, tauri.conf.json, linux-packaging.test.mjs
- Linux packages advertise the app in the freedesktop Office category, add
  `notes` / `markdown` search keywords, and register `text/markdown` for `.md`
  and `.markdown`, so file managers offer FUTO Notes under **Open With**. Tauri's
  `Productivity` bundle category is the source value that emits `Office` in the
  desktop entry. → tauri.conf.json, linux/futo-notes.desktop.hbs
- The window is not shown until the shell has painted in its theme: it is
  created hidden and revealed on first render once the stored theme preference
  has been applied, so launching never flashes the webview's white, and an
  `auto` launch on a dark Linux desktop never paints light before the portal
  answers. Rust reveals it regardless after a timeout, so a frontend that never
  paints or a read that never answers delays the window rather than losing it.
  → window_reveal.rs, App.svelte, createAppBootstrap.svelte.ts
- Window size, position, maximized and fullscreen state persist across launches,
  validated against the attached monitors so an unplugged display cannot strand
  the window off-screen. → application.rs (tauri-plugin-window-state)
- The window cannot be resized below 720×600: the default sidebar plus a usable
  editor, with room for the 600px Settings dialog and its margins, yet narrow
  enough for two windows side by side on a 1440pt-wide screen. A smaller
  size saved before the minimum existed grows to it on the next launch.
  → tauri*.conf.json (`minWidth`/`minHeight` in every window block),
  window_minimum.rs
- The window's own appearance follows the resolved app theme, so the OS draws the
  window frame, the application menu and native dialogs in the app's light/dark
  rather than the system's. On macOS the visible tell is the stroke AppKit
  composites along the window's top edge: white@55% over our dark top band when
  the window is light (a bright hairline on a dark desktop) against white@20%
  when it is dark. On Windows it is the titlebar. On Linux the window carries no
  native frame at all (decorations are off and the app draws its own header
  controls), so it reaches only GTK-drawn surfaces such as the WebKitGTK context
  menu; file choosers are portal-owned and follow the desktop. → theme.ts
  `windowAppearanceFor`, windowAppearance.ts
- On **auto** the window is handed back to the OS on macOS and Windows and pinned
  to the resolved theme on Linux. Same outcome, opposite mechanism, because the
  platforms disagree about what "no preference" means: on macOS and Windows
  pinning a theme stops the platform reporting later system light/dark switches,
  while GTK has no such value — tao maps both "none" and "light" onto
  `gtk-application-prefer-dark-theme = false`, which WebKitGTK also reads as the
  page's own `prefers-color-scheme`, so handing the window back would make a dark
  Linux desktop render light. → theme.ts `windowAppearanceFor`,
  desktop_settings.rs (`linux-theme-changed`)
- On **auto** the resolved theme comes from the OS's own answer, never from the
  page's `prefers-color-scheme`, which echoes the app's own last pin: on a dark
  Linux desktop choosing **Light** and then **Auto** renders dark, and on a light
  macOS desktop choosing **Dark** and then **Auto** renders light, both
  immediately rather than only after a relaunch. Linux reads the xdg desktop
  portal's `org.freedesktop.appearance` / `color-scheme`; macOS and Windows hand
  the window back to the OS and read the theme it then wears, because on macOS
  tao reports no ThemeChanged for the app's own unpin. The reported change and
  then the media query are fallbacks only where nothing answers. → theme.ts
  `resolveAutoTheme`, windowAppearance.ts `releaseNativeWindowAppearance`,
  platform_integration.rs `read_desktop_color_scheme`
- One desktop light/dark change can arrive alongside unrelated portal signals
  on the same `SettingChanged` stream, and only an exact
  `org.freedesktop.appearance` / `color-scheme` namespace+key match re-resolves
  the theme — settings that merely look like a theme change, such as KDE's
  `ColorScheme` scheme _name_ signal (a different key entirely), are ignored.
  Overlapping theme applies are serialized so the newest request wins, never
  whichever resolved last. → desktop_settings.rs (`read_snapshot`, filtered by
  exact namespace/key rather than string matching), theme.ts
  `applyThemePreference`
  <!-- NOTE (rebase judgment call, flagged for review): this paragraph
  originally documented platform_integration.rs's `desktop_theme_from_setting_changed`,
  a gdbus-output string parser main hardened independently. !277 replaces that
  whole mechanism with desktop_settings.rs's typed zbus reads, which the rebase
  resolution kept (see .rebase-log.md); the burst-signal guarantee still holds,
  just via a different, more robust implementation, so the reference was
  updated rather than left dangling. The desktop accent-following feature
  (which desktop_settings.rs's watcher also carried) was itself reverted by
  !277's own last commit (d916ee15) after review, so the snapshot now only
  ever carries theme. -->
- Linux reads the portal's current color scheme before relying on later change
  signals, so switching Light/Dark back to Auto immediately resolves from the
  desktop rather than from WebKitGTK's app-pinned media query. Older portals
  fall back from `ReadOne` to `Read`. → desktop_settings.rs, theme.ts
- Opening an `.md` already inside the active vault opens that safe note id in a
  tab. Opening an outside `.md` or `.markdown` asks whether to copy it into the
  vault; **Cancel** leaves it untouched, while **Copy into notes** uses the atomic Rust store
  workflow, preserves the filename as the title, collision-suffixes rather than
  overwriting, and opens the final id. Cold-launch arguments and later
  single-instance launches share this policy. → external_file_open.rs,
  externalFileOpen.ts, `LocalNoteStore::import_markdown`

### Application menu _(macOS)_

- macOS gets a real menu bar owned by the app: **App** (About, Settings… ⌘,
  Services, Hide, Quit) · **File** (New Note ⌘N, New Tab ⌘T, Reopen Closed Tab
  ⇧⌘T, Search Notes… ⌘P, Close Tab ⌘W, Close Window ⇧⌘W) · **Edit** (undo, redo,
  cut, copy, paste, select all) · **View** (Toggle Sidebar ⌘\, Full Screen) ·
  **Window**. → app_menu.rs
- ⌘W closes the **tab**; ⇧⌘W closes the window. macOS resolves a menu item's key
  equivalent before the webview sees it, so the menu — not the keydown handler —
  is what makes ⌘W reach the tab strip at all. → app_menu.rs, tabs.md
- A menu command and its keyboard accelerator run the same shell command; the
  menu's command ids are locked against the shell's dispatch table by a test. →
  registerNotesShellShortcuts.ts, app_menu.rs
- Windows and Linux render no menu bar; their accelerators stay with the
  keydown handler. → app_menu.rs

### Desktop chrome behaves like an application, not a document _(desktop)_

- Chrome shows the arrow cursor — rows, tabs, buttons and toolbar icons never
  switch to the pointing hand, and pressing or dragging a row never shows the
  grabbing hand. Text fields keep the I-beam, the sidebar divider keeps the
  resize cursor, outbound links keep the pointer, and the editor keeps every
  document cursor it had. → desktop-native.css
- Right-clicking chrome opens nothing. Right-clicking inside the editor, inside
  a text field, or on a live selection still opens the native menu — Cut/Copy/
  Paste, Look Up, Share and spellcheck suggestions. The app's own note and
  folder context menus are unaffected. → installDesktopContextMenuGuard.ts
- _(macOS)_ Opening a context menu never also activates what is under it: a
  control-click, which WebKit reports as a `click` (and a second one as a
  `dblclick`) alongside the `contextmenu`, leaves the note unopened, the
  folder's expansion unchanged, and no inline rename open. Off macOS the
  secondary button produces no `click` at all and Ctrl+click stays the
  open-in-background-tab modifier. → installDesktopContextMenuGuard.ts
- Settings opens with ⌘, and the sidebar toggles with ⌘\ (Ctrl elsewhere). →
  registerNotesShellShortcuts.ts
- Quitting flushes a pending note save first, on every platform. Ctrl+Q on
  Linux and Windows and ⌘Q / App ▸ Quit on macOS close the app window through
  the normal close path; the macOS Quit item is a custom item that closes the
  window rather than AppKit's `terminate:`, which tao 0.34 answers without a
  `CloseRequested` and so skipped the flush (RC-85: ⌘Q within 0.5 s of typing
  lost the edit, 19 of 20 runs). A Dock Quit, an AppleScript `quit` and a
  logout reach the process as that same `terminate:`, so an
  `applicationShouldTerminate:` added to tao's delegate answers
  `NSTerminateLater`, closes the window, and replies once the flush has exited
  the app (`RunEvent::ExitRequested`), so a logout or shutdown waits for the
  flush and proceeds instead of being canceled. The updater's install and every relaunch (vault change,
  Update & restart) drain the save first too (RC-87). → app_menu.rs,
  macos_terminate.rs, registerNotesShellShortcuts.ts, startNativeShell.ts,
  flushBeforeExit.ts, tests/macos-quit-flush.mjs
- The system "Reduce Motion" setting removes the shell's transitions and
  animations. → desktop-native.css
