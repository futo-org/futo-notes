# Next steps: text-first editor (iOS, Android, engine), as of 2026-11-09

This picks up the work from the 2026-11-06 to 11-09 sessions. Read it top to bottom before you start anything.

## Where things stand

- **Engine (main):** every engine MR from this round has merged. They are !589, !590, !592–!600, !602, !603, !604, !627, !628, !629, !630, !631 and !632. The stacked chain !605–!625 was folded into !627 (tables), !628 (code, fences, paste), !629 (links) and !632 (lists). The chain originals are closed, and !613 was dropped.
- **iOS:** `ios-text-first` (MR !591, draft) is at `d4ec4cfe2`. That is the same code as the dev build on Justin's iPhone "aha", and Opus gave it SHIP. The checkout is `/Users/justin/Developer/futo-notes/futo-notes-ios-text-first`, on the branch. The ledger is `docs/plan/ios-text-first.md` on that branch. M1–M8 are done and M9 is not started.
- **Android:** `android-text-first` (MR !564, draft) is at `80cc9339b`. It is merged with main, and the handoff doc is committed at `docs/plan/android-text-first-handoff/README.md`. **Justin is handing Android to Mason.** We no longer drive Android work. Only append to the handoff doc's `known-bugs.md` when we learn something.
- **Running when this was written:** an Android smoke QA (app-qa). Its report goes to `/Users/justin/Developer/futo-notes/android-handoff-artifacts/smoke-qa.md`. When it lands, add any FAILs to `docs/plan/android-text-first-handoff/known-bugs.md` on `android-text-first`, together with these three possibly flaky CI-emulator tests:
  - `TextFirstTableSceneTest.doneClosesTheFocusedCellAndItsKeyboard`: a 10 s keyboard wait.
  - `TextFirstLinkTapTest.tapInsideWrappedLinkInAHeadingPlacesCaretAtNearestAtomEdge`: a tap was dropped, so selection was 0 where 111 was expected.
  - `TextFirstProgressiveOpenTest`: layout height 45172 vs 423027, in one full local run only.

  Commit that as one docs-only fast-forward.

## Durable notes and evidence (outside the repo)

- `/Users/justin/Developer/futo-notes/mrqa-engine-artifacts/IOS-INTEGRATION-QUEUE.md`: the running log of decisions, merges and every follow-up found. The newest entries are at the bottom.
- `/Users/justin/Developer/futo-notes/mrqa-engine-artifacts/mr-<iid>/`: review, re-check and Codex files for each engine MR. `engine-chain-fold/inventory.md` maps each chain MR to its commits.
- `/Users/justin/Developer/futo-notes/ios-text-first-artifacts/`: iOS reviews (`codex-fixes/`, `batch-1109/`), screenshots and the long test note.
- `/Users/justin/Developer/futo-notes/android-handoff-artifacts/`: the handoff draft and the smoke QA output.

## Product decisions Justin made (don't relitigate)

- **One MR per platform:** all iOS work is in !591 and all Android work in !564. Shared Rust goes to main as small, separate engine MRs.
- **iOS:** UITextView on TextKit 2 is final. The minimum is iOS 18, with iOS 27 APIs behind `#available`.
- **Indent/Outdent** (spec: `docs/spec/editor/portable-core/list-indent.md`):
  - Lists nest. Indent writes a **tab**, and the engine renumbers.
  - No repairs. The buttons are almost never greyed: they are disabled only when nothing sensible can happen (first item, top-level Outdent).
  - Paragraphs, headings, plain quotes and tables show the buttons, disabled.
  - Code blocks take a literal tab, never on the fence lines.
  - A moved item takes the kind of the list it joins.
- **"The Obsidian way":** an empty marker indented under a list item is an empty nested item, not a setext underline. This comes from a one-function patch to pulldown-cmark, vendored at `vendor/pulldown-cmark` (see `PATCH.md`). Justin approved this dependency change.
- **Link rule:**
  - A tap opens only http, https, mailto, tel and sms.
  - A schemeless destination resolves as a note.
  - The link prompt adds `https://` to web-looking input, unless a note by that name exists. Notes win.
