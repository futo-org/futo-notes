## Sidebar tabs _(Tauri)_

- The drawer/sidebar has three tabs: **files** (folder tree + notes),
  **tags**, and **images**; the selected tab persists across sessions
  (localStorage `futo-notes:sidebarView`). → DrawerSidebar.svelte
- Clicking the sidebar brand/home affordance returns to the For You home (no
  note open). → DrawerSidebar.svelte
- The tags tab lists every tag (lowercased, case-insensitively deduped) with a
  live note count; tapping a tag expands an alphabetical list of its notes;
  tapping a note opens it. Tags inside inline code / fenced blocks are not
  counted. → SidebarTagView.svelte
  (A `$state`-proxy identity bug here used to throw
  `effect_update_depth_exceeded` on render and brick all UI interactivity —
  fixed 2026-06-09, regression-locked by SidebarTagView.test.ts.)
- The images tab shows the vault's images as a thumbnail grid (live previews),
  newest first. → SidebarImageView.svelte
- That grid covers the whole vault, folders included, and labels each image by
  its vault-relative path (`trip/photo.png`); dot-directories hold app data and
  are skipped. Listing only the top level is why a vault with several pictures
  showed one (reported 2026-09-16). → features/images/imageFiles.ts,
  lib/platform/tauri/storage.ts, lib/platform/tauri/adapter.contract.test.ts
- The grid fills whether or not the images tab is the one the app reopens on:
  it waits for the platform layer instead of reporting an empty vault when it
  mounts first. → features/images/imageFiles.ts,
  features/images/imageFilesStartup.test.ts
- Tapping a thumbnail opens a full-size detail view with a Back control, the
  image's name, size, and relative-time date, and an overflow (⋮) menu hosting
  **Delete**. Deleting does NOT rewrite notes that reference the image.
  → SidebarImageView.svelte
- The sidebar files tree stays responsive on large vaults (target: 10,000
  notes) — scrolling, expanding/collapsing, and drag & drop remain usable.
  The implementation is not required to virtualize rows. → FolderTreeView.svelte
- Scrolling the files tree never shows an empty sidebar: however fast the list is
  flung, every painted frame shows rows. _(Tauri)_ → FolderTreeView.svelte
  > **Gap:** a single isolated frame can still paint the spacer when the scroll
  > jumps further than the virtual window's lead — measured 5 lone frames in
  > ~1,300 native window captures, never two in a row.
  > → docs/perf/tab-switch-baseline.md
- Every folder-tree note, folder, and empty-state row spans the remaining
  sidebar width after its nesting indent, so hover, selection, context-menu,
  and drag/drop hit zones stay full-width at every depth. → folderTree.css
