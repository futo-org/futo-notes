# Gap Inventory — GENERATED, do not edit

One line per inline `> **Gap:**` note in docs/spec/*.md (the source of
truth). Regenerate with `just spec-gaps`; `just spec-gaps-check` (part of
`just check`) fails when this file is stale and runs closure probes that
flag gaps the codebase suggests have been implemented.

## app.md

- [app.md:65](app.md#L65) — Android pre-11 (API < 30) devices can't use Device storage (All-files access is an API-30 mechanism) — they only get App storage, so their vault is not visible in a file manager. *(Android)*
- [app.md:69](app.md#L69) — The vault folder is fixed per mode and not a user-pickable arbitrary directory on mobile (desktop allows a custom folder); iOS has no iCloud Drive vault option. Both are possible follow-ups. *(iOS / Android)*

## editor.md

- [editor.md:303](editor.md#L303) — Clipboard image paste is verified on Linux (WebKitGTK), Windows (WebView2), and native Android (emulator, 2026-06-22). The iOS path is now wired both ways: the embed posts `saveImageData` when WKWebView exposes the pasted image File, and falls back to the payload-less `pasteClipboardImage` (bridge contract v5) when WKWebView hides the bitmap — EditorWebView.swift's `clipboardImageData()` then reads it off `UIPasteboard.general` (raw png/jpeg, else UIImage→PNG) and saves through `VaultImages.save`, the SAME vault path as the picker. Compiles clean (`just build-ios-native`). What remains is on-device end-to-end QA: (1) a native iOS device/simulator (copy a screenshot / "Copy Image", paste into the editor, confirm a vault blob + `![](image-…)` insert), and (2) **macOS** desktop (Tauri/WKWebView) for the analogous `looksLikeImagePaste` → `fs_paste_clipboard_image` fallback. To close: run both manual checks. (bridge added 2026-06-26)

## list.md

- [list.md:58](list.md#L58) — Tauri desktop sidebar note rows show the **title only** — no body preview at all. The single-line, markdown-opaque `make_preview` snippet appears on the For-You feed cards (`ForYouPage.svelte`), not in the sidebar rows. The rich multi-line preview is native-only (iOS + Android) for now.
- [list.md:147](list.md#L147) — Android native — the autofocused title places the cursor at the start of the prefilled "Untitled", so typing prepends ("XUntitled") instead of replacing the placeholder the way the mobile-width web shell's select-all does. Found in the emulator QA pass (2026-06); still present in code 2026-07-01 — the title `BasicTextField` in NoteEditorScreen.kt takes a plain String and never sets a selection. → NoteEditorScreen.kt

## nav.md

- [nav.md:13](nav.md#L13) — *(accessibility — fix did not take effect at runtime)* The iOS list nav-bar controls — the **gear** (Settings), the **cloud** (Sync), and the **"+"** create-note menu — carry explicit `accessibilityLabel`s ("Settings" / "Sync" / "New note or folder"), a `.isButton` trait, stable `accessibilityIdentifier`s (`nav-settings` / `nav-sync` / `nav-create`), and distinct `ToolbarItem(id:)`s in code (added 2026-06-26), but the runtime check the gap was waiting on **failed**: an `idb ui describe-all` pass on the iOS 26.5 simulator (2026-07-02, during a QA run) shows the list nav-bar controls as **unlabeled Groups** — no labels, identifiers, or button traits surface in the AX tree, and automation must tap them by screenshot coordinates. (The editor's nav bar is fine — its "…" exposes AXLabel "More".) Needs investigation into why SwiftUI toolbar-hosted labels don't reach the AX tree here. → NoteListView.swift toolbar

_6 gaps._
