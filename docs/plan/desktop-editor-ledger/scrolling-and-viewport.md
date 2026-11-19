# Scrolling and viewport

### SV01

- **Rule:** Select All leaves the reader's viewport where it was.
- **Why / history:** Fresh Android report has a documented cause: revealing selectionEnd after select(0,len); selection is not a request to jump to its end.
- **Evidence:** docs/plan/text-first-mason-feedback-2026-11.md@055240f3b (android-text-first), C1; maintainer list, 2026-11-10
- **Applies:** `desktop now`. **Check:** needs a desktop story at top, middle and bottom

### SV02

- **Rule:** Returning to a tab restores its scroll position, including after an app restart.
- **Why / history:** !33 originally persisted scroll and selection; Justin's approved 2026-07-16 triage in !97 dropped cross-restart selection restoration while keeping scroll. !410 fixed restoration before progressive layout was tall enough.
- **Evidence:** !33; !97 (S2); !410; docs/spec/tabs.md
- **Applies:** `desktop now`. **Check:** needs desktop switch/return and restart stories

### SV03

- **Rule:** Deferred scroll restoration waits for enough layout and yields to a user's intervening scroll.
- **Why / history:** !410: restoring into a short prefix clamped to the bottom and remained pinned there through appends.
- **Evidence:** !410; c417719ba
- **Applies:** `later: progressive open`. **Check:** needs a desktop story once progressive open exists

### SV04

- **Rule:** Typing and structural Enter reveal the caret promptly without waiting for a save debounce.
- **Why / history:** Fresh debounced-looking caret follow recurs from custom list Enter omitting scrollIntoView.
- **Evidence:** docs/learnings/ios-keyboard-editor-jump.md; maintainer list, 2026-11-10
- **Applies:** `desktop now`. **Check:** needs a desktop typing-at-bottom and long-quote story

### SV05

- **Rule:** A mouse press in an unfocused note preserves scroll and focuses at the press.
- **Why / history:** The kept native selection previously scrolled before the hit-tested selection was installed.
- **Evidence:** 9120b8eca; docs/spec/editor/desktop/editing.md
- **Applies:** `desktop now`. **Check:** tests/desktop-editor-pointer-stories.mjs

### SV06

- **Rule:** Up beyond the visible pane scrolls exactly one row per press, symmetrically with Down.
- **Why / history:** 396c7a29 fixes the desktop upper-edge case on 2026-11-10.
- **Evidence:** 396c7a29d; docs/spec/editor/desktop/editing.md
- **Applies:** `desktop now`. **Check:** needs a repeated-Up/Down viewport story

### SV07

- **Rule:** Async images, selection changes and normal typing do not throw the reader to the note bottom.
- **Why / history:** Fresh random-bottom reports are not a single proven root cause; previous causes include focus scroll and premature tab restoration.
- **Evidence:** !410; 9120b8eca; maintainer list, 2026-11-10
- **Applies:** `desktop now`. **Check:** needs a story isolating load, focus, input and delayed layout

### SV08

- **Rule:** The final text line has enough scrollable tail to remain reachable above overlays.
- **Why / history:** Existing policy uses max(40vh,280px); the new desktop CSS carries the same tail.
- **Evidence:** cursor/native-touch-and-focus.md; src/features/editor/desktop/desktopEditor.css
- **Applies:** `desktop now`. **Check:** needs EOF caret/selection story

### SV09

- **Rule:** The editor scrolls within its note pane rather than moving the root page behind chrome.
- **Why / history:** !258 fixed legacy @layer/inset loss causing text to scroll under the title.
- **Evidence:** !258; docs/spec/editor/theming.md
- **Applies:** `desktop now`. **Check:** needs a pane-versus-root scroll story on each desktop engine

### SV10

- **Rule:** Touch momentum is not canceled by programmatic scroll corrections during a flick.
- **Why / history:** e12e8414 replaced a failed reversal guard: any scrollTop write cancels iOS and Android momentum.
- **Evidence:** e12e8414c; docs/learnings/hr-scroll-jank.md@0fad0917b^
- **Applies:** `mobile only`. **Check:** Native touch-scroller constraint; mouse-wheel desktop still needs stable anchoring

### SV11

- **Rule:** A caret covered by the rising keyboard is visible when the keyboard settles.
- **Why / history:** !334 reveals on viewport resize; focusing on touchstart or following compositor offsets with CSS caused new jumps.
- **Evidence:** !334; docs/learnings/ios-keyboard-editor-jump.md
- **Applies:** `mobile only`. **Check:** Phone keyboard layout; desktop input panels need separate evidence

### SV12

- **Rule:** No unexplained bottom strip obscures editable text.
- **Why / history:** Fresh narrow-rectangle report has no confirmed earlier root cause; loading/find strips have explicit occlusion rules.
- **Evidence:** Maintainer list, 2026-11-10; no source found for the rectangle itself
- **Applies:** `desktop now`. **Check:** needs a story identifying the strip before prescribing a fix

### SV13

- **Rule:** Find reveal leaves the selected match clear of the find bar.
- **Why / history:** The old bar overlay required measured inset and remeasurement after hidden-marker reflow.
- **Evidence:** docs/spec/editor/find-in-note.md; !441
- **Applies:** `slice 7`. **Check:** needs desktop bottom-bar occlusion story

### SV14

- **Rule:** A layout correction above the viewport keeps the reader's visible text anchored.
- **Why / history:** 925ec6027 fixed CM6 compensating an overflow-visible inner scroller while the real outer note pane moved; widget estimates reduced error but did not replace anchoring in the actual scroll owner.
- **Evidence:** 925ec6027; 803bdd1d2; docs/learnings/hr-scroll-jank.md@0fad0917b^.
- **Applies:** `desktop now`. **Check:** needs wrapping, format-height and late-image layout stories; mobile momentum still follows SV10.
