# Android text-first editor: handoff

- **Branch:** `android-text-first`. **MR:** !564 (draft), futo-notes on gitlab.futo.org.
- **Written:** 2026-11-09, from the branch at `dbe0c2a92` (main merged in, 0 commits behind
  main). It has every engine MR through !632, including !604, !627–!632.
- **Size:** 332 commits ahead of main (265 not merges, dated 2026-11-02 to 2026-11-08). The diff
  touches 251 files, +21k lines. Most of it is Kotlin under
  `apps/android/app/src/main/java/com/futo/notes/textfirst/` (81 files) plus 44
  androidTest files under `textfirst/`.

## Contents

- [Architecture](architecture.md)
- [Build, run, test](build-run-test.md)
- [What Android must adopt, and Kotlin→Rust migration](adopt-and-migrate.md)
- [Known bugs and gaps](known-bugs.md)

## 1. Status

The Android text-first editor does everyday editing on dev builds. It covers typing with real
keyboards (Gboard and FUTO Keyboard composition, autocorrect, hardware keys), the full
formatting toolbar, lists and tasks, quotes, code, links and wikilinks (including completion),
inline vault and remote images, camera and paste, tables (a read-only grid plus in-place cell
editing), find in note, and long notes (quick open, then streaming). Saving goes through the
Rust store, and merges and renames from sync retarget the open editor. Maturity: it is
dogfood-grade. A combined run on an emulator passed 222 of 227 native tests (the other five
are opt-in perf tests that skip), and there has been hands-on testing on a Moto g play 2023
and a Pixel 7a. It is not release-grade: typing-latency budgets on the low-end phone are
unmet or unmeasured, and large notes open slowly on that phone (§7).

**It sits behind a persistent dev flag.** `TextFirstFlag` (`textfirst/TextFirstFlag.kt`) is
on by default in dev builds (the `.dev` app ids, debuggable or not) and is never on in
release builds, which still ship the WebView editor. The flag is stored in SharedPreferences
(`text_first_editor` / `enabled`) and changes only through a launch extra, which persists
until you set it again:

```bash
adb shell am start -n com.futo.notes.dev/com.futo.notes.MainActivity --ez futo.textFirstEditor false  # WebView editor
adb shell am start -n com.futo.notes.dev/com.futo.notes.MainActivity --ez futo.textFirstEditor true   # text-first again
```

Branch on `NotesStorage.isDevBuild`, never `BuildConfig.DEBUG` (a `-PfutoDebuggable=false`
dev build has DEBUG false).

## 4. Decisions already made (don't relitigate)

