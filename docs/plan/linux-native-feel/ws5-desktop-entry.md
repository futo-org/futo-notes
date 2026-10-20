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
