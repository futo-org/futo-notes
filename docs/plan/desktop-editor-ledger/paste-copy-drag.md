# Paste, copy and drag

### PC01

- **Rule:** Plain paste is read as Markdown while preserving the copied spaces and tabs.
- **Why / history:** One trailing copied line ending is dropped; a paste starting or ending in whitespace must not fuse surrounding words.
- **Evidence:** paragraphs-and-lines.md; portable-core/clipboard.md
- **Applies:** `desktop now`. **Check:** tests/clipboard.rs; tests/desktop-editor-stories.mjs

### PC02

- **Rule:** A lone pasted block marker inserts its characters rather than creating an empty block.
- **Why / history:** A marker with body text is a block; one indented line remains literal while multiline indented input may be code.
- **Evidence:** paragraphs-and-lines.md; portable-core/clipboard.md
- **Applies:** `desktop now`. **Check:** tests/clipboard.rs; needs desktop marker-only paste story

### PC03

- **Rule:** A pasted block splits its surrounding line and preserves each side's block and inline formatting.
- **Why / history:** Headings stay headings on both sides; a paste of only list items adds siblings within a list.
- **Evidence:** portable-core/clipboard.md
- **Applies:** `desktop now`. **Check:** tests/clipboard.rs; structured rendering checked in slices 3–6

### PC04

- **Rule:** Pasted links are interpreted as pasted Markdown rather than subjected to typed-delimiter timing rules.
- **Why / history:** !628 folds named-link paste; d7120bda separates rich/plain paste from typed escaping.
- **Evidence:** !618; !628; d7120bda1; 129f06b37
- **Applies:** `desktop now`. **Check:** tests/clipboard.rs; needs source/display paste story

### PC05

- **Rule:** A paste cannot pair with surrounding punctuation to change unselected text.
- **Why / history:** 182d680 fixes pasted brackets consuming a note's existing destination; existing * pairing matters too.
- **Evidence:** 182d68033; portable-core/clipboard.md
- **Applies:** `desktop now`. **Check:** tests/clipboard.rs

### PC06

- **Rule:** Mod+V chooses meaningful HTML formatting and Shift+Mod+V uses only plain text.
- **Why / history:** Mason, 2026-11-05: rich paste is already built, despite its original slice-7 placement; code prefers the plain form.
- **Evidence:** docs/plan/desktop-editor.md; portable-core/clipboard.md
- **Applies:** `desktop now`. **Check:** tests/clipboard/html.rs; desktop paste-and-match-style stories

### PC07

- **Rule:** HTML paste preserves visible formatting and ignores nonvisible or unsafe image payloads.
- **Why / history:** The engine reads CSS bold/italic/strike, ignores script/style/head, accepts only http(s) image sources and treats code-editor styling as plain when appropriate.
- **Evidence:** portable-core/clipboard.md; tests/clipboard/html.rs
- **Applies:** `slice 7`. **Check:** tests/clipboard/html.rs; needs rendered-format desktop stories

### PC08

- **Rule:** Copy exports selected Markdown with enough original delimiters and block prefixes to preserve its meaning.
- **Why / history:** Spaces-only selections acquire no markers; CRLF and nested indentation follow the source contract.
- **Evidence:** portable-core/clipboard.md
- **Applies:** `desktop now`. **Check:** tests/clipboard.rs; formatted clipboard inspection in later slices

### PC09

- **Rule:** Cut removes only selected visible text as one Undo action while carrying its starting format.
- **Why / history:** A copied complete quoted line can carry its prefix while the remaining empty marker is retained in the note.
- **Evidence:** portable-core/clipboard.md
- **Applies:** `desktop now`. **Check:** tests/clipboard.rs; needs desktop cut/paste-back story

### PC10

