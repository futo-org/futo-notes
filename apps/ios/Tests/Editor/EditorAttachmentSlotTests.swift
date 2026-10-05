import SwiftUI
import Testing
import UIKit

@testable import FutoNotesNative

/// RC-77: the token an editor reads the shared WebView through must be there
/// the moment the editor is on screen.
///
/// `EditorWebView` reports it from its first adopt, which runs inside
/// `makeUIView` — a SwiftUI view update, where a `@State` write is discarded.
/// When `NoteEditorView` kept the token in `@State`, it read back nil on every
/// open (iOS 27.0), so a system pop committed the shell's copy without reading
/// the editor and dropped whatever the editor had not reported yet.
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
