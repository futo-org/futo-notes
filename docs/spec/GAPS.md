# Gap Inventory — GENERATED, do not edit

One line per inline `> **Gap:**` note in docs/spec/*.md (the source of
truth). Regenerate with `just spec-gaps`; `just spec-gaps-check` (part of
`just check`) fails when this file is stale and runs closure probes that
flag gaps the codebase suggests have been implemented.

## editor.md

- [editor.md:268](editor.md#L268) — Clipboard image paste is verified on Linux (WebKitGTK), Windows (WebView2), and native Android (emulator, 2026-06-22). Two pieces remain unverified: (1) **macOS** desktop (Tauri/WKWebView) is untested — WKWebView may, like WebKitGTK, hide the bitmap from the JS paste event, in which case the `looksLikeImagePaste` → `fs_paste_clipboard_image` fallback should cover it; (2) **native iOS** has the `saveImageData` host handler implemented (mirrors Android) but is **unverified** (no Mac on hand to build/run). Also, the native paste path only handles an image *file* exposed on the paste event (Android/Chromium exposes one for both screenshot and Copy Image); if iOS WKWebView hides the bitmap the way WebKitGTK does, that shape won't paste until a native clipboard-read bridge is added. To close: test on macOS Tauri and an iOS device/simulator. (recorded 2026-06-22)

_1 gaps._
