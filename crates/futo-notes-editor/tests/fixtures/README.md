# Structural seam fixtures

`structural-seams.json` contains fifty-two hand-worked synthetic public-interface
regressions for #296 and #297. The original thirty-eight objects remain an exact
byte prefix. These are source/display/history/caret oracles, not actual
OS captures. Ranges and carets use native UTF-16 code units. `history` counts Undo
steps, which can exceed the accepted source-record count for composition plus
following input. The editor owner tests retain the original red regressions;
store, FFI, compiled WASM, Swift and Kotlin consume these literals unchanged.

An unchanged explicit following run can move selection without adding history
after a changed marked commit. Its optional `redoCaret` records that Redo restores
the marked commit's caret, separately from the subsequent selection-only result.

The real UIKit callback evidence remains under `tests/fixtures/editor-native-input`.

The selected-source cases distinguish a whole explicit replacement that owns a
lower setext body and its boundary from a body-only replacement that retains the
heading. They include CRLF with untouched entity-spelled neighbors and explicit
input after unchanged raw marking; they do not change OS changed-run discovery.

The typing-history cases supply an `inputs` sequence of action/text pairs at each
returned caret, with optional carried Bold or Code. Ordinary input keeps one
adjacent typing group through quote repair or divider insertion; an explicitly
isolated first input keeps two. The same family covers a whitespace typing run
that enters quote repair. Fixed-clock editor/store tests own the exact timing
and failed-acceptance boundaries; thin consumers use the normal session clock.

Fenced-code regression literals live in `../fences/`, driven through the public
session and independent display-only reference view. The existing WASM block
consumer and Swift/Kotlin block suites cover code/language semantics, Unicode
Enter, Tab/Shift+Tab and the code-block command through real store recovery.
They add no platform Markdown policy. The fourteen added structural-seam literals cover empty quoted code input/Enter,
nested CRLF, selected whole-body and authored terminal-break deletion, literal
tilde/wider-backtick typing, the existing triple-backtick shortcut, composition,
OS/explicit input, adjacent ordinary typing and CommonMark-attributed literal
nonclosers. Existing store/FFI/WASM/Swift/Kotlin
consumers read the same hand-reviewed literals.

Fence display follows the pinned shipping code schema's mdast `code.value`: one
terminal ending terminates the frame and additional blank lines are code text.
The schema's Markdown runner passes that value directly into the code text node;
`editor-embed-milkdown-interactive-code-blocks.spec.ts` independently names a
multiline node without the frame LF. New #297 EOF display expectations were
corrected against that authority; exact source oracles and historical red logs
remain intact. `../fences/frame.rs` and `../fences/basis.rs` lock the frame/body
ownership, fresh-open agreement and exact history through public sessions.