- **Image tap:** a plain tap puts a collapsed caret after the image, drawn at its right edge. Long-press or drag selects the image. See `mobile/images.md` line 4.
- **Paste:** a pasted Markdown link becomes a link, not its characters (decided 2026-11-09). Main's engine already does this; `ios-text-first` has it since main was merged in on 2026-11-09, and its engine crates now equal main's (`TextFirstLinkTests.aPastedMarkdownLinkBecomesALink`).
- **List exit mid-note:** keep main's spelling (decided 2026-11-09): Enter twice on an item followed by a blank line and a paragraph leaves `- one\n\n\nafter` with the caret under the item, so typing there continues the item, as in Obsidian. No separator comment is written. iOS draws the caret at the item's text (`TextFirstExitCaretTests`).
- **Quote-keep:** a list command inside a quote keeps the quote (`> x` → `> - x`).
- **120Hz** (`CADisableMinimumFrameDurationOnPhone`) stays, but moves out into its own small MR.
- **Dropped:** the save-lock, store-reset-ends-sessions and expected-id-rename engine work. Revisit only if typing stalls during sync are actually seen.

## Next work, in order (each item waits on Justin's go)

### 1. Small MRs
- [ ] 120Hz `Info.plist` change as its own MR. It is currently inside the iOS branch.
- [ ] A CLI test rustfmt chore MR (the `apps/cli/tests/{local,server}.rs` lines Codex reformatted).
- [ ] Shared toolbar manifest `packages/editor/src/toolbar.ts`: Indent/Outdent are still gated on `when: 'inContainer'`. The spec says they're visible everywhere and disabled where nothing applies.

### 2. iOS fix lane (branch from `ios-text-first`, merge back, then Opus re-check)
- [ ] With the keyboard down, the find bar sits under the home indicator. An untested patch is at `/Users/justin/Developer/futo-notes/ios-text-first-artifacts/bottom-lip/find-bar-safe-area.patch`.
- [ ] An empty heading on the last line isn't styled.
- [ ] A toolbar list on a quote adds a blank line on the first keystroke.
- [ ] `sms:` is blocked by the Swift external-open guard, though the engine allows it.
- [ ] Rotation freeze/hitch (M8 leftover). Also: before iOS 27 a new width loses the reader's line in a long note. CI's iOS 26 runtime put the top 51,488 characters away in `TextFirstLongNoteTests.aNewWidthKeepsTheReadersLineAtTheTop` (a known issue there before iOS 27). The pool sims are all iOS 27, so this needs an iOS 26 runtime to reproduce. The likely fix is to anchor the top character across the width change ourselves.
- [ ] A whole-image selection's blue tint is hidden under the image (LOW).
- [ ] Code block on a new last line below another code block (`` ```\nx\n```\n\n ``, caret at the end) draws the empty block's background 4 pt taller until the first character is typed (known-issue row in `TextFirstEmptyMarkerTests`; the engine's source is the same shape as in an empty note, which draws right).

- [ ] Codex review of !591 (2026-11-09; `ios-text-first-artifacts/merge-591/codex-review.md`), two findings left for engine work:
  - Leaving an untouched new note deletes it if a peer's write landed meanwhile: the save adopts the write, the Swift mirror stays empty, `TextFirstLeaves` sees `isEmpty` and deletes. The WKWebView screen has the same in-memory check. The fix is an engine "close and delete if still empty" that checks identity and content under the mutation gate.
  - Quick open and full open read the file separately. If an outside write lands in between, the prefix check fails and input typed while opening is dropped (`+Opening.swift`). The fix is to take both views from one engine snapshot.

