# Gap Inventory — GENERATED, do not edit

One line per inline `> **Gap:**` note in docs/spec/*.md (the source of
truth). Regenerate with `just spec-gaps`; `just spec-gaps-check` (part of
`just check`) fails when this file is stale and runs closure probes that
flag gaps the codebase suggests have been implemented.

## app.md

- [app.md:67](app.md#L67) — Android pre-11 (API < 30) devices can't use Device storage (All-files access is an API-30 mechanism) — they only get App storage, so their vault is not visible in a file manager. *(Android)*
- [app.md:71](app.md#L71) — The vault folder is fixed per mode and not a user-pickable arbitrary directory on mobile (desktop allows a custom folder); iOS has no iCloud Drive vault option. Both are possible follow-ups. *(iOS / Android)*

## editor.md

- [editor.md:314](editor.md#L314) — Clipboard image paste is verified on Linux (WebKitGTK), Windows (WebView2), native Android (emulator, 2026-06-22), and **macOS desktop** (Tauri/WKWebView — real clipboard image + real Cmd+V through the `looksLikeImagePaste` → `fs_paste_clipboard_image` fallback, verified in the 2026-07-02 full-spec QA pass). The iOS path is wired both ways: the embed posts `saveImageData` when WKWebView exposes the pasted image File, and falls back to the payload-less `pasteClipboardImage` (bridge contract v5) when WKWebView hides the bitmap — EditorWebView.swift's `clipboardImageData()` then reads it off `UIPasteboard.general` (raw png/jpeg, else UIImage→PNG) and saves through `VaultImages.save`, the SAME vault path as the picker. Compiles clean (`just build-ios-native`). What remains is on-device end-to-end QA on **native iOS only**: copy a screenshot / "Copy Image", paste into the editor, confirm a vault blob + `![](image-…)` insert. (bridge added 2026-06-26)

## list.md

- [list.md:37](list.md#L37) — *(Android)* A **sync live pull** that creates or re-ranks a note while the list is composed at the top still relies on LazyListState key anchoring, so the remotely-changed row can land above the viewport until the user drags. Same anchoring class as the local-edit invisibility bug fixed 2026-07-02 (local create/edit now re-pin via `requestScrollToItem` on the FAB path and a pop-time resort in `AppShell.pop()`); the `reloadAsync` sync-pull path has no at-top re-pin yet. → NotesStore.kt `reloadAsync`, MainActivity.kt `AppShell.pop`
- [list.md:67](list.md#L67) — Tauri desktop sidebar note rows show the **title only** — no body preview at all. The single-line, markdown-opaque `make_preview` snippet appears on the For-You feed cards (`ForYouPage.svelte`), not in the sidebar rows. The rich multi-line preview is native-only (iOS + Android) for now.
- [list.md:159](list.md#L159) — Android native — the autofocused title places the cursor at the start of the prefilled "Untitled", so typing prepends ("XUntitled") instead of replacing the placeholder the way the mobile-width web shell's select-all does. Found in the emulator QA pass (2026-06); still present in code 2026-07-01 — the title `BasicTextField` in NoteEditorScreen.kt takes a plain String and never sets a selection. → NoteEditorScreen.kt

## nav.md

- [nav.md:13](nav.md#L13) — *(accessibility — fix did not take effect at runtime)* The iOS list nav-bar controls — the **gear** (Settings), the **cloud** (Sync), and the **"+"** create-note menu — carry explicit `accessibilityLabel`s ("Settings" / "Sync" / "New note or folder"), a `.isButton` trait, stable `accessibilityIdentifier`s (`nav-settings` / `nav-sync` / `nav-create`), and distinct `ToolbarItem(id:)`s in code (added 2026-06-26), but the runtime check the gap was waiting on **failed**: an `idb ui describe-all` pass on the iOS 26.5 simulator (2026-07-02, during a QA run) shows the list nav-bar controls as **unlabeled Groups** — no labels, identifiers, or button traits surface in the AX tree, and automation must tap them by screenshot coordinates. (The editor's nav bar is fine — its "…" exposes AXLabel "More".) Needs investigation into why SwiftUI toolbar-hosted labels don't reach the AX tree here. → NoteListView.swift toolbar

_7 gaps._