- **Rule:** A file drop never navigates the webview away from an unsaved note.
- **Why / history:** Nonimage files are claimed and ignored; HTML5 drop shapes differ across WebView2 and WebKitGTK.
- **Evidence:** docs/spec/editor/images.md; tests/image-drop.spec.ts
- **Applies:** `slice 5`. **Check:** needs real OS file-drop story on all desktop engines

### PC11

- **Rule:** A pasted code delimiter or complete block cannot escape its current code context.
- **Why / history:** !623/!624 fixed empty-code and cross-code selection paste separately.
- **Evidence:** !623; !624; !628; portable-core/clipboard.md
- **Applies:** `slice 6`. **Check:** tests/clipboard.rs; tests/fences/protected_input.rs

### PC12

- **Rule:** Dragging a block moves one whole top-level block, including an entire list or quote.
- **Why / history:** Individual-item dragging was tried and removed; a multiline paragraph is also one block. Shared engine rendered movement remains deferred under #311.
- **Evidence:** cursor/selection/block-drag-lifting-and-drop-slots.md; !336; !394; #311.
- **Applies:** `slice 4`. **Check:** needs a story for whole-list, whole-quote and multiline-paragraph movement; not a claim that engine block movement is built.

### PC13

- **Rule:** Dropping at the source block's own boundaries changes nothing and preserves selection and history.
- **Why / history:** One shared gap represents each boundary; a click on the handle or a no-op drop must not turn into text selection or an Undo entry.
- **Evidence:** cursor/selection/block-drag-lifting-and-drop-slots.md; !336; !402.
- **Applies:** `slice 4`. **Check:** needs a story for source-above/source-below no-ops, handle click and Escape.

### PC14

- **Rule:** A drag ghost follows the pointer at the block's actual size.
- **Why / history:** The browser's native drag image was roughly twice the intended size under scaled WebKitGTK; the pointer-driven ghost avoids operating-system drag-image scaling.
- **Evidence:** cursor/selection/block-drag-lifting-and-drop-slots.md; !402.
- **Applies:** `slice 4`. **Check:** needs a real scaled WebKitGTK story; compare ghost and source bounds.

### PC15

- **Rule:** Dragging within 64 pixels of a scroll edge scrolls from 200 to 1,400 pixels per second and keeps the drop target current.
- **Why / history:** Autoscroll recomputes the gap every frame even when the pointer stands still, and stops on release, cancellation, teardown or the scroll limit.
- **Evidence:** cursor/selection/block-drag-autoscroll-release-and-touch.md.
- **Applies:** `slice 4`. **Check:** needs a stationary-pointer autoscroll, release and teardown story.

### PC16

- **Rule:** A completed drop keeps the viewport at the previewed landing place.
- **Why / history:** Dragging the source off the top or shrinking content near the bottom previously let layout clamping jump the view; missing extent is held until it can be released safely.
- **Evidence:** cursor/selection/block-drag-autoscroll-release-and-touch.md; !433.
- **Applies:** `slice 4`. **Check:** needs a long-note top-to-bottom and bottom-shrink story.

### PC17

- **Rule:** A drop commits once after its landing animation and commits immediately if layout changes during that animation.
- **Why / history:** The landing waits at most about 180 ms; scrolling, resize, image load or an edit settles it immediately, while switching notes cancels it.
- **Evidence:** cursor/selection/block-drag-autoscroll-release-and-touch.md; cursor/selection/block-drag-lifting-and-drop-slots.md.
- **Applies:** `slice 4`. **Check:** needs one-Undo, note-switch and resize-during-landing stories.

### PC18

- **Rule:** The drop boundary follows the drawn middle of each block and is remeasured when layout changes.
- **Why / history:** Using the pre-animation layout made the gap flip repeatedly; an exact-middle tie keeps the current slot, and release rechecks geometry after image, font or window changes.
- **Evidence:** cursor/selection/block-drag-lifting-and-drop-slots.md; !441.
- **Applies:** `slice 4`. **Check:** needs a stationary-pointer image-load and animated-neighbor story.
