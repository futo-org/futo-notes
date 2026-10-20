### Containment is OFF on Apple WebKit (2026-08-31, the outstanding iOS leg)

WKWebView does not merely render the rule differently — it drops text on the floor. Scrolling a
40-paragraph note in the real iOS app, recorded off the simulator's display pipeline (`xcrun simctl
io recordVideo`, so no screenshot could force a repaint and hide it), left **seven frames whose
topmost visible paragraph was mid-document with 127–327 px of blank above it**: the previous
paragraph kept its box in the flow and painted nothing, and the hole stayed while the view was
still, filling in on some later scroll. That is the user report "some text will appear to be gone
and then mysteriously re-appear".

Nothing on the page can see it: the DOM reports every block present at full height, and
`checkVisibility({ contentVisibilityAuto: true })` calls them all visible. It does not reproduce in
Playwright's WebKit (whose scrolling is not the async, tiled iOS one) or in Chromium — this is the
UI-process compositor.

So the rule is engine-gated rather than dropped (`src/features/editor/milkdown/blockContainment.ts`,
applied as `.futo-milkdown.block-containment`): Chromium — Android's WebView, where §5's budgets
were measured, and every desktop/web surface — keeps it, and Apple WebKit renders every block
eagerly. iOS therefore has no containment perf property, and if keystroke cost at real note sizes
ever needs one there, it has to come from something WebKit paints correctly (an
IntersectionObserver-driven window that sets `content-visibility: visible` well before a block
enters the viewport is the obvious candidate — it never asks WebKit to decide relevance for
on-screen content). Blank text is not a trade worth making for a perf budget.

The measurement is repeatable: the OCR oracle counts frames whose visible paragraph numbers skip
one, or that start mid-note with a band of blank above the first line (0 after the gate, 7 before).

> **Open item (Android), carried to #111:** on the phone, the FIRST `scrollIntoView` to the far end of a 10k-line note
> lands ~350 px short and leaves the caret's block just below the fold; a second scroll against the
> settled layout reaches it. The cause is inherent to the containment rule: blocks render as the
> scroll approaches them, each 24 px estimate is replaced by its real height, and the content grows
> underneath a scroll that was computed against the estimates (scrollHeight moved 184,209 → 184,405
> mid-scroll). Desktop chromium needs no second pass. The runner gates on the settled state — what a
> user is actually left looking at — and reports the first-scroll result beside it, so a regression
> in either is visible. Whether the editor should issue that corrective scroll itself is a product
> question for the swap (#111), not a harness one.
