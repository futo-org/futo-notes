# iOS swipe-back on the editor screen

Postmortem for a reported "I can't swipe back from a note!" on the native iOS
app, 2026-07-24. Two wrong theories were pursued before the real cause; both
dead ends are recorded so the next person skips them.

## The bug

Swiping from the leading screen edge in the note editor did nothing. The Back
chevron worked.

## Root cause

`NoteEditorView` sets `.navigationBarBackButtonHidden(true)` and supplies its own
chevron, added in `09456c00 fix(native): close navigation and migration races` so
that every exit runs through `requestNavigation` (drain in-flight rename/move/
adoption, drain the save, capture the freshest WebView content, and REFUSE to
leave while a rename cannot commit).

**Hiding the system back button also disables UIKit's interactive pop gesture.**
That is the whole bug. Measured on the iOS 26.5 simulator, same build otherwise:

| `navigationBarBackButtonHidden` | edge swipe pops |
| --- | --- |
| `true` (shipped) | 0 / 2 |
| `false` (probe) | 3 / 3 |

## The WebView is NOT the cause

This is the important correction, because it looks like a WebKit problem and
isn't. With the system back button restored, the native interactive pop worked
over the unmodified full-bleed `WKWebView`. WebKit deliberately carves the
navigation pop gesture out of its deferring machinery.

WebKit only matters for a CUSTOM recognizer: a `UIScreenEdgePanGestureRecognizer`
added to the editor's container view never fires at all — not one state
transition, and its delegate is never consulted for any gesture pair. The
`WKContentView` carries 7+ `WKDeferringGestureRecognizer`s that defer competing
UIKit recognizers until the page's own touch handling resolves, and a custom
recognizer gets no carve-out. Worse, it still outranks the system pop gesture, so
adding one BREAKS swipe-back in the cases that previously worked.

Consequence: any custom back-gesture must live in a view that sits ABOVE the web
view, so the touch never reaches WebKit.

## Dead end 1 — `require(toFail:)` on the web scrollers

Theory: the `WKChildScrollView` backing CM6's `.cm-scroller` wins the touch, so
make its pan defer to `interactivePopGestureRecognizer`.

Why it failed: the child scroller does not exist yet at
`didMoveToWindow`/`layoutSubviews` time. Instrumenting the walk showed it finding
exactly **1** scroll pan on every call — the OUTER `WKScrollView`, whose scrolling
is deliberately disabled and which therefore never competes. WebKit creates the
child scroller lazily as content lays out, and there is no native signal for that
moment. Pre-wiring recognizer instances cannot work here.

## Dead end 2 — own edge recognizer on the container

Theory: own the gesture, and use `shouldBeRequiredToFailBy` so the decision is
made at gesture time instead of wiring instances up front (which sidesteps dead
end 1 correctly).

Why it failed: see "the WebView is NOT the cause" — deferred into oblivion by
WebKit, while still suppressing the system gesture. It made a working case fail.

## Misleading evidence to distrust

The first round of probing ran against a **stale installed build** (older `main`,
before `09456c00`). There, clean horizontal edge swipes popped 7/7 while diagonal
swipes and swipes during momentum failed — which reads as a gesture-arbitration
bug and sent the investigation down dead end 1. Those failures were ordinary iOS
behaviour, not the reported bug.

Lesson: **install the build you are diagnosing before drawing conclusions**, and
re-run the baseline after every install. Once the reverted build ALSO failed the
case that had passed, the regression was obviously not in the working tree.

Also note `idb ui swipe` sends perfectly straight synthetic drags, which pass
where a real thumb fails. A synthetic pass is not a real pass.

## The fix

`EditorEdgeSwipeBack.swift`: a 20pt transparent strip over the editor's leading
edge (matching the editor's own text inset, so it covers margin rather than
tappable text) owning a `UIPanGestureRecognizer`, routed through the same
`requestNavigation` verb as the Back button. It sits inside the existing
`allowsHitTesting` gate, so an in-flight mutation disables the swipe exactly as it
disables the button.

Two costs, both inherent to the approach rather than incidental:

- The pop is animated but not finger-tracked. Going fully native means showing
  the system back button, which forfeits the ability to veto an exit — a native
  interactive pop cannot be refused once it begins.
- The strip consumes EVERY touch in that column, not just back-swipes. A clear
  overlay hit-tests true, and hit-testing happens before any movement exists to
  classify, so a vertical drag started inside the strip neither scrolls the note
  nor reaches WebKit, and a tap there no longer places the caret. Keeping the
  strip at the editor's text inset (20pt) is what bounds the damage to margin.

Whether to trade the veto for the native gesture — which would also retire the
strip and both costs — is tracked in FUTO Notes issue #69.
