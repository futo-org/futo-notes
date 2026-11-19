# Large notes and performance

### PF01

- **Rule:** Typing cost is bounded by the edited region rather than the whole document.
- **Why / history:** CM6 viewport scans, Milkdown changed-block repaint and desktop 512-line chunks each addressed the same repeated full-note work.
- **Evidence:** !153; !338; !361; df2c1ca85; docs/spec/editor/performance.md
- **Applies:** `desktop now`. **Check:** tests/desktop-editor-stories.mjs timings; needs structured large-note stories

### PF02

- **Rule:** Desktop-owned keystroke work meets median under 1 ms and p99 under 2 ms.
- **Why / history:** Mason set this slice-1 budget for the 120 Hz MacBook; it is distinct from the older 16 ms p95 full synchronous budget.
- **Evidence:** docs/plan/desktop-editor.md; desktop/editing.md
- **Applies:** `desktop now`. **Check:** src/features/editor/desktop/timings.ts; no fresh measurements in this research

### PF03

- **Rule:** Long quote typing does not repeatedly reparse or restyle the complete quote.
- **Why / history:** Fresh stalls were analyzed in Android feedback §E. Current long-regions.md cuts canonical explicit prose quotes locally; lazy or nested containers still have region-sized work, so the whole quote family is not proved fixed.
- **Evidence:** docs/plan/text-first-mason-feedback-2026-11.md@055240f3b (android-text-first); portable-core/remaining-work.md; portable-core/long-regions.md; !632
- **Applies:** `slice 4`. **Check:** needs a large-quote story; do not claim the residual is closed

### PF04

- **Rule:** A toolbar action does not queue minutes of stale commands or trap note navigation.
- **Why / history:** Fresh two-minute stall was already recorded in §E; Android posted every tap to one editor thread until leaving canceled queued taps.
- **Evidence:** 055240f3b (android-text-first); 5e74cd575 (android-text-first); maintainer list, 2026-11-10
- **Applies:** `slice 3`. **Check:** needs a desktop busy-command/cancel/switch story

### PF05

- **Rule:** Removing a list from one middle item costs the affected list work without rebuilding the whole note.
- **Why / history:** Fresh deselection stalls were separated into Rust, span-planning and layout costs in §E; current long-regions.md bounds middle-item Bullet removal, while more complex list shapes still need measurement.
- **Evidence:** 055240f3b (android-text-first), §E; portable-core/long-regions.md
- **Applies:** `slice 4`. **Check:** needs a middle-item toggle scaling story

### PF06

- **Rule:** Large selection paint costs only the visible rows while the logical selection covers the note.
- **Why / history:** The desktop paints viewport bands; native Writing Tools can still walk the whole DOM on selection and scroll.
- **Evidence:** desktop/editing.md; docs/learnings/large-file-editing.md
- **Applies:** `desktop now`. **Check:** needs long-note select/scroll story and native WebKit timing

### PF07

- **Rule:** The first viewport opens promptly while the rest can arrive in cancellable background work.
- **Why / history:** Mason, 2026-11-10 deferred progressive open after measuring 1.1 s host plus 1.7 s layout/paint at 58,000 lines.
- **Evidence:** docs/plan/desktop-editor.md Later; maintainer list, 2026-11-10
- **Applies:** `later: progressive open`. **Check:** needs a story for first paint, indicator and immediate switch to another note

### PF08

- **Rule:** A progressive open never saves an incomplete prefix or puts streamed appends in history.
- **Why / history:** Milkdown's critical save lock and !383 prevent background/exit loss; any desktop reimplementation must preserve these constraints.
- **Evidence:** !367; !383; docs/spec/editor/performance.md
- **Applies:** `later: progressive open`. **Check:** needs exact-tail/save/Undo/switch story

### PF09

- **Rule:** Progressive interpretation is equivalent to opening the whole source.
- **Why / history:** !367 fixed BOM offsets, container fences and hidden definitions; unknown boundaries must fail closed to a whole parse.
- **Evidence:** !367; docs/spec/editor/performance.md
- **Applies:** `later: progressive open`. **Check:** needs whole-versus-chunk display and source oracle

### PF10

- **Rule:** Large paste scales with inserted size instead of its square.
- **Why / history:** !195 fixes paste freezing; real paste events are necessary because Input.insertText can itself be quadratic on a bare editable.
- **Evidence:** !195; docs/spec/editor/performance.md; tests/paste-perf.spec.ts
- **Applies:** `desktop now`. **Check:** needs a desktop paste scaling story; no benchmark run in this research

