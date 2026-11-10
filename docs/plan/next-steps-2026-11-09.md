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
  - [ ] Replacing or deleting a selection that crosses into or out of a code block is always refused, and one from a heading or paragraph into a bullet or numbered list about half the time. Every input over such a selection hits it, so the key is dropped. Spec: `interpretation-and-input.md:23`. Repro: the suite's note, display UTF-16 `[71,176)` (from `note]].` to `let ` in the code block), then type `d`; or `[69,108)`, from the intro into the second bullet.
    The code block half is fixed on `cross-block-selection-edit` (!634, `inline/edit/frames.rs`, `session/checked_input.rs`): a cut that keeps one end of a fence's frame gets the other back, accepted only when the whole input's display is exactly the replaced one and every other line keeps its block. The list half is open for its own MR (its iOS rows are known issues again). !634 first respelled the lines after the joined text (an item restarting at 1, 4+ columns of indent dropped); its review (`mrqa-engine-artifacts/mr-634/review.md`) found this changes untouched lines. A correct respelling must not:
    - turn indented code after the joined text into prose (H1: `para\n\n    a\n    b\n`, `[4,7)`, type `d`);
    - turn an item's continuation paragraph after a blank line into indented code (H2: `para\n\n- p\n    - c\n\n      cp\n`, `[2,7)`, type `x`);
    - take children out of items the selection never touched (H3: `para\n\n- p\n    - c\n- i\n  ```\n  k\n  ```\n`, `[2,7)`, type `x`, or `  > q` under `- i`).
    It must respell only item lines, each against its parent, and pass the block check.
    Left open (refused, or wrong alike, on main):
    - A selection starting and ending inside inline spans in different paragraphs is refused (`para one **bold** end\npara one **bold** end\n\npara one **bold** end`, `[11,47)`, type `d`): the spans meet as `**bo**d**old**`.
    - A paragraph right after a frame the edit retires would turn lazy, so it is refused (R3: `para\n\n```\nab\n```\nnext line\n`, `[2,7)`, type `d`; Backspace at 6 of `para\n\n```\ncode\n```\ntail\n`).
    - An edit that leaves a closed code block as the note's last block is refused: the old display's final line ending cannot show after code (`` ```\nlet value = 1\nreturn value\n```\n\nSome text here\n ``, `[4,33)`, typing; "Backspace on the blank line after a closing fence" above).
    - Bound the whole-note check (`inline/kept.rs`: about 44 ms on a 20,000-line note on a Mac, only for an input that took a repair): check only the changed top-level blocks and neighbours, or skip repairs above a size.
    - Removing the blank line above an ordered list not starting at 1, or above a four-column-indented item, with the selection ending on it, is accepted with the list shown as text: `para one **bold** end\n\n9. nine\n10. ten`, delete `[14,18)`.
    - Emptying a list item right under a paragraph (no blank line) is refused: a lone `- ` reads as a setext underline.
    - Enter over a selection that starts in a heading or list item can show a list's markers or place its break wrongly (`# head\n\n9. nine\n10. ten`, `[3,9)`), Enter over a multi-line selection inside one code block writes the break twice, and Enter over a selection starting in a quote or list item that reaches out of it is refused.
    - Block paste over a whole code block and a list after it is refused in some shapes; it keeps the blank line above.
    - Edits across a code block the engine already accepted keep their result; some are wrong (the property test checks only their reopen and Undo): a whole code block selected with the blank line above it, after a list, makes the joined text and the next paragraph lazy lines of the last item (`- [ ] task\n- [x] done\n\n```\nlet x = 1\ny = 2\nz = 3\n```\n\npara one end\n\n# head\n`, `[10,33)`, type `xy`); removing an unclosed fence's opener turns its other lines into prose (`para one end\n```\nunclosed\nlines`, `[12,15)`, type `d`); typing or pasting over an item's line break into its code block leaves an empty fence opener in the item (M2: `- item\n  ```\n  c1\n  c2\n  ```\nplain text here\n`, `[4,8)`, type `d`); a paste from the end of a code line out of its block is planned as prose and drops the closer (the rest of the note is code) (`` ```\r\ncrlf\r\ncode\r\n```\r\n\n```\r\ncrlf\r\ncode\r\n```\r\n\n> quote a\n> quote b ``, `[4,12)`, paste `pp`), and one the planner cannot spell takes the verbatim code paste, which can hide the final line ending (`> ```\n> code one\n> code two\n> ```\n\ntail text\n`, `[3,19)`, paste `x\ny`); Enter's list rule after deleting a selection takes an item's marker (`- b\n\npara\nmore`, `[2,7)`; over code it is refused, M1).
    - Backspace at a heading's start right after a closing fence joins it onto the code line as code, so a link's destination leaves the source (`` ```\ncode\n```\n# title [l](https://e.x) `` gives `` ```\ncodetitle l\n``` ``, pinned in `tests/blocks/heading_join.rs`). Awaits Justin's call: keep, refuse joining a link, or move the caret without joining.
    - A paragraph key over a range splitting a CRLF widens it, as everywhere; Undo selects the widened range (L3). Typing over one across code is refused.
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
