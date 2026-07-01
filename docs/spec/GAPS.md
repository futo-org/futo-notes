# Gap Inventory — GENERATED, do not edit

One line per inline `> **Gap:**` note in docs/spec/*.md (the source of
truth). Regenerate with `just spec-gaps`; `just spec-gaps-check` (part of
`just check`) fails when this file is stale and runs closure probes that
flag gaps the codebase suggests have been implemented.

## app.md

- [app.md:64](app.md#L64) — Android pre-11 (API < 30) devices can't use Device storage (All-files access is an API-30 mechanism) — they only get App storage, so their vault is not visible in a file manager. *(Android)*
- [app.md:68](app.md#L68) — The vault folder is fixed per mode and not a user-pickable arbitrary directory on mobile (desktop allows a custom folder); iOS has no iCloud Drive vault option. Both are possible follow-ups. *(iOS / Android)*

## editor.md

- [editor.md:290](editor.md#L290) — Clipboard image paste is verified on Linux (WebKitGTK), Windows (WebView2), and native Android (emulator, 2026-06-22). The iOS path is now wired both ways: the embed posts `saveImageData` when WKWebView exposes the pasted image File, and falls back to the payload-less `pasteClipboardImage` (bridge contract v5) when WKWebView hides the bitmap — EditorWebView.swift's `clipboardImageData()` then reads it off `UIPasteboard.general` (raw png/jpeg, else UIImage→PNG) and saves through `VaultImages.save`, the SAME vault path as the picker. Compiles clean (`just build-ios-native`). What remains is on-device end-to-end QA: (1) a native iOS device/simulator (copy a screenshot / "Copy Image", paste into the editor, confirm a vault blob + `![](image-…)` insert), and (2) **macOS** desktop (Tauri/WKWebView) for the analogous `looksLikeImagePaste` → `fs_paste_clipboard_image` fallback. To close: run both manual checks. (bridge added 2026-06-26)

## list.md

- [list.md:55](list.md#L55) — Tauri desktop still shows the single-line, markdown-opaque `make_preview` snippet in note rows; the rich preview is native-only (iOS + Android) for now.

## nav.md

- [nav.md:13](nav.md#L13) — *(accessibility — pending device confirmation)* The iOS list nav-bar controls — the **gear** (Settings), the **cloud** (Sync), and the **"+"** create-note menu — now each carry an explicit `accessibilityLabel` ("Settings" / "Sync" / "New note or folder"), a `.isButton` trait, and a stable `accessibilityIdentifier` (`nav-settings` / `nav-sync` / `nav-create`), and the two leading items have distinct `ToolbarItem(id:)`s so they should no longer collapse into one unlabeled AX container. Compiles and launches (`just build-ios-native`; all three controls render). What remains is the runtime AX confirmation the gap was originally filed from: an idb `describe-ui` / VoiceOver pass on a sim/device showing the three as separate, labeled, activatable elements (idb is not installed in this environment). → NoteListView.swift toolbar (fix 2026-06-26)

## sync.md

- [sync.md:32](sync.md#L32) — Only the Android shell pre-validates the URL scheme. iOS (SyncManager.swift) and desktop (syncManager.svelte.ts) pass the raw URL straight to the client, so a schemeless URL there still fails with a generic connection error rather than the actionable message.

_6 gaps._