### PF11

- **Rule:** Offscreen content remains available to selection, IME and screen readers.
- **Why / history:** Milkdown retired content-visibility after quadratic first focus; the desktop found stale selection paint and quadratic layer insertion too.
- **Evidence:** docs/spec/editor/performance.md; docs/learnings/large-file-editing.md
- **Applies:** `desktop now`. **Check:** needs select-clear-scroll and accessibility stories

### PF12

- **Rule:** Whole-DOM replacement parks measurement ranges and native selection before rewriting their containers.
- **Why / history:** !380 and !459 fixed different live Range owners causing WebKit O(n²) re-indexing; detach alone did nothing.
- **Evidence:** !380; !459; !550
- **Applies:** `desktop now`. **Check:** needs real WebKit click-then-open large-note story

### PF13

- **Rule:** No keystroke pays for every wikilink times every note in the vault.
- **Why / history:** !191 and !195 introduced shared indexing; autosave-triggered index rebuild remains a measured risk.
- **Evidence:** !191; !195; docs/spec/editor/performance.md
- **Applies:** `slice 5`. **Check:** needs a vault-size-by-link-count story

### PF14

- **Rule:** Gigabyte-note virtualization remains outside the current desktop scope.
- **Why / history:** Mason dropped the goal; the 2026-11 plan keeps every line in DOM and preserves the research for later.
- **Evidence:** docs/plan/desktop-editor.md; docs/learnings/large-file-editing.md
- **Applies:** `obsolete`. **Check:** Do not import parked giant-file architecture as a current acceptance requirement

### PF15

- **Rule:** A local edit in a long tight list does not widen to every item in the list.
- **Why / history:** #337 records uncut_piece repeatedly reading/repartitioning a complete nonblank list; desktop/Android and iOS measurements differ greatly and do not prove one sole cause.
- **Evidence:** #337 and its 2026-11-10 discussion; !590 discussion
- **Applies:** `slice 4`. **Check:** needs a fixed-size scaling story; issue remains open

### PF16

- **Rule:** Typing and note-switch latency stay responsive with a large vault and the sidebar visible.
- **Why / history:** !153 stopped relayout during sidebar animation; !208 measured about 125 ms of sidebar layout per note switch, misattributed to editor/IPC. Microbenchmarks with the sidebar removed cannot establish the full editing experience.
- **Evidence:** !153; !195 discussion; !208.
- **Applies:** `desktop now`. **Check:** needs full-window large-vault story alongside engine-only timings.

### PF17

- **Rule:** Opening a plain note does not eagerly load every code-highlighting language.
- **Why / history:** !187 found a named CodeMirror chunk defeating lazy grammar imports; collapsing all grammars into one supposedly lazy chunk made them eager again through Markdown's HTML dependency. !188 separately curated the mobile set.
- **Evidence:** !187; !188; docs/spec/editor/performance.md.
- **Applies:** `slice 6`. **Check:** needs cold plain-note and first supported-code-language stories for the new highlighter.

### PF18

- **Rule:** Code coloring stops at an expensive block without making the code disappear or uneditable.
- **Why / history:** Milkdown leaves a fence over 20,000 characters uncolored and repaints only changed textblocks; loading grammars lazily alone does not bound highlighting work.
- **Evidence:** docs/spec/editor/performance.md; markdown-elements.md.
- **Applies:** `slice 6`. **Check:** needs a large-fence typing story and an explicit new-highlighter budget before carrying the exact old cutoff forward.

### PF19

- **Rule:** Progressive loading yields to interaction and reports its unfinished tail without starving completion.
- **Why / history:** Milkdown waits 150 ms after input, focus or pointer activity, caps continuous holds at one second, sizes its first chunk to 30–160 lines at about 1.5 viewports, and shows a status message.
- **Evidence:** docs/spec/editor/performance.md; !367.
- **Applies:** `later: progressive open`. **Check:** needs first-paint, sustained-typing, status and completed-tail stories; preserve the response goal and remeasure these tuning values.

### PF20

- **Rule:** Extracting tags or previews from a large note does not hang opening or typing.
- **Why / history:** !222 replaced a backreference-based inline-code scan that hung on multi-megabyte Markdown and bounded preview output; ec20162a5 had already removed full-note header-tag scans and needless decoration refreshes after autosave.
- **Evidence:** !222; ec20162a5; portable-core/tags.md.
- **Applies:** `slice 7`. **Check:** needs long unmatched-backtick and large-tag-header stories; engine tag queries stay off the per-keystroke path.
