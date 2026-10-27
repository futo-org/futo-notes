## Sidebar drag & drop _(desktop)_

- Notes and folders can be dragged onto a folder (or the root) in the sidebar
  to move them. Internal drags carry custom MIME types
  (`application/futo-note-id`, `application/futo-folder-path`). →
  FolderTreeView.svelte / DrawerSidebar.svelte
- Every desktop build sets `dragDropEnabled: false` (`tauri.conf.json`):
  wry's native drag-drop interception (WebView2 on Windows, WKWebView on
  macOS) otherwise swallows the sidebar's internal HTML5 `dragover`/`drop`,
  making drag & drop inert (the dragged row follows the cursor but no folder
  highlights and the drop never lands — macOS repro fixed 2026-07-08), and on
  a native-Wayland compositor wry's WebKitGTK relay never delivers an external
  file drop at all (QA #017). With interception off, OS file drops reach the
  DOM — a window-level guard (`externalFileDropGuard.ts`) prevents them from
  navigating the webview, on every platform. → dragDropConfig.test.ts
- The custom drag-image ghost (a 1×1 canvas to suppress the OS image + a DOM
  mirror that follows the cursor) is **WebKitGTK-only** (`isLinux`). WebKitGTK
  needs it because it rasterizes the OS drag image blurry on hi-DPI; macOS
  WKWebView and Windows WebView2 render native drag images crisply. Critically,
  it must NOT run on WKWebView: mutating the DOM during `dragstart` aborts the
  drag there (dragstart → dragend, zero dragover) — a separate failure from the
  wry interception above; both had to be fixed for macOS drag & drop to work
  (2026-07-08). → FolderTreeView.svelte `setControlledDragImage`
