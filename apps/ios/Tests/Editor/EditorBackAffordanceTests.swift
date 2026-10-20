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
/// `NoteEditorView.swift` and its `NoteEditorView+*.swift` extensions, so
/// hiding the button again fails here instead of shipping a note you cannot
/// swipe out of.
@Suite("Editor back affordance")
struct EditorBackAffordanceTests {
    /// `NoteEditorView.swift` plus its extensions, bundled as a resource by the
    /// test target's postCompileScripts (Xcode's resource phase refuses to copy `.swift`).
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

        let leave = try #require(source.range(of: "func finishLeave()"))
        #expect(source[leave.upperBound...].prefix(400).contains(".navigate,"))
    }

    @Test("the pop is never gated on the commit: finishLeave cannot suspend")
    func finishLeaveNeverBlocksThePop() throws {
        let source = try editorViewSource()
        let leave = try #require(source.range(of: "func finishLeave()"))
        // A function that is not `async` cannot await, so this one check is
        // the whole guarantee: the drain and commit run in the closures it
        // hands the session and in its detached Task, all after the pop. An
        // async finishLeave would turn a committed pop into a wait the user
        // sees, the cost Android's Back pays (NoteEditorScreen.navigateAfterSaving).
        #expect(
            !source[leave.lowerBound...].prefix(40).contains("async"),
            "finishLeave must stay synchronous: the system pop has already happened when it runs"
        )
    }

    @Test("Back never waits on the commit: only the wikilink push goes through requestNavigation")
    func onlyTheWikilinkPushWaitsBeforeNavigating() throws {
        let source = try editorViewSource()
        // requestNavigation drains the bridge, the disk write and the rename
        // BEFORE it navigates. That wait is right for a push (it can still be
        // refused and the editor stays put), and wrong for Back: a Back routed
        // through it holds the user on the editor for a bridge round trip and
        // a flush, which is what Android's Back pays and iOS must not.
        let calls = source.components(separatedBy: "requestNavigation {").count - 1
        #expect(
            calls == 1, "requestNavigation has \(calls) callers; Back must pop first (finishLeave)")
        let push = try #require(source.range(of: "func openLinkedNote("))
        let pushBody = source[push.upperBound...].prefix(300)
        #expect(
            pushBody.contains("requestNavigation {"), "the one caller must be the wikilink push")
    }

    @Test("the visible find close control always closes the shared engine")
    func findCloseIsNotBlockedByLifecycleOwnership() throws {
        let source = try editorViewSource()
        #expect(
            source.contains("onClose: { dismissFind() }"),
            "The native close control must use the visible-editor dismissal path"
        )

        let dismiss = try #require(source.range(of: "func dismissFind()"))
        let dismissBody = source[dismiss.upperBound...].prefix(240)
        #expect(dismissBody.contains("EditorHost.shared.closeFind()"))
        #expect(
            !dismissBody.contains("isCurrentAttachment"),
            "A user dismisses the visible editor; only off-screen lifecycle cleanup is ownership-gated"
        )
    }
}
