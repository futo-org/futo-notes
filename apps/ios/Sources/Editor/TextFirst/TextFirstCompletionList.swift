#if FUTO_DEBUG_BUILD
    import SwiftUI

    /// Wikilink suggestions above the keyboard toolbar. Inline, so choosing one never moves focus
    /// away from the text view; every candidate and the claim are the engine's.
    struct TextFirstCompletionList: View {
        @ObservedObject var model: TextFirstCompletionModel
        let localization: Localization
        let accept: (String) -> Void
        let dismiss: () -> Void

        var body: some View {
            if let found = model.completion, !found.candidates.isEmpty {
                HStack(alignment: .top, spacing: 0) {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(found.candidates, id: \.noteId) { candidate in
                                Button {
                                    accept(candidate.noteId)
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(candidate.label).foregroundStyle(.primary)
                                        if let detail = candidate.detail {
                                            Text(detail).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 8)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier(
                                    "text-first-completion-\(candidate.noteId)")
                            }
                        }
                    }
                    .frame(maxHeight: 144)
                    Button(localization.localizedText("common.actions.close")) { dismiss() }
                        .foregroundStyle(.secondary)
                        .padding(8)
                }
                .background(Theme.background)
                .overlay(alignment: .top) { Divider() }
            }
        }
    }
#endif