| Date | Decision |
|---|---|
| 2026-11-06 | **One MR per platform** (Justin, during the iOS planning). Android fixes land on `android-text-first` (!564). iOS lands on `ios-text-first` (!591). Engine changes go to main in small engine MRs, and each branch merges main often. |
| 2026-11-06 | **Rust host-module direction.** Logic that exists only in Kotlin and isn't platform UI goes into Rust (`futo-notes-editor` `host` module, UniFFI in `crates/futo-notes-ffi/src/editor/host.rs`), not into Swift. Android migration onto those APIs is optional follow-up, not a blocker (§6). |
| 2026-11-06 | **iOS uses UITextView on TextKit 2**, final. Context only: it is why iOS can't bound its layout to a prefix the way Android does (`mobile/long-notes.md:11` gap). |
| 2026-11-06 | **Shared mobile spec layer.** `docs/spec/editor/mobile/` holds *(mobile)* lines shared by iOS and Android. An *(Android text-first editor)* line that isn't Android-specific moves there when it passes on iOS, and both branches carry it. |
| 2026-11-06 (`b876e63b3`) | **The store writes a final newline.** Every nonempty authored note write ends in a line ending: LF, or CRLF for a CRLF note. Importing a file stays byte for byte. Opening an unchanged note writes nothing. Drafts compare to disk in saved form (`portable-core/recovery.md`, `futo-notes-store` `saved_note_source`). |
| 2026-11-06 / 2026-11-09 | **Indent/Outdent.** List items nest and un-nest and are never refused for their shape. Indent writes a **tab** (`\t`, Obsidian style) after any `>` markers. The buttons are visible everywhere on mobile and greyed only where nothing sensible can happen: paragraphs, headings, plain quote lines and tables; Indent on the first item of a list; Outdent on a top-level item. On code lines they add or remove a tab. **The empty new item (Obsidian way):** Indent on `- a\n- ` writes `- a\n\t- ` with no blank-line repair, and the patched parser reads that line as an empty nested item, not a setext underline. A moved item takes the kind of the list it joins and keeps its checkbox. Specs: `portable-core/list-indent.md`, `lists.md:25`, `fenced-code.md:9`, `markdown-toolbar/toolbar-commands.md:5,89`. Engine: !599, !604 (merged 2026-11-09, `10370ff53`), on the branch. The vendored, patched pulldown-cmark stays. |
| 2026-11-09 | **Link rule** (!631, merged `2a5e760cd`). Tapping a link: only an explicit `http`, `https`, `mailto`, `tel` or `sms` scheme opens externally. A schemeless destination is a note path (relative to the note's folder, `/` = vault root, `.md` optional, `#`/`?` ignored); it opens the note if it exists and otherwise does nothing. The link prompt saves a schemeless web-looking address (`www.…` or a well-known public domain, not `.md`) with `https://`. File-like names (`setup.sh`, `main.rs`, `my.notes`) stay as typed, and so does a typed destination that names an existing note. |
| 2026-11-09 | **A plain tap on an image puts a collapsed caret right after it**, drawn at the image's right edge. Long-press, drag or Select All can still select it as one object. This reverses `mobile/images.md:4`. |
| 2026-11-09 | **A list inside a quote keeps the quote:** a list command on a quoted paragraph gives `> - x` (decision "D1"). Engine change in !632 (merged `74e124e8b`), on the branch. Spec: `portable-core/lists.md:21`. |
| 2026-11-09 | **The save-lock engine work is dropped.** Dropped proposals: snapshot-then-write without the attachment lock, terminating sessions on store reset, rename with an expected session id, and !604's "repair exotic shapes" scope. Reason: edge-case complexity. Revisit only if typing stalls during sync saves are actually observed. |
| 2026-11-04 | Mason's feedback decisions (`docs/plan/text-first-mason-feedback-2026-11.md`): emphasis allowed inside headings (1A); Backspace at a heading's start joins with the line above (2A); tapping the active H1/H2/H3 again returns the line to Text, with no separate Text button on mobile (3A); Code block on a multi-block selection makes one fence (5A). Decision 4 (a format lights only if the whole selection has it, and refused commands are dimmed) is **provisional** until Mason has used it. |
| 2026-10-30 | Deferred from the #283 core: rich HTML paste (#303), rendered block movement (#311), table alignment changes, row/column reordering, multi-cell paste. |

## 8. Suggested first week

1. **Get a green baseline.** Check that the `dbe0c2a92` pipeline (or a later one) passed
   `build:android-native` (ignore the five assumption "failures"). Run
   `just android-native`, then
   `just test-android-ui com.futo.notes.textfirst com.futo.notes.editor` on a claimed
   emulator and note anything red.
2. **Read:** this doc, the !564 description, `apps/android/AGENTS.md`,
   `docs/spec/editor/mobile/*`, `portable-core/list-indent.md`, and
   `docs/plan/text-first-mason-feedback-2026-11.md`.
3. **Hands-on smoke** with puppet on an emulator, then on the Moto with a non-debuggable dev
   build. Cover: open a long note, type with Gboard, lists and indent, a table cell, find,
   an image, a link, leave and reopen, then check the bytes with `just puppet file`.
4. **Indent/Outdent and Tab (§5.1–5.2):** verify the greyed states and the `\t` spelling on a
   device, and add device tests for them. Take the manifest question to Justin.
5. **Image tap caret (§5.3).**
6. **Link rule (§5.4)** Kotlin wiring, then a device check of **quote-keep (§5.5)**. Update
   the Android spec lines (`external-links.md:66`).
7. Run the full combined device suite and update the !564 description with fresh evidence.
8. Only then start on §6 migrations or the #336 open-time work.

## 9. Who to ask, and where the history lives

- **Justin**, for product calls and anything in §4.
- Ledgers and plans:
  - `docs/plan/text-first-mason-feedback-2026-11.md` (branch): the Mason feedback round,
    decisions and evidence. Delete it when its last item is done.
  - `docs/plan/text-first-editor-rebuild.md` and `docs/plan/text-first-editor-rebuild-tickets*.md`:
    the #283 engine plan and ticket graph.
  - `docs/plan/ios-text-first.md` on `origin/ios-text-first`: the iOS ledger, with the Kotlin
    → Rust mapping table.
  - !564's description and notes: per-commit evidence and every "Android can adopt X" note
    from the iOS lane.
  - `/Users/justin/Developer/futo-notes/mrqa-engine-artifacts/` (Justin's machine, not in git):
    `IOS-INTEGRATION-QUEUE.md`, plus per-MR review notes (`mr-589/` … `mr-631/`,
    `engine-chain-fold/inventory.md`).
  - `docs/spec/editor/performance/android-text-first.md`: Android perf lines and measurements.
  - Issues: #318 (this work's spec), #283 (engine), #334–#336 (open follow-ups).
