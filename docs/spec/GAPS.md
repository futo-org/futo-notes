# Gap Inventory — GENERATED, do not edit

One line per inline `> **Gap:**` note in docs/spec/*.md (the source of
truth). Regenerate with `just spec-gaps`; `just spec-gaps-check` (part of
`just check`) fails when this file is stale and runs closure probes that
flag gaps the codebase suggests have been implemented.

## app.md

- [app.md:129](app.md#L129) — Android pre-11 (API < 30) devices can't use Device storage (All-files access is an API-30 mechanism) — they only get App storage, so their vault is not visible in a file manager. _(Android)_
- [app.md:133](app.md#L133) — The vault folder is fixed per mode and not a user-pickable arbitrary directory on mobile (desktop allows a custom folder); iOS has no iCloud Drive vault option. Both are possible follow-ups. _(iOS / Android)_

## editor.md

- [editor.md:267](editor.md#L267) — the **native** shells (iOS/Android) no-op a broken wikilink tap — the editor embed posts `openNote` only for a _resolved_ link, so a broken tap neither opens nor (on first edit) creates the target note the way desktop does. _(native shells)_ → editor-embed/main.ts
- [editor.md:563](editor.md#L563) — Clipboard image paste is verified on Linux (WebKitGTK), Windows (WebView2), native Android (emulator, 2026-06-22), and **macOS desktop** (Tauri/WKWebView — real clipboard image + real Cmd+V through the `looksLikeImagePaste` → `fs_paste_clipboard_image` fallback, verified in the 2026-07-02 full-spec QA pass). The iOS path is wired both ways: the embed posts `saveImageData` when WKWebView exposes the pasted image File, and falls back to the payload-less `pasteClipboardImage` (bridge contract v5) when WKWebView hides the bitmap — EditorWebView.swift's `clipboardImageData()` then reads it off `UIPasteboard.general` (raw png/jpeg, else UIImage→PNG) and saves through `VaultImages.save`, the SAME vault path as the picker. Compiles clean (`just build-ios-native`). What remains is on-device end-to-end QA on **native iOS only**: copy a screenshot / "Copy Image", paste into the editor, confirm a vault blob + `![](image-…)` insert. (bridge added 2026-06-26)
- [editor.md:604](editor.md#L604) — a note whose text forms one giant markdown *leaf* — tens of KB with no blank line, e.g. a 3000-line contiguous blockquote, one huge paragraph, or a single ~500 KB line — still types at ~30–50 ms/keystroke (grows with leaf size; ~240 ms at 1.2 MB). Root cause is upstream: `@lezer/markdown` re-runs inline parsing (`parseInline`/`LinkEnd`) over the entire leaf on each edit, as one uninterruptible step CM6's parse budget cannot preempt (CPU-profile attributed, 2026-07-29). This is an ecosystem-wide CM6/lezer characteristic — Obsidian exhibits the same class of large-note typing lag — not FUTO Notes code. Candidate future fix: a lezer block-parser extension splitting leaves every ~32 KB (VS Code-style bounded tokenization). Repro: open a note that is one giant contiguous block (e.g. a 3000-line blockquote with no blank lines) in `just tauri-dev` and type.
- [editor.md:853](editor.md#L853) — (iOS) on the navigation exit iOS ignores a parked-conflict disposition — the engine parks the draft as a conflict copy and the editor stays on the original id, whose content on disk is now the peer's version. Only the move exit follows the parked id (`editorMoveSourceId`). Android re-keys the open note on navigation too. Observed 2026-08-01 reading both shells' exits side by side; → issue #79.
- [editor.md:862](editor.md#L862) — (Android) an editor change that lands after the destructive latch is DROPPED on Android — `acceptsEditorChange` returns false once closed and there is no quarantine buffer, so a keystroke inside the delete window is lost when that delete then fails. iOS quarantines it, folds it into the commit, and hands it back on failure. Observed 2026-08-01; → issue #80.
- [editor.md:885](editor.md#L885) — on some old Android System WebViews (the Chromium 80–98 tier that runs the editor but predates `@layer`), users report the shift key re-arming after each character, the caret jumping to the start of the line after the first character, and content scrolling out of view while typing (github#8). These are CM6-on-old-engine input limitations. They did **not** reproduce on the Chromium-83 emulator even with FUTO Keyboard as the IME (per-keystroke, fast-burst, and glide typing all behaved), so the cause is likely physical-device IME timing or a specific WebView build. Unaddressed — the legacy-WebView work fixes the black-text half and the sub-floor blank-editor case, not these input glitches.

## list.md

- [list.md:51](list.md#L51) — _(Android)_ A **sync live pull** that creates or re-ranks a note while the list is composed at the top still relies on LazyListState key anchoring, so the remotely-changed row can land above the viewport until the user drags. Same anchoring class as the local-edit invisibility bug fixed 2026-07-02 (local create/edit now re-pin via `requestScrollToItem` on the FAB path and a pop-time re-pin in `AppNavigator.goBack()`); the `reloadAsync` sync-pull path has no at-top re-pin yet. → NotesStore.kt `reloadAsync`, AppNavigation.kt `AppNavigator.goBack`
- [list.md:81](list.md#L81) — Tauri desktop sidebar note rows show the **title only** — no body preview at all. The single-line, markdown-opaque `make_preview` snippet appears on the For-You feed cards (`ForYouPage.svelte`), not in the sidebar rows. The rich multi-line preview is native-only (iOS + Android) for now.

## nav.md

- [nav.md:67](nav.md#L67) — Android on-device autofocus QA (existing note keyboard-less + native-title autofocus) is still pending. *(Android)*

## sync.md

- [sync.md:266](sync.md#L266) — The heal is not idempotent for a name ending in repeated `". "` groups — `sanitize_title` peels exactly one group per pass, so `"a. ..md"` heals to `"a..md"`, which the next cycle heals again to `"a.md"`: one rename per sync round until it settles. Closing it means changing the title rule in both `packages/editor/src/filename.ts` and `futo-notes-core` plus regenerated conformance fixtures (AGENTS.md M7); the invariant is recorded as the `#[ignore]`d `healing_an_incoming_path_settles_in_one_round` property.
- [sync.md:587](sync.md#L587) — The native shells receive the per-id delta but do not yet act on it: `onLivePull` is a zero-argument callback, so iOS and Android still rescan the whole vault after every cycle and never follow a reported rename. An open note that sync relocates reads as a peer delete on iOS ("Note was deleted during sync") and strands the Android editor on the old id. Scoping the list refresh additionally needs a per-id metadata verb; the engine exposes only whole-vault `scan()` today.
- [sync.md:971](sync.md#L971) — Android leaves the open editor bound to the deleted id (its snapshotFlow adopt early-returns on the missing note); the peer-delete close/keep + banner is not yet ported there. The verdict it needs now exists as one engine verb (`classify_open_note`, reachable over UniFFI); what remains is the Compose side that renders it.
- [sync.md:997](sync.md#L997) — No shell renders the verb yet — desktop, iOS and Android each still run their own copy of the decision (two of them on desktop, with different toast wording). The verb and both projections landed first so the adoptions can be reviewed one surface at a time; desktop's is staged in scripts/command-reachability-allowlist.json with its reason. Until then the native in-place focused adopt above still stands; adopting the verb changes it to a deferred adopt on blur.

_15 gaps._
