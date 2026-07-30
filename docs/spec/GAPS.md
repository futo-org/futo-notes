# Gap Inventory — GENERATED, do not edit

One line per inline `> **Gap:**` note in docs/spec/*.md (the source of
truth). Regenerate with `just spec-gaps`; `just spec-gaps-check` (part of
`just check`) fails when this file is stale and runs closure probes that
flag gaps the codebase suggests have been implemented.

## app.md

- [app.md:123](app.md#L123) — Android pre-11 (API < 30) devices can't use Device storage (All-files access is an API-30 mechanism) — they only get App storage, so their vault is not visible in a file manager. _(Android)_
- [app.md:127](app.md#L127) — The vault folder is fixed per mode and not a user-pickable arbitrary directory on mobile (desktop allows a custom folder); iOS has no iCloud Drive vault option. Both are possible follow-ups. _(iOS / Android)_

## editor.md

- [editor.md:211](editor.md#L211) — the **native** shells (iOS/Android) no-op a broken wikilink tap — the editor embed posts `openNote` only for a _resolved_ link, so a broken tap neither opens nor (on first edit) creates the target note the way desktop does. _(native shells)_ → editor-embed/main.ts
- [editor.md:299](editor.md#L299) — iOS native still lacks an explicit `WKWebView` navigation-policy guard (the `openUrl` bridge covers taps on decorated links, but a programmatic top-level navigation inside the WebView is not yet policed).
- [editor.md:500](editor.md#L500) — Clipboard image paste is verified on Linux (WebKitGTK), Windows (WebView2), native Android (emulator, 2026-06-22), and **macOS desktop** (Tauri/WKWebView — real clipboard image + real Cmd+V through the `looksLikeImagePaste` → `fs_paste_clipboard_image` fallback, verified in the 2026-07-02 full-spec QA pass). The iOS path is wired both ways: the embed posts `saveImageData` when WKWebView exposes the pasted image File, and falls back to the payload-less `pasteClipboardImage` (bridge contract v5) when WKWebView hides the bitmap — EditorWebView.swift's `clipboardImageData()` then reads it off `UIPasteboard.general` (raw png/jpeg, else UIImage→PNG) and saves through `VaultImages.save`, the SAME vault path as the picker. Compiles clean (`just build-ios-native`). What remains is on-device end-to-end QA on **native iOS only**: copy a screenshot / "Copy Image", paste into the editor, confirm a vault blob + `![](image-…)` insert. (bridge added 2026-06-26)
- [editor.md:675](editor.md#L675) — on some old Android System WebViews (the Chromium 80–98 tier that runs the editor but predates `@layer`), users report the shift key re-arming after each character, the caret jumping to the start of the line after the first character, and content scrolling out of view while typing (github#8). These are CM6-on-old-engine input limitations. They did **not** reproduce on the Chromium-83 emulator even with FUTO Keyboard as the IME (per-keystroke, fast-burst, and glide typing all behaved), so the cause is likely physical-device IME timing or a specific WebView build. Unaddressed — the legacy-WebView work fixes the black-text half and the sub-floor blank-editor case, not these input glitches.

## list.md

- [list.md:51](list.md#L51) — _(Android)_ A **sync live pull** that creates or re-ranks a note while the list is composed at the top still relies on LazyListState key anchoring, so the remotely-changed row can land above the viewport until the user drags. Same anchoring class as the local-edit invisibility bug fixed 2026-07-02 (local create/edit now re-pin via `requestScrollToItem` on the FAB path and a pop-time re-pin in `AppNavigator.goBack()`); the `reloadAsync` sync-pull path has no at-top re-pin yet. → NotesStore.kt `reloadAsync`, AppNavigation.kt `AppNavigator.goBack`
- [list.md:81](list.md#L81) — Tauri desktop sidebar note rows show the **title only** — no body preview at all. The single-line, markdown-opaque `make_preview` snippet appears on the For-You feed cards (`ForYouPage.svelte`), not in the sidebar rows. The rich multi-line preview is native-only (iOS + Android) for now.

## nav.md

- [nav.md:67](nav.md#L67) — Android on-device autofocus QA (existing note keyboard-less + native-title autofocus) is still pending. *(Android)*

## sync.md

- [sync.md:266](sync.md#L266) — The heal is not idempotent for a name ending in repeated `". "` groups — `sanitize_title` peels exactly one group per pass, so `"a. ..md"` heals to `"a..md"`, which the next cycle heals again to `"a.md"`: one rename per sync round until it settles. Closing it means changing the title rule in both `packages/editor/src/filename.ts` and `futo-notes-core` plus regenerated conformance fixtures (AGENTS.md M7); the invariant is recorded as the `#[ignore]`d `healing_an_incoming_path_settles_in_one_round` property.
- [sync.md:945](sync.md#L945) — Android leaves the open editor bound to the deleted id (its snapshotFlow adopt early-returns on the missing note); the peer-delete close/keep + banner is not yet ported there.

_11 gaps._
