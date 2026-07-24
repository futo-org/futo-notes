# Gap Inventory — GENERATED, do not edit

One line per inline `> **Gap:**` note in docs/spec/*.md (the source of
truth). Regenerate with `just spec-gaps`; `just spec-gaps-check` (part of
`just check`) fails when this file is stale and runs closure probes that
flag gaps the codebase suggests have been implemented.

## app.md

- [app.md:120](app.md#L120) — Android pre-11 (API < 30) devices can't use Device storage (All-files access is an API-30 mechanism) — they only get App storage, so their vault is not visible in a file manager. _(Android)_
- [app.md:124](app.md#L124) — The vault folder is fixed per mode and not a user-pickable arbitrary directory on mobile (desktop allows a custom folder); iOS has no iCloud Drive vault option. Both are possible follow-ups. _(iOS / Android)_

## editor.md

- [editor.md:197](editor.md#L197) — the **native** shells (iOS/Android) no-op a broken wikilink tap — the editor embed posts `openNote` only for a _resolved_ link, so a broken tap neither opens nor (on first edit) creates the target note the way desktop does. _(native shells)_ → editor-embed/main.ts
- [editor.md:279](editor.md#L279) — iOS native still lacks an explicit `WKWebView` navigation-policy guard (the `openUrl` bridge covers taps on decorated links, but a programmatic top-level navigation inside the WebView is not yet policed).
- [editor.md:478](editor.md#L478) — Clipboard image paste is verified on Linux (WebKitGTK), Windows (WebView2), native Android (emulator, 2026-06-22), and **macOS desktop** (Tauri/WKWebView — real clipboard image + real Cmd+V through the `looksLikeImagePaste` → `fs_paste_clipboard_image` fallback, verified in the 2026-07-02 full-spec QA pass). The iOS path is wired both ways: the embed posts `saveImageData` when WKWebView exposes the pasted image File, and falls back to the payload-less `pasteClipboardImage` (bridge contract v5) when WKWebView hides the bitmap — EditorWebView.swift's `clipboardImageData()` then reads it off `UIPasteboard.general` (raw png/jpeg, else UIImage→PNG) and saves through `VaultImages.save`, the SAME vault path as the picker. Compiles clean (`just build-ios-native`). What remains is on-device end-to-end QA on **native iOS only**: copy a screenshot / "Copy Image", paste into the editor, confirm a vault blob + `![](image-…)` insert. (bridge added 2026-06-26)
- [editor.md:635](editor.md#L635) — on some old Android System WebViews (the Chromium 80–98 tier that runs the editor but predates `@layer`), users report the shift key re-arming after each character, the caret jumping to the start of the line after the first character, and content scrolling out of view while typing (github#8). These are CM6-on-old-engine input limitations. They did **not** reproduce on the Chromium-83 emulator even with FUTO Keyboard as the IME (per-keystroke, fast-burst, and glide typing all behaved), so the cause is likely physical-device IME timing or a specific WebView build. Unaddressed — the legacy-WebView work fixes the black-text half and the sub-floor blank-editor case, not these input glitches.

## list.md

- [list.md:50](list.md#L50) — _(Android)_ A **sync live pull** that creates or re-ranks a note while the list is composed at the top still relies on LazyListState key anchoring, so the remotely-changed row can land above the viewport until the user drags. Same anchoring class as the local-edit invisibility bug fixed 2026-07-02 (local create/edit now re-pin via `requestScrollToItem` on the FAB path and a pop-time re-pin in `AppShell.pop()`); the `reloadAsync` sync-pull path has no at-top re-pin yet. → NotesStore.kt `reloadAsync`, MainActivity.kt `AppShell.pop`
- [list.md:80](list.md#L80) — Tauri desktop sidebar note rows show the **title only** — no body preview at all. The single-line, markdown-opaque `make_preview` snippet appears on the For-You feed cards (`ForYouPage.svelte`), not in the sidebar rows. The rich multi-line preview is native-only (iOS + Android) for now.

## nav.md

- [nav.md:13](nav.md#L13) — *(accessibility — fix did not take effect at runtime)* The iOS list nav-bar controls — the **gear** (Settings), the **cloud** (Sync), and the **"+"** create-note menu — carry explicit `accessibilityLabel`s ("Settings" / "Sync" / "New note or folder"), a `.isButton` trait, stable `accessibilityIdentifier`s (`nav-settings` / `nav-sync` / `nav-create`), and distinct `ToolbarItem(id:)`s in code (added 2026-06-26), but the runtime check the gap was waiting on **failed**: an `idb ui describe-all` pass on the iOS 26.5 simulator (2026-07-02, during a QA run) shows the list nav-bar controls as **unlabeled Groups** — no labels, identifiers, or button traits surface in the AX tree, and automation must tap them by screenshot coordinates. (The editor's nav bar is fine — its "…" exposes AXLabel "More".) Needs investigation into why SwiftUI toolbar-hosted labels don't reach the AX tree here. → NoteListView.swift toolbar
- [nav.md:44](nav.md#L44) — on-device autofocus QA is partly done. iOS: opening an EXISTING note stays keyboard-less — verified on the simulator 2026-07-13 (no editor accessory toolbar appears on open; it only appears after tapping the body). iOS new-note autofocus (editor body raises the keyboard) is inspection-confirmed only — the nav-bar "New Note" menu is not idb-drivable on iOS 26 (M21), so it wasn't exercised. Android (existing keyboard-less + native-title autofocus) is still pending. *(native shells)*

## sync.md

- [sync.md:850](sync.md#L850) — Android leaves the open editor bound to the deleted id (its snapshotFlow adopt early-returns on the missing note); the peer-delete close/keep + banner is not yet ported there.

_11 gaps._
