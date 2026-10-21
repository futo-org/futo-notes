import SwiftUI

struct FindInNoteBar: View {
    @Binding var query: String
    let label: String
    let onQueryChange: (String) -> Void
    let onStep: (Int) -> Void
    let onClose: () -> Void

    @Environment(\.localization) private var localization
    @FocusState private var fieldFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onClose) {
                Image(systemName: "checkmark")
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 46, height: 46)
                    .foregroundStyle(.white)
                    .background(Theme.primary, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(localization.localizedText("editor.find.close"))

            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.secondary)

                // A find query is matched literally against note text, so the
                // keyboard must not shape it: autocapitalization turned typed
                // "example" into "Example" on device, and autocorrect can
                // silently rewrite a query into one that matches nothing.
                TextField(localization.localizedText("editor.find.queryHint"), text: $query)
                    .textFieldStyle(.plain)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($fieldFocused)
                    .submitLabel(.search)
                    .onSubmit { onStep(1) }
                    .onChange(of: query) { _, value in onQueryChange(value) }
                    .onKeyPress(.return, phases: .down) { press in
                        guard press.modifiers.contains(.shift) else { return .ignored }
                        onStep(-1)
                        return .handled
                    }
                    .accessibilityLabel(localization.localizedText("editor.find.queryLabel"))

                Text(label)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()

                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(localization.localizedText("editor.find.clearQuery"))
                }
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 46)
            .background(Theme.surface, in: Capsule())

            HStack(spacing: 0) {
                Button {
                    onStep(-1)
                } label: {
                    Image(systemName: "chevron.up")
                        .frame(width: 42, height: 46)
                }
                .accessibilityLabel(localization.localizedText("editor.find.previousMatch"))

                Button {
                    onStep(1)
                } label: {
                    Image(systemName: "chevron.down")
                        .frame(width: 42, height: 46)
                }
                .accessibilityLabel(localization.localizedText("editor.find.nextMatch"))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .background(Theme.surface, in: Capsule())
        }
        .task { fieldFocused = true }
    }
}
