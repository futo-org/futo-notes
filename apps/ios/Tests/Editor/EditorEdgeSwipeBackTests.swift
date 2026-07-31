import Testing
import UIKit

@testable import FutoNotesNative

/// Guards the editor's leading-edge swipe-back. The editor hides the system back
/// button so every exit runs through the gated `requestNavigation`, and hiding
/// that button also disables UIKit's interactive pop — so this gesture IS
/// swipe-back on the editor screen. If its classification regresses, "I can't
/// swipe back from a note" comes straight back. See EditorEdgeSwipeBack.
@Suite("Editor edge swipe-back")
struct EditorEdgeSwipeBackTests {

    // A slow drag: too little velocity to qualify as a flick, so only distance
    // can carry it. NOT zero — `gestureRecognizerShouldBegin` requires
    // |vx| > |vy| for the pan to begin at all, so a zero-velocity translation is
    // a state the classifier never actually sees.
    private let slow = CGPoint(x: 40, y: 5)

    @Test("accepts a deliberate rightward drag")
    func acceptsDeliberateDrag() {
        #expect(isBackSwipe(translation: CGPoint(x: 90, y: 10), velocity: slow))
        #expect(isBackSwipe(translation: CGPoint(x: 60, y: 0), velocity: slow))
    }

    @Test("accepts a short rightward flick")
    func acceptsShortFlick() {
        // A quick flick is how the system gesture feels; distance alone would
        // reject this.
        #expect(isBackSwipe(translation: CGPoint(x: 25, y: 5), velocity: CGPoint(x: 900, y: 40)))
    }

    @Test("rejects a drag that is too short and too slow")
    func rejectsShortSlowDrag() {
        #expect(!isBackSwipe(translation: CGPoint(x: 25, y: 5), velocity: slow))
        // A flick needs SOME distance too, so a tap-with-jitter never pops.
        #expect(!isBackSwipe(translation: CGPoint(x: 4, y: 1), velocity: CGPoint(x: 900, y: 0)))
    }

    @Test("a mostly vertical drag never even begins the gesture")
    func verticalDragNeverBegins() {
        // The distance-only branch would accept this translation, so the reason a
        // scroll-shaped drag is safe is `gestureRecognizerShouldBegin`, not the
        // classifier. Documented here so the two halves are not read in isolation.
        #expect(isBackSwipe(translation: CGPoint(x: 90, y: 40), velocity: CGPoint(x: 30, y: 800)))
        #expect(!shouldBeginBackSwipe(velocity: CGPoint(x: 30, y: 800)))
        #expect(shouldBeginBackSwipe(velocity: CGPoint(x: 800, y: 30)))
    }

    @Test("rejects a leftward drag")
    func rejectsLeftwardDrag() {
        #expect(!isBackSwipe(translation: CGPoint(x: -120, y: 0), velocity: CGPoint(x: -900, y: 0)))
    }

    @Test("rejects a mostly vertical drag so scrolling still wins")
    func rejectsVerticalDrag() {
        // The strip overlays the note body; a drag that means "scroll" must not
        // navigate away from the note.
        #expect(
            !isBackSwipe(translation: CGPoint(x: 70, y: 200), velocity: CGPoint(x: 200, y: 900)))
        #expect(!isBackSwipe(translation: CGPoint(x: 0, y: -300), velocity: CGPoint(x: 0, y: -900)))
    }

    @Test("the capture strip stays inside the editor's text margin")
    func stripCoversMarginOnly() {
        // 14px --futo-cm-pad-inline + 6px from .cm-line. A wider strip would eat
        // taps meant to place the caret at the start of a line.
        #expect(EditorEdgeSwipeBack.stripWidth == 20)
    }

    @MainActor
    @Test("installs a pan recognizer that consults the begin rule")
    func installsPanRecognizer() throws {
        let strip = EdgeSwipeCaptureView()
        let recognizer = try #require(strip.gestureRecognizers?.first as? UIPanGestureRecognizer)

        // Outside a live touch a real recognizer reports zero velocity, so the
        // ambiguous case must not be claimed.
        #expect(strip.gestureRecognizerShouldBegin(recognizer) == false)
    }

    @MainActor
    @Test("reports a back swipe through its callback")
    func reportsSwipeThroughCallback() {
        let strip = EdgeSwipeCaptureView()
        var reported = 0
        strip.onSwipeBack = { reported += 1 }

        strip.onSwipeBack?()

        #expect(reported == 1)
    }
}