### 3. Engine fix lane (small engine MRs to main)
- [ ] Word completion with Bold off: `hel` → `hello` gives `**hel**lo`.
- [ ] Find: a first press with no current match but total > 0 should step to a match.
- [ ] H4–H6 light up "paragraph" in the toolbar mapping (a one-line fix, near !594's code).
- [ ] `set_link` over a table destroys the table. Repro: `| a |\n| - |\n| b |`. One Undo restores it.
- [ ] Backspace on the blank line after a closing fence errors.
- Refusals the iOS random input suite found (2026-11-09). Each is a named known-issue row in `apps/ios/Tests/Editor/TextFirst/TextFirstRandomInputTests.swift` (`RandomInputRows`), which turns red once the engine fixes it. The bytes below reproduce in plain `EditorSession` unless marked "iOS only".
  - [x] Replacing or deleting a selection that crosses into or out of a code block is always refused, and one from a heading or paragraph into a bullet or numbered list about half the time. Typing, paste, Enter, a composition and Backspace over such a selection all hit it, so the key is dropped. Spec: `interpretation-and-input.md:22`. Repro: the suite's note, display UTF-16 `[71,176)` (from `note]].` in the intro to `let ` in the code block), then type `d`; or `[69,108)`, from the intro into the second bullet.
    Fixed on `cross-block-selection-edit` (`crates/futo-notes-editor/src/inline/edit/frames.rs`). Root causes: a cut kept one end of a code block's frame (an orphan closer or opener, so the parser read the rest as something else), and a list item left under the joined text could not be a list there (an ordered item numbered above 1, or one indented four columns whose parent was selected, reads as a lazy continuation). Block paste from inside code to outside it also replaced raw source across the closer. Found by the new property test and left open (each refused or wrong on main too):
    - A selection starting and ending inside inline spans in different paragraphs is refused (`para one **bold** end\npara one **bold** end\n\npara one **bold** end`, display `[11,47)`, type `d`): the two spans meet as `**bo**d**old**`.
    - An edit that leaves a closed code block as the last block of the note is refused, because the old display's final line ending cannot show after code (this is "Backspace on the blank line after a closing fence" above, also from a selection that starts there and reaches the end of the note).
    - Removing the blank line above an ordered list that does not start at 1, or above a four-column-indented item, with the selection ending on that blank line, is accepted with the list shown as text (the list is outside the planner's context): `para one **bold** end\n\n9. nine\n10. ten`, delete `[14,18)`.
    - Emptying a list item right under a paragraph (no blank line) is refused: a lone `- ` reads as a setext underline.
    - Enter over a selection that starts in a heading or list item can show a list's markers or place its break wrongly (`# head\n\n9. nine\n10. ten`, `[3,9)`), Enter over a multi-line selection inside one code block writes the break twice, and Enter over a selection starting in a quote or list item that reaches out of it is refused.
    - Block paste over a whole code block plus a list after it is refused in some shapes; it keeps the blank line above the block.
  - [ ] A multi-line paste at the end of a link inside a heading is refused: `line1\nline2` pasted at display 1 of `# [l](https://e.x)Heading\n`. (The link-after-Bold and heading-span link pastes are fixed on main.)
  - [ ] Backspace at a caret is refused on a line that an Enter split out of a link: `Intro a [l\n ](https://example.com)a quote\n> second line\n`, display 10.
    (The code block half, `para\n\n```\ncode\n```\n` at display 6, is fixed by the selection item above: the Backspace deletes the blank line's break and the block's first line joins it, as a quote's or a list item's does.)
  - [ ] A key, Enter or dictation at a caret is refused (iOS only). Seen in a numbered item holding a pasted quote (toolbar Numbered list on the first line, paste `> q`, Backspace, Enter), and after `1. ` was typed over a selection, then dictation. (The task item holding a pasted code block is fixed on main.)
  - [ ] The engine answers `InvalidRange` for valid ranges: `- a\n- b` pasted at display 203 of the suite's note (the start of the last table row); `plain` pasted at display 17 of `| a |\n| - |\n| b |Heading one\n\nx\n`; Enter over display bytes `[2,4)` (`" \n"`) of `1. é \nIntro with x\n`.
  - [ ] Replacing or deleting text inside one line is refused: a word replacement, or a key or Backspace over a single-line selection (iOS only; seeds 414, 453, 481 at 150 operations). One case, below a task item holding a pasted code block: source `- [ ] \n- [ ] \n- [ ] ```\n      code\n      ```\n      Heading one\n\nIntro with **bold**…`, replace display `[48,52)` with `hello`.
  - [ ] A composition committed at a caret after an undo is refused (iOS only, 9 operations; the row has them).
  - Seen on main while checking pastes (source churn, the display is right): a link pasted after a collapsed Bold at a line start saves `**[l](https://e.x)**&#72;eading one`, and one beside a heading's spans respells `**hel**` as `__he&#108;__`.

### 4. File as ONE issue (rare-shape engine bugs on main, each with its repro bytes)
- A link next to a whitespace-only code span loses formatting: `"\n\` \`\ncd"` with link `[0,4)`.
- `>-` (no space) list: Enter moves the next line out of the quote.
- Code-off on a note with mixed line endings turns an internal CRLF into LF.
- `>1. a\n>2. b`: Indent doesn't nest. The tab's first column is consumed as the quote's optional space.
- `>\t Z` displays with a visible leading space.
- A selection from an item's code block into the next item greys out Indent/Outdent.
- Joining a sub-list indented with 4 spaces writes a tab: `1. a\n    1. x\n2. b` → `\t2. b`.
- A backtick spanning table rows can refuse Backspace (`UnrepresentableFormat`).
- A style-plan window with a lone `\r` before `\r\n` (`- a\r\r\n`) disagrees with the whole plan. It's latent, since no host uses windows yet.
- `DisplayMirror` has no revision check, and the style_plan FFI uses `map_or(0, ..)` on conversion errors.
- NFC/NFD note names don't match in `resolve_note_link`. Same behavior as wikilinks.
- Deleting the blank line between two large tables leaves the second table's far rows stale (iOS restyle trigger).
- Already filed: #337 (numbered-list perf, `uncut_piece`) and #338 (exact bytes in desktop sync scenarios).

### 5. iOS M9 (the last milestone; see `docs/plan/ios-text-first.md` on the branch)
- [ ] Remaining `docs/spec/editor/mobile/*` lines, VoiceOver alt text, overflow menu actions, and the scroll indicator / huge single paragraph / restyle after Bold-all on 2.3 MB (from M8).
- [ ] A partial-image selection leaves fragments (from !595).
- [ ] A paragraph directly above a table re-slices the rest of the note on every keystroke.
- [ ] A physical-iPhone evidence pass. Never block on it.

### 6. Spec wording
- [ ] `interpretation-and-input.md:22` needs the image exception (!595). Write !597's wording (`mr-597/recheck.md`), the !603 `pending_edits` citation and the word-delete limitation.
- [ ] Qualify "as in Obsidian" in `PATCH.md` and `lists.md`: Lezer agrees only when the parent and child markers are the same kind.

### 7. Housekeeping
- [ ] Remove stale worktrees once nothing needs them: `.claude/worktrees/{codex-fixes,img-redraw,empty-marker,...}`, `futo-notes-ios-tf-{device,integ,leave-identity,longnote}`. Before removing, check each for uncommitted changes and for commits not on any remote.
- [ ] Three locked worktrees have merged branches and their `target/` already deleted: `futo-notes-editor-283-296`, `futo-notes-editor-283-299-recovery` and `futo-notes-text-first-editor-rebuild`. Ask Justin before removing them, since the lock says "ACTIVE".
- [ ] !568 (recovery-log cleanup) conflicts with main and its pipeline is red. Ask Justin: rebase it or close it?
- [ ] About 14 non-engine open MRs, mostly Mason's. Run `/mr-qa` only when asked.

## How to work (rules learned this round)

- **Reviews:** Opus does every code review: diff reading, triage, adversarial tests and the verdict. Sonnet does setup and fixes only. Each MR also gets one Codex sanity pass (`gpt-*-sol`, high, read-only). Every fix gets an Opus re-check before merge.
- **Merging:** a SHIP inside a merge flow means merge. Go oldest first, re-check mergeability after each merge, and use `PUT .../merge?sha=<full sha>`.
- **Git:**
  - Push with `git push "https://oauth2:${GITLAB_TOKEN}@gitlab.futo.org/futo-notes/futo-notes.git" <ref> 2>&1 | sed "s/${GITLAB_TOKEN}/***/g"`.
  - Never use `-u`, never force-push, never stash. Merge main rather than rebasing. Platform branches only fast-forward.
  - `glab` needs `GITLAB_HOST=gitlab.futo.org`.
  - GitLab JSON can contain control characters: parse it with `python3 json.loads(..., strict=False)`.
- **CI flakes** (retry once after naming the test):
  - runner timeouts / git 5xx;
  - vitest timeouts on Rust-only diffs;
  - `concurrent_creates_and_appends_all_land`;
  - "keyword index never became ready";
  - the `portable_attachment_cannot_open_before_a_prepared_native_relink_finishes` timeout;
  - Android emulator / AGP reporter crashes.
- **iOS tests:** run drawing suites with the simulator in LIGHT mode, since dark mode fails them.
- **iPhone installs:** `xcrun devicectl device install app --device <UDID> <app>`, then `... process launch --device <UDID> --terminate-existing com.futo.notes.dev`. Get the UDID from `node scripts/ios-device-id.mjs`, and disable the sandbox. A locked phone fails the launch; ask Justin to unlock it.
- **Disk:** run `df -h /` before builds. Delete each worktree's `target/` when done. Never delete inside a locked worktree.
