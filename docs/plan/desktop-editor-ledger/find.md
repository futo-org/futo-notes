# Find in note

### FN01

- **Rule:** Find searches visible body text literally and case-insensitively without matching hidden markers or destinations.
- **Why / history:** CM6 !235/!267 searched source, including hidden syntax; Milkdown and the replacement core search visible text instead. Inline format boundaries do not split a match.
- **Evidence:** !267; docs/spec/editor/find-in-note.md; portable-core/find.md
- **Applies:** `slice 7`. **Check:** tests/find.rs; needs desktop formatted-text story

### FN02

- **Rule:** Find treats all Greek sigmas alike without corrupting offsets for expanding case folds.
- **Why / history:** Dotted-I regressions affected both matching and completion; one case fold cannot blindly serve both contexts.
- **Evidence:** !448; docs/spec/editor/find-in-note.md
- **Applies:** `slice 7`. **Check:** tests/find.rs; needs Unicode find story

### FN03

- **Rule:** Find can cross a soft line as a space but never crosses a block boundary, code line or table cell.
- **Why / history:** Markers, table pipes and padding are search barriers; title search remains a different feature.
- **Evidence:** portable-core/find.md; docs/spec/editor/find-in-note.md
- **Applies:** `slice 7`. **Check:** tests/find.rs; needs table and code stories

### FN04

- **Rule:** Stepping selects and reveals one match with wrap and does nothing at zero results.
- **Why / history:** Query field Enter/Shift+Enter and desktop Mod+G chords share stepping; closed find does not reopen on Mod+G.
- **Evidence:** docs/spec/editor/find-in-note.md
- **Applies:** `slice 7`. **Check:** needs desktop shortcut and wrap story

### FN05

- **Rule:** The first step after a new query lands before advancing, and a dropped match cannot create a dead press or skipped match.
- **Why / history:** !637 fixes both directions before and after rescan, plus current-match tracking after more than 64 unread edits.
- **Evidence:** !637; !598; #370; #371
- **Applies:** `slice 7`. **Check:** tests/host_find_plan.rs on main; needs dropped-match/Undo desktop story

### FN06

- **Rule:** Find adds no document edit or Undo step and no full scan to the typing path.
- **Why / history:** Input records a bounded change log; settled rescans reject stale session, revision and query results.
- **Evidence:** portable-core/find.md; !550
- **Applies:** `slice 7`. **Check:** tests/find.rs; needs typing-with-find performance story

### FN07

- **Rule:** Closing find clears every highlight and keeps its previous query only within the same note.
- **Why / history:** Mason's !267 review explicitly rejected stale dull highlights and flickering counts; no state crosses a note switch.
- **Evidence:** !267 discussion, 2026-08-27; docs/spec/editor/find-in-note.md
- **Applies:** `slice 7`. **Check:** needs clear-query/close/switch story

### FN08

- **Rule:** Desktop find does not summon the selection-formatting toolbar for its own matches.
- **Why / history:** Escape returns focus with the match selected, but the next user's selection restores the normal toolbar.
- **Evidence:** docs/spec/editor/find-in-note.md
- **Applies:** `slice 7`. **Check:** needs find-selection versus user-selection story

### FN09

- **Rule:** Find in note remains separate from global search and replace remains outside its scope.
- **Why / history:** Mason suggested carrying a global query in !267, but the accepted spec deliberately deferred that handoff.
- **Evidence:** !267 discussion; docs/spec/editor/find-in-note.md
- **Applies:** `slice 7`. **Check:** needs a spec line if either feature is later added

### FN10

- **Rule:** Opening desktop Find focuses and selects its query while closing leaves the current match selected in the note. The new desktop editor leaves a caret after the match instead (maintainer, 2026-11-18; docs/spec/editor/desktop/find.md).
- **Why / history:** Desktop Escape returns editor focus; the native find-close contract instead restores the prior editor selection and viewport, so the host behavior must not be copied blindly.
- **Evidence:** docs/spec/editor/find-in-note.md; portable-core/find.md.
- **Applies:** `slice 7`. **Check:** needs reopen-query and close-focus stories; FN08 pins formatting-bar suppression.
