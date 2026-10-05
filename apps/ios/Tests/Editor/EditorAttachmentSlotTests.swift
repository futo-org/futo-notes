import SwiftUI
import Testing
import UIKit

@testable import FutoNotesNative

@MainActor
@Suite("Editor attachment slot", .serialized)
struct EditorAttachmentSlotTests {
    /// The shape `NoteEditorView` has: the slot in the host view's `@State`,
    /// handed to the editor, read back later by the host itself.
    private struct Host: View {
        @State private var slot = EditorAttachmentSlot()
        let onAppeared: (Int?) -> Void

        var body: some View {
            EditorWebView(
                noteId: "test-note",
                content: "",
                theme: "light",
                localization: Localization.system(
                    requestedLanguageTags: ["en"], regionalLanguageTag: "en-US"),
                onChange: { _ in },
                attachment: slot
            )
            // Read once the editor has settled on screen, as an exit would.
            .task {
                try? await Task.sleep(for: .milliseconds(300))
                onAppeared(slot.token)
            }
        }
    }

    @Test("an editor on screen can name its attachment")
    func attachmentIsReadableOnceOnScreen() async throws {
        let windowScene = try #require(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let window = UIWindow(windowScene: windowScene)
        var appeared: Int?? = nil
        window.rootViewController = UIHostingController(
            rootView: Host(onAppeared: { appeared = .some($0) }))
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }

        let deadline = ContinuousClock.now + .seconds(5)
        while appeared == nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        let reported = try #require(appeared, "the host never appeared")
        let token = try #require(reported, "the attachment read back nil with the editor on screen")
        #expect(EditorHost.shared.isCurrentAttachment(token))
    }
}
