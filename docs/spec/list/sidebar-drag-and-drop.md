## Sidebar drag & drop _(desktop)_

- Notes and folders can be dragged onto a folder (or the root) in the sidebar
  to move them. Internal drags carry custom MIME types
  (`application/futo-note-id`, `application/futo-folder-path`). →
  FolderTreeView.svelte / DrawerSidebar.svelte
- Both **Windows and macOS** builds set `dragDropEnabled: false`
  (`tauri.windows.conf.json` / `tauri.macos.conf.json`): wry's native
  drag-drop interception (WebView2 on Windows, WKWebView on macOS) otherwise
  swallows the sidebar's internal HTML5 `dragover`/`drop`, making drag & drop
  inert (the dragged row follows the cursor but no folder highlights and the
  drop never lands — macOS repro fixed 2026-07-08). With interception off, OS
  file drops reach the DOM — a window-level guard (`externalFileDropGuard.ts`)
  prevents them from navigating the webview, on every platform. Linux keeps
  `dragDropEnabled` on, deliberately: of wry's three backends only webview2
  (RegisterDragDrop on the HWND) and wkwebview (draggingEntered /
  performDragOperation overrides) install a native layer that eats internal
  drags — webkitgtk only connects GTK signal handlers that return false, never
  calling `drag_dest_set`, so a Linux build has nothing to turn off. Verified
  on the real Linux app with X11 pointer input: note-into-folder fires the full
  dragstart/dragenter/dragover/drop sequence and moves the file, and a tab drag
  reorders the strip. → wry webkitgtk/drag_drop.rs, dragDropConfig.test.ts
- The custom drag-image ghost (a 1×1 canvas to suppress the OS image + a DOM
  mirror that follows the cursor) is **WebKitGTK-only** (`isLinux`). WebKitGTK
  needs it because it rasterizes the OS drag image blurry on hi-DPI; macOS
  WKWebView and Windows WebView2 render native drag images crisply. Critically,
  it must NOT run on WKWebView: mutating the DOM during `dragstart` aborts the
  drag there (dragstart → dragend, zero dragover) — a separate failure from the
  wry interception above; both had to be fixed for macOS drag & drop to work
  (2026-07-08). → FolderTreeView.svelte `setControlledDragImage`
