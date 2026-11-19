# Pointer and touch

### PT01

- **Rule:** Every desktop note-pane press uses one hit-test and one gesture owner.
- **Why / history:** Earlier placement, link and selection handlers raced across event phases; !249 centralized them and the new desktop repeats that ownership.
- **Evidence:** !249; e4df2be29; docs/spec/editor/desktop/editing.md
- **Applies:** `desktop now`. **Check:** tests/desktop-editor-pointer-stories.mjs

### PT02

- **Rule:** A press left or right of text lands at that visual row's start or end.
- **Why / history:** !184 fixed dead gutters and clicks jumping to a wrapped paragraph's final row; the desktop plan explicitly restores the near/far model.
- **Evidence:** !184; docs/plan/desktop-editor.md
- **Applies:** `desktop now`. **Check:** desktop/editing.md; pointer stories

### PT03

- **Rule:** A press less than two line heights below the last row retains its column, and a farther press reaches note end.
- **Why / history:** CodeMirror established this geometry; Milkdown used an always-trailing paragraph instead; Mason selected the former for desktop.
- **Evidence:** !184; !275; docs/plan/desktop-editor.md
- **Applies:** `desktop now`. **Check:** tests/desktop-editor-pointer-stories.mjs

### PT04

- **Rule:** Double-click selects the word at the resolved position, including the last word past a line's end.
- **Why / history:** Mason, 2026-11-04, option 3B; fresh Android double-tap failure has prior word-selection history but different native mechanics.
- **Evidence:** a77edcd7d (worktree-gpui-desktop-rewrite experiment); docs/plan/desktop-editor.md; 055240f3b B1 (android-text-first)
- **Applies:** `desktop now`. **Check:** desktop/editing.md; pointer stories

### PT05

- **Rule:** Triple-click selects the complete logical line including its wrapped rows but excluding its break.
- **Why / history:** Mason, 2026-11-04, option 5B; fresh alternating native selection handles are a mobile-specific symptom.
- **Evidence:** docs/plan/desktop-editor.md; maintainer list, 2026-11-10
- **Applies:** `desktop now`. **Check:** desktop/editing.md; pointer stories

### PT06

- **Rule:** Dragging selects in the unit chosen by the press and deselects immediately when dragged back past it.
- **Why / history:** Mason's slice-2 contract includes wordwise double-click drags and reversing past the press point.
- **Evidence:** docs/plan/desktop-editor.md; e4df2be29
- **Applies:** `desktop now`. **Check:** tests/desktop-editor-pointer-stories.mjs

### PT07

- **Rule:** Dragging selected text farther than four pixels moves it on release as one Undo action.
- **Why / history:** A press without movement places the caret; a drop inside the selection is a no-op; moved text remains selected.
- **Evidence:** 53c0dd843; docs/spec/editor/desktop/editing.md
- **Applies:** `desktop now`. **Check:** crates/futo-notes-editor/tests/move_text.rs; pointer stories

### PT08

- **Rule:** Selection drag auto-scrolls the actual note pane and stops all work on release.
- **Why / history:** !441 fixed scrolling the editable rather than desktop's .note-body; both upper and lower edges need coverage.
- **Evidence:** !441; #270; docs/spec/editor/desktop/editing.md
- **Applies:** `desktop now`. **Check:** tests/desktop-editor-pointer-stories.mjs

### PT09

- **Rule:** Title slack and tag chrome blur the body instead of inserting at a guessed position.
- **Why / history:** The older CM6 tag-bar blank space reached the note; Mason's desktop plan identifies the tag row as chrome, a deliberate reversal.
- **Evidence:** !184; docs/plan/desktop-editor.md; cursor/blank-editor-surface.md
- **Applies:** `desktop now`. **Check:** needs a chrome-versus-note story

### PT10

- **Rule:** Touch selection retains the system's handles, loupe and callout.
- **Why / history:** !50 removed desktop mouse snapping from native embeds because compatibility mouse events moved the user's handles.
- **Evidence:** !50; c672affd6; cursor/native-touch-and-focus.md
- **Applies:** `mobile only`. **Check:** Native touch handles are not desktop mouse selection; fresh alternating triple-tap handles need a mobile story

### PT11

- **Rule:** A scroll, long hold, canceled gesture or multitouch release never activates a link.
- **Why / history:** !338 replaced touch-release activation with a short stationary tap and deduplicated only that anchor's compatibility click.
- **Evidence:** !338; docs/spec/editor/external-links.md
- **Applies:** `slice 5`. **Check:** needs a story for rapid independent mouse clicks and touch cancellation

### PT12

- **Rule:** A rendered block move has one between-block slot, matching the eventual committed boundary.
- **Why / history:** Mason, !276 discussion, 2026-09-03 rejected separate above/below slots; !402 restricts movement to top-level blocks.
- **Evidence:** !276 discussion; !394; !402; cursor/selection/block-drag-lifting-and-drop-slots.md
- **Applies:** `obsolete`. **Check:** Old block-handle behavior is historical; rendered block movement is deferred by #311, while text drag is desktop now

### PT13

- **Rule:** A programmatic mobile line selection starts native selection mode and reliably displays its handles.
- **Why / history:** The 2026-11-04 Android feedback plan B2 explains alternating triple-tap handles as action-mode/tap-state ownership, not desktop geometry.
- **Evidence:** 055240f3b (android-text-first), B2; maintainer list, 2026-11-10
- **Applies:** `mobile only`. **Check:** Native action-mode/handles story; desktop equivalent is PT05

### PT14

- **Rule:** The desktop block handle offers a 24-by-28-pixel target beside the first line and starts a drag only for the primary mouse pointer.
- **Why / history:** The handle sits four pixels left of the column; touch and pen must retain their own selection gestures rather than entering desktop mouse dragging.
- **Evidence:** cursor/selection/block-drag-lifting-and-drop-slots.md; src/features/editor/milkdown/milkdownEditor.css:18.
- **Applies:** `slice 4`. **Check:** needs handle-edge, secondary-button, touch and pen stories.

### PT15

- **Rule:** A native long press lifts a block only when text editing is unfocused and scrolling has not won the gesture.
- **Why / history:** The roughly 340 ms hold yields to native word selection while focused; text interaction and back swipes are suspended only for the appropriate press/lift stages.
- **Evidence:** cursor/selection/block-drag-autoscroll-release-and-touch.md; cursor/native-touch-and-focus.md.
- **Applies:** `mobile only`. **Check:** Native long-press arbitration is mobile only; desktop retains mouse handles and native touch selection.
