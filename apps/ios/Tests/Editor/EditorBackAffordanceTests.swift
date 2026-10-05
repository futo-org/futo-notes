import Foundation
import Testing

/// Anchors `Bundle(for:)` to the test bundle (see ServerUrlConformanceTests).
private final class BundleToken {}

/// Guards the invariant that broke once already: hiding the system back button
/// ALSO disables UIKit's finger-tracked interactive pop, which silently removed
/// swipe-back from the editor (0/2 edge swipes popped, vs 3/3 with the system
/// button shown). The editor keeps the system button and commits on the way out
/// in `finishLeave` instead of vetoing the exit.
///
/// This is a SOURCE SCAN (same shape as `BridgeCallSurfaceTests`): it reads
/// `NoteEditorView.swift`, so hiding the button again fails here instead of
/// shipping a note you cannot swipe out of.
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

    @Test("the editor keeps the system back button, and with it the native swipe")
    func systemBackButtonIsShown() throws {
        let source = try editorViewSource()
        #expect(
            !source.contains(".navigationBarBackButtonHidden("),
            "Hiding the back button disables the finger-tracked interactive pop gesture"
        )
    }

    @Test("a system pop commits through the session's navigate exit")
    func systemPopCommits() throws {
        let source = try editorViewSource()
        // The system pop never asks requestNavigation, so onDisappear must hand
        // it to finishLeave — which drains rename/move/adopt work and commits
        // the title and body exactly as requestNavigation does.
        let disappear = try #require(source.range(of: ".onDisappear {"))
        #expect(source[disappear.upperBound...].prefix(900).contains("finishLeave()"))

        let leave = try #require(source.range(of: "private func finishLeave()"))
        #expect(source[leave.upperBound...].prefix(400).contains(".navigate,"))
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
