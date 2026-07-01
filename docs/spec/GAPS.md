# Gap Inventory — GENERATED, do not edit

One line per inline `> **Gap:**` note in docs/spec/*.md (the source of
truth). Regenerate with `just spec-gaps`; `just spec-gaps-check` (part of
`just check`) fails when this file is stale and runs closure probes that
flag gaps the codebase suggests have been implemented.

## editor.md

- [editor.md:299](editor.md#L299) — Clipboard image paste is verified on Linux (WebKitGTK), Windows (WebView2), and native Android (emulator, 2026-06-22). The iOS path is now wired both ways: the embed posts `saveImageData` when WKWebView exposes the pasted image File, and falls back to the payload-less `pasteClipboardImage` (bridge contract v5) when WKWebView hides the bitmap — EditorWebView.swift's `clipboardImageData()` then reads it off `UIPasteboard.general` (raw png/jpeg, else UIImage→PNG) and saves through `VaultImages.save`, the SAME vault path as the picker. Compiles clean (`just build-ios-native`). What remains is on-device end-to-end QA: (1) a native iOS device/simulator (copy a screenshot / "Copy Image", paste into the editor, confirm a vault blob + `![](image-…)` insert), and (2) **macOS** desktop (Tauri/WKWebView) for the analogous `looksLikeImagePaste` → `fs_paste_clipboard_image` fallback. To close: run both manual checks. (bridge added 2026-06-26)

## list.md

- [list.md:58](list.md#L58) — Tauri desktop sidebar note rows show the **title only** — no body preview at all. The single-line, markdown-opaque `make_preview` snippet appears on the For-You feed cards (`ForYouPage.svelte`), not in the sidebar rows. The rich multi-line preview is native-only (iOS + Android) for now.

_2 gaps._
