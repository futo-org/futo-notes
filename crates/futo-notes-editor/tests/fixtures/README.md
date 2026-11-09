# Structural seam fixtures

`structural-seams.json` and `fence-physical-rows.json` contain sixty-nine hand-worked synthetic public-interface
regressions for #296 and #297. The original thirty-five objects (the thirty-eight less the three Indent-created
nested-quote seams) remain an exact byte prefix. These are source/display/history/caret oracles, not actual
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

`list-actions.json` retains twenty-four hand-worked synthetic public-interface
regressions for #298; `list-shortcuts.json` adds thirty-eight literal shortcut boundary
controls, including newline-terminated empty bodies that temporarily inherit a preceding
list owner after prefix removal, and multiple transparent blank paragraphs on either side. All consumers assert both family counts. `range`, optional
`selection`, `composeRange`, `resultRange` and `undoRanges` use native UTF-16 units.
`expected`/`shown` are exact final source/display literals. Default history has one
Undo to `source`/`display`/initial selection; optional `undoSources`, `undoDisplays`
and `undoRanges` describe every intermediate group. Composition plus checkbox
shares one protected acceptance and retains two Undo groups. `finalItems` gives
literal `[interpreted ordinal or null, checked state or null]` pairs for the final
first lines at depth one; `quoteDepth` defaults to zero. Consumers also request
the EOF caret slice so a zero-width final item is checked. No expected value is
derived from a Markdown parser. The original thirty-eight seam literals remain
unchanged.

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
remain intact. `../fences/frame.rs` locks the frame/body
ownership, fresh-open agreement and exact history through public sessions.

The twelve physical-row literals cover authored blank CRLF, valid unmatched EOF
carets, selected internal LF/CRLF replacement, exact surviving prefixes, shifted
Unicode origins and composition through the same public transports. The last two cases distinguish
parser-stripped fence indentation on blank CRLF from authored spaces. The original
fifty-two-object structural fixture remains entirely byte-identical; the twelve
physical-row literals live separately to stay within the file-size gate. Public `physical_rows.rs` adds a
finite endpoint basis, source/UTF-16 round trips, selection echoes, rejection,
Undo/Redo and fresh projection comparison; store fence tests exercise real
append/Undo faults, resume/retry, replay, checkpoint and reopen.

Eight appended source-identity literals preserve differing internal blank-row prefixes
through raw identical input, explicit unchanged runs, an unchanged run before a
later changed run, and explicit empty-run acceptance. Existing explicit consumers
forward optional `replacements` verbatim; no caller rediscovery of run identity occurs.

Twelve `list-staging.json` literals add multiline bold/underscore list commands,
unchanged/changed marked-text commands and typing, nested marked-text plus inline
seams, and LF/CRLF boundaries. The original 24 actions and 38 shortcuts remain
byte-identical. All six consumers include this file separately. Optional
`compositionText` supplies raw marked text independently of a later Typing `text`;
`composeRange` requests marking for any action. Changed marking and the command
share one protected acceptance but retain their separate literal Undo groups.
Store and real-WASM acceptance retain the same rejection/retry/history/recovery
checks. Native fixture source is not proof that its current native binaries ran.

