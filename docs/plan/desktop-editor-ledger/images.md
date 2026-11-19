# Images

### IM01

- **Rule:** An image at note end can be selected and followed by Enter to create a line below it.
- **Why / history:** Mason prefers select-then-Enter over an undeletable trailing line; the engine already preserves the selected image and moves after it.
- **Evidence:** Maintainer list, 2026-11-10; portable-core/images.md
- **Applies:** `slice 5`. **Check:** tests/images.rs; needs desktop EOF-image story

### IM02

- **Rule:** Image atoms expose only before and after caret stops.
- **Why / history:** A renderer must not put the caret inside hidden image spelling; partial selections otherwise leave Markdown fragments.
- **Evidence:** portable-core/images.md; #393
- **Applies:** `slice 5`. **Check:** tests/images.rs; needs desktop selection/deletion story

### IM03

- **Rule:** Desktop Backspace beside an image selects it before a second Backspace deletes it.
- **Why / history:** Mason's desktop plan chooses two-stage deletion; !595's shared engine instead deletes a reached image atom immediately.
- **Evidence:** docs/plan/desktop-editor.md; !595; portable-core/images.md
- **Applies:** `slice 5`. **Check:** needs a desktop spec line and story; README decision E records the difference

### IM04

- **Rule:** Copying an image exports its Markdown source.
- **Why / history:** The desktop plan deliberately defers a separate Copy image command.
- **Evidence:** docs/plan/desktop-editor.md
- **Applies:** `slice 5`. **Check:** needs clipboard story

### IM05

- **Rule:** Image insertion stores a vault file and writes only the portable reference into Markdown.
- **Why / history:** Asset, blob and futo-asset URLs are display-only; pasted and picked images use the same infrastructure.
- **Evidence:** 6e8f151f8; docs/spec/editor/images.md
- **Applies:** `slice 5`. **Check:** needs paste/pick/drop/save/reopen story

### IM06

- **Rule:** Clipboard images support both OS bitmaps and browser Copy Image without stealing ordinary text paste.
- **Why / history:** Linux WebKitGTK can hide the File and expose only HTML; the native clipboard fallback requires the image-shaped payload.
- **Evidence:** 6e8f151f8; docs/spec/editor/images.md
- **Applies:** `slice 5`. **Check:** needs real macOS, WebView2 and WebKitGTK clipboard stories

### IM07

- **Rule:** An asynchronous image result belongs to its originating note session.
- **Why / history:** Ordinary edits keep the claim valid; switching notes or reopening the same note invalidates it; !484 fixed same-byte switches bypassing this cleanup.
- **Evidence:** portable-core/images.md; !484
- **Applies:** `slice 5`. **Check:** tests/images.rs; needs slow-picker and note-switch story

### IM08

- **Rule:** Several dropped images preserve their order and one failed image does not stop the others.
- **Why / history:** The existing desktop contract distinguishes OS files from internal text or block drags.
- **Evidence:** docs/spec/editor/images.md; tests/image-drop.spec.ts
- **Applies:** `slice 5`. **Check:** needs desktop multi-image drop story

### IM09

- **Rule:** An image's async load or viewport resize recomputes layout without clipping or blank gaps.
- **Why / history:** !126 fixed missing requestMeasure after async load; 8a8d263e fixed width growth clipping; stale geometry also broke drag previews in !433.
- **Evidence:** !126; 2127cc0a8; 8a8d263ed; !433
- **Applies:** `slice 5`. **Check:** needs image-load/resize/caret/viewport story

### IM10

- **Rule:** Image resolution is bounded to rendered images and a missing file can resolve after sync arrives.
- **Why / history:** A failed resolution must not be cached forever; early global eager preload leaked memory and network work.
- **Evidence:** docs/spec/editor/images.md; docs/learnings/scroll-fix-handoff-report.md@2ac045dd6^
- **Applies:** `slice 5`. **Check:** needs late-sync image and cache-bound story

### IM11

- **Rule:** A photo does not add stray blank space or split the words immediately before it.
- **Why / history:** Latest iOS !639/!640 address hidden-spelling line boxes and UAX line-break behavior; desktop still needs its own geometry checks.
- **Evidence:** !639; !640; #399; #404; #409
- **Applies:** `slice 5`. **Check:** needs a desktop image layout story; iOS fixes are not proof for desktop

### IM12

- **Rule:** A composition beside or replacing an image uses visible text attributes.
- **Why / history:** #407 records inheriting a 0.01pt transparent image glyph font; #405/#406 record image-height carets and baseline errors.
- **Evidence:** #405; #406; #407
- **Applies:** `slice 5`. **Check:** needs an image-adjacent composition and caret story

### IM13

- **Rule:** Typing supported image Markdown converts at its closing parenthesis unless escaped or inside code.
- **Why / history:** Mason explicitly kept the spec's convert-as-typed rule in !372 on 2026-09-29, including remote URLs; the new typed-Markdown decision must reconcile any changed engine behavior.
- **Evidence:** !372; docs/spec/editor/images.md
- **Applies:** `slice 5`. **Check:** needs a desktop typed-image/save/reopen story and explicit decision with MD01

### IM14

- **Rule:** A canceled or refused camera request leaves the note unchanged and permits a later retry.
- **Why / history:** !41 catches a missing camera activity; !454 requests Android camera permission at use, handles revocation between check and launch, and prevents a stale prompt result from starting capture after its owner disappears.
- **Evidence:** !41; !454; markdown-toolbar/native-toolbar-chrome.md.
- **Applies:** `mobile only`. **Check:** Android camera permissions and activities have no desktop analogue; retain as native prior art.
