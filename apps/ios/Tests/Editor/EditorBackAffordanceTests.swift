import Foundation
import Testing

/// Anchors `Bundle(for:)` to the test bundle (see ServerUrlConformanceTests).
private final class BundleToken {}

/// Guards the invariant that actually broke: `NoteEditorView` hides the system
/// back button so every exit runs through `requestNavigation`, and hiding it
/// ALSO disables UIKit's interactive pop gesture — which silently removed
/// swipe-back from the editor (0/2 edge swipes popped, vs 3/3 with the system
/// button restored).
///
/// The gesture classifier has its own unit tests, but those pass whether or not
/// the gesture is wired into the view. This is a SOURCE SCAN (same shape as
/// `BridgeCallSurfaceTests`): it reads `NoteEditorView.swift` and asserts that
/// hiding the back button and providing our own back-swipe travel together, so
/// deleting the overlay fails here instead of shipping a note you cannot swipe
/// out of.
@Suite("Editor back affordance")
struct EditorBackAffordanceTests {
    /// `NoteEditorView.swift`, bundled as a resource by the test target's
    /// postCompileScripts (Xcode's resource phase refuses to copy `.swift`).
    private func editorViewSource() throws -> String {
        let bundle = Bundle(for: BundleToken.self)
        let url = try #require(
            bundle.url(forResource: "NoteEditorView", withExtension: "txt"),
            "NoteEditorView.txt missing from the test bundle — see project.yml postCompileScripts"
        )
        return try String(contentsOf: url, encoding: .utf8)
    }

    @Test("hiding the system back button comes with our own back-swipe")
    func hiddenBackButtonHasSwipeAffordance() throws {
        let source = try editorViewSource()

        // Precondition. If this stops matching, the editor has stopped hiding the
        // system back button — the native interactive pop is then back and the
        // strip may be redundant (issue #69). Re-read this suite's doc comment
        // rather than deleting the assertion below.
        #expect(
            source.contains(".navigationBarBackButtonHidden(true)"),
            "Editor no longer hides the system back button — revisit the swipe strip (issue #69)"
        )

        // Matches the CONSTRUCTION, not the name: a passing mention in a comment
        // must not satisfy this (it did, the first time this test was written).
        #expect(
            source.contains("EditorEdgeSwipeBack {"),
            "Hiding the back button disables the interactive pop gesture, so the editor MUST supply its own leading-edge back-swipe"
        )
    }

    @Test("the back-swipe uses the same gated exit as the Back button")
    func swipeRoutesThroughTheGatedExit() throws {
        let source = try editorViewSource()

        // The swipe must not become the one exit that skips requestNavigation:
        // that verb drains in-flight rename/move/adopt work and captures the live
        // body out of the WebView before leaving.
        let overlay = try #require(
            source.range(of: "EditorEdgeSwipeBack {"),
            "Expected the swipe overlay to be built with a trailing closure"
        )
        let closureTail = source[overlay.upperBound...].prefix(200)

        #expect(
            closureTail.contains("requestNavigation"),
            "The back-swipe must route through requestNavigation, not pop navPath directly"
        )
    }

    @Test("the visible find close control always closes the shared engine")
    func findCloseIsNotBlockedByLifecycleOwnership() throws {
        let source = try editorViewSource()
        #expect(
            source.contains("onClose: { dismissFind() }"),
            "The native close control must use the visible-editor dismissal path"
        )

        let dismiss = try #require(source.range(of: "private func dismissFind()"))
        let dismissBody = source[dismiss.upperBound...].prefix(240)
        #expect(dismissBody.contains("EditorHost.shared.closeFind()"))
        #expect(
            !dismissBody.contains("isCurrentAttachment"),
            "A user dismisses the visible editor; only off-screen lifecycle cleanup is ownership-gated"
        )
    }
}