Twenty-four `nested-containers.json` literals cover Indent and Outdent as line-start
tab edits, same-line empty parents, physical columns/tabs, nested Backspace/Enter,
ancestor-preserving retargets and full Text/Heading transitions. Twenty-seven `container-commands.json` literals and fourteen `list-header-commands.json` literals
add full list lifting across one/two quotes and selection beginning in an ancestor
while keeping its descendant listed, bare-quote versus heading/list quote ancestry,
and independent mixed-format run transitions. Ordered task retargets preserve their
existing start, raw delimiter and tab padding while clearing checkbox state. Mixed
ordered child lifting copies that start into each newly independent following owner.
Same-line quote/list controls retain empty lifted paragraphs, physical CRLF and quote
prefixes, raw nonidentity entity atoms and native UTF-16 interior carets. Task-body
quote/heading punctuation stays literal. Together with the unchanged original seventy-four
list cases, all six source consumers load 191 cases, including twenty-four
`prefix-frame-commands.json` literals. These distinguish registered Backspace
from full Text lifting. Unchanged implicit empty parents
keep compact source; an action-created parallel paragraph gets a physical frame.
A newly empty shared bullet header uses the existing alternate-marker policy
only when its old spelling would become a thematic break. Original sixty-nine structural
seams remain separate and unchanged. `itemDepths` overrides each first item's default
list depth of one; `itemQuoteDepths` overrides that item's global `quoteDepth` default.
These are hand-worked source/display/native UTF-16/history literals, not native OS input
or latency evidence. Store consumers retain rejection, paused retry, rejected Undo,
one protected record, flush, modeled power loss, recovery and checkpoint/reopen checks.
Source fixture registration does not establish that current native binaries ran.

Twenty-three `fence-container-commands.json` literals preserve canonical fence containment
while a root list item is promoted. A necessary closer retains delimiter width,
language and line endings; existing closers, real EOF and a surviving inner
quote boundary stay distinct. Code leaf indentation and opaque blank spaces/tabs
survive container-column retirement. Wide tabbed task retargets use the content
column before the checkbox for continuations, code and nested child lists.

The four quote-owner boundary literals preserve separate inner-code and foreign
quote owners in LF and CRLF source. A missing physical blank gains one matching
line ending; an authored gap is retained without duplication. Exact staged
windows need original complete-item authority independently of physical EOF.

Eight multiline paragraph literals extend the prefix-frame family with the
already-observed registered Backspace and full Text transitions.
Explicit and lazy body prefixes, outer quotes, wide tabbed headers and CRLF
remain exact; the action-created empty paragraphs differ by intent. The three
CRLF entity controls hand-map native UTF-16 ranges: a selected endpoint after
the first decoded scalar is unit one (byte three), and its new CRLF frame
moves it to unit three (byte five). Backspace retains its start caret.

Fourteen final mutation literals add nine fence-family cases and five
`heading-quote-commands.json` cases.
They preserve a preceding listed paragraph with one necessary blank, authored
blank/empty/opaque predecessors without new blank normalization, continuation
and two code fences with only the final necessary closer, and existing nested
code blank spaces under Text and Heading. The quoted CRLF task pair keeps actual
tab columns, code language and child/following ownership. The final Heading/Quote
mutations use the existing plain/same-quote/cross-quote contexts. A following
nonempty bullet/ordered-one item interrupts a quote itself; ordered-seven needs
a real quote-scope blank and retains its exact marker/start. Two quoted Quote
no-op cases remain separate public session tests: no fake append/history is used
to force them through this mutation/recovery harness.

One additional shared-frame literal retains the representable root empty paragraph
when full Text retires a shared physical list/quote header chain. The surviving
quote ancestry and body reopen from ordinary Markdown; transient leading empty
paragraphs inside quotes are not written, as required by the existing paragraph
rules. The public shared-head work probe varies actual canonical groups8/64 and
body4096/32768, checks source/caret/UndoRedo first, and retains the existing parser,
source-copy and metadata budgets. It does not claim allocation or native latency.

The three-group crossquote Text atom literal retains `&acE;` unchanged and maps
native UTF-16 unit1 to unit2 after the root newline. Its strict interior position
is valid between the decoded scalars, including when they form one grapheme.
The public session regression also checks both affinities, rejected acceptance
and exact Undo/Redo; all six consumers use the same literal mutation.

Generic list editing (DECISIONS #20) updated these goldens on 2026-11-01: an edited
list item may be respelled canonically while every untouched row keeps its bytes, and
fifty-four cases whose shapes the generic path does not respell (quotes opening inside
an item's own line, crossquote lifting, same-line nested parents, unclosed fences in a
lifted item, setext headings) carry `"refused": true`. Their `expected`/`shown` keep the
historical literals for reference; every consumer instead asserts `UnrepresentableFormat`
with source and revision unchanged.
