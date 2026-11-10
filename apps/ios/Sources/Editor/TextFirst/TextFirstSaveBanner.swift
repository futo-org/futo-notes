#if FUTO_DEBUG_BUILD
    import SwiftUI

    /// Whether the engine's last save attempt failed: the draft is still in memory and still
    /// being retried (a failure never pauses input).
    @MainActor
    final class TextFirstSaveModel: ObservableObject {
        @Published var failed = false
    }

    /// Persistent save feedback that leaves the editor usable while the user decides: retry now,
    /// or discard the unsaved edits (after a confirmation). Mirrors Android's `TextFirstSaveError`.
    struct TextFirstSaveBanner: View {
        @ObservedObject var model: TextFirstSaveModel
        let localization: Localization
        let retry: () -> Void
        let discard: () -> Void

        var body: some View {
            if model.failed {
                VStack(alignment: .leading, spacing: 2) {
                    Text(localization.localizedText("notes.save.failedPending"))
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                        .accessibilityIdentifier("text-first-save-error")
                    HStack {
                        Button(localization.localizedText("notes.save.retry"), action: retry)
                            .accessibilityIdentifier("text-first-save-retry")
                        Button(
                            localization.localizedText("notes.save.discard"), role: .destructive,
                            action: discard
                        )
                        .accessibilityIdentifier("text-first-save-discard")
                    }
                    .font(.callout)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.bottom, 4)
                .accessibilityElement(children: .contain)
            }
        }
    }
#endif
