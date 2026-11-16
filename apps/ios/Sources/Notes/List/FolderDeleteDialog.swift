import SwiftUI

/// The delete-a-folder card: an alert-look-alike hosted in a transparent `fullScreenCover`
/// (see `DestructiveConfirmDialog` for why not `.confirmationDialog`). An empty folder gets a
/// plain Cancel | Delete. A folder with notes asks first, in one tap, whether its notes are
/// kept; "Delete folder and notes…" morphs the SAME card into a second step that lists what
/// will be lost, with a Delete all that arms 0.6 s after it appears.
///
/// Drawn with shapes and materials rather than the iOS 26 glass alert, so it looks alike on
/// the iOS 18 floor. `onFolderOnly` and `onDeleteAll` are the whole act, like
/// `DestructiveConfirmDialog.onDestructive`: a puppet verb answers once it has finished.
struct FolderDeleteDialog: View {
    /// The folder's own name, for the title.
    let folderName: String
    /// Titles of every note in the folder and below it, in list order.
    let noteTitles: [String]
    let onCancel: () -> Void
    let onFolderOnly: () async -> Void
    let onDeleteAll: () async -> Void

    @Environment(\.localization) private var localization
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var shown = false
    @State private var step = 1
    @State private var armed = false
    @State private var heights: [Int: CGFloat] = [:]

    private var count: Int { noteTitles.count }
    private static let listed = 3
    private static let armDelay: Duration = .milliseconds(600)

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(shown ? 0.18 : 0)
                    .ignoresSafeArea()
                card(maxHeight: geometry.size.height * 0.9)
                    .frame(width: 306)
                    .scaleEffect(shown || reduceMotion ? 1 : 1.14)
                    .opacity(shown ? 1 : 0)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear {
            withAnimation(
                reduceMotion
                    ? .easeOut(duration: 0.18) : .spring(response: 0.34, dampingFraction: 0.78)
            ) { shown = true }
        }
        // Armed 0.6 s after step 2 shows, so a double-tap on step 1's button cannot land on it.
        .task(id: step) {
            armed = false
            guard step == 2 else { return }
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            try? await Task.sleep(for: Self.armDelay)
            if !Task.isCancelled { armed = true }
        }
        .puppetVerbs(modal: true) { verbs }
    }

    // MARK: Card

    private func card(maxHeight: CGFloat) -> some View {
        let height = min(heights[step] ?? heights[1] ?? 200, maxHeight)
        return ScrollView {
            ZStack(alignment: .top) {
                if count == 0 {
                    pane(1) { emptyPane }
                } else if step == 1 {
                    pane(1) { choosePane }
                        .transition(.opacity)
                } else {
                    pane(2) { confirmPane }
                        .transition(.opacity)
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: height)
        .background(
            RoundedRectangle(cornerRadius: 34, style: .continuous).fill(.regularMaterial)
        )
        .clipShape(RoundedRectangle(cornerRadius: 34, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 34, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.18), radius: 25, y: 18)
        .onPreferenceChange(PaneHeightKey.self) { heights.merge($0) { $1 } }
    }

    /// One step's content, reporting its natural height so the card can spring to it.
    private func pane<Content: View>(_ id: Int, @ViewBuilder _ content: () -> Content)
        -> some View
    {
        content()
            .padding(.top, 22)
            .padding(.horizontal, 18)
            .padding(.bottom, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: PaneHeightKey.self, value: [id: proxy.size.height])
                })
    }

    private var title: String {
        localization.localizedText(
            "folders.delete.namedTitle", arguments: ["folderName": folderName])
    }

    private func heading(_ text: String, message: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(.system(.body, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 6)
    }

    // MARK: Panes

    private var emptyPane: some View {
        VStack(alignment: .leading, spacing: 20) {
            heading(title, message: localization.localizedText("folders.delete.emptyMessage"))
            sideBySide {
                Button {
                    onCancel()
                } label: {
                    pillLabel(
                        localization.localizedText("common.actions.cancel"), color: .primary,
                        weight: .regular)
                }
                .buttonStyle(PillStyle(fill: Self.grayFill))
                .accessibilityIdentifier("folder-delete-cancel")
                Button {
                    Task { await onFolderOnly() }
                } label: {
                    pillLabel(
                        localization.localizedText("common.actions.delete"), color: Theme.danger,
                        weight: .semibold)
                }
                .buttonStyle(PillStyle(fill: Self.grayFill))
                .accessibilityIdentifier("folder-delete-confirm")
            }
        }
    }

    private var choosePane: some View {
        VStack(alignment: .leading, spacing: 20) {
            heading(
                title,
                message: localization.localizedText(
                    "folders.delete.keptNotesMessage", arguments: ["count": count]))
            VStack(spacing: 8) {
                Button {
                    Task { await onFolderOnly() }
                } label: {
                    pillLabel(
                        localization.localizedText("folders.delete.folderOnly"),
                        color: Self.preferredText(colorScheme), weight: .semibold)
                }
                .buttonStyle(PillStyle(fill: Theme.primary.opacity(0.15)))
                .accessibilityIdentifier("folder-delete-only")
                Button {
                    advance(to: 2)
                } label: {
                    pillLabel(
                        localization.localizedText("folders.delete.folderAndNotes"),
                        color: Theme.danger, weight: .regular)
                }
                .buttonStyle(PillStyle(fill: Self.grayFill))
                .accessibilityIdentifier("folder-delete-and-notes")
                Button {
                    onCancel()
                } label: {
                    pillLabel(
                        localization.localizedText("common.actions.cancel"), color: .primary,
                        weight: .regular)
                }
                .buttonStyle(PillStyle(fill: Self.grayFill))
                .accessibilityIdentifier("folder-delete-cancel")
            }
        }
    }

    private var confirmPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                Circle().fill(Self.badgeFill(colorScheme))
                Image(systemName: "trash")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(Theme.danger)
            }
            .frame(width: 40, height: 40)
            .padding(.leading, 6)
            .padding(.bottom, 12)
            .transition(
                reduceMotion
                    ? .opacity : .scale(scale: 0.6, anchor: .center).combined(with: .opacity))
            heading(
                localization.localizedText(
                    "folders.delete.notesTitle", arguments: ["count": count]),
                message: localization.localizedText(
                    "folders.delete.notesWarning", arguments: ["folderName": folderName]))
            lostList
                .padding(.top, 14)
            sideBySide {
                Button {
                    advance(to: 1)
                } label: {
                    pillLabel(
                        localization.localizedText("common.actions.back"), color: .primary,
                        weight: .regular)
                }
                .buttonStyle(PillStyle(fill: Self.grayFill))
                .accessibilityIdentifier("folder-delete-back")
                Button {
                    Task { await onDeleteAll() }
                } label: {
                    pillLabel(
                        localization.localizedText("folders.delete.deleteAll"), color: .white,
                        weight: .semibold)
                }
                .buttonStyle(PillStyle(fill: Theme.danger))
                .accessibilityIdentifier("folder-delete-all")
                .disabled(!armed)
                .opacity(armed ? 1 : 0.4)
                .animation(.easeOut(duration: 0.25), value: armed)
            }
            .padding(.top, 20)
        }
    }

    private var lostList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(noteTitles.prefix(Self.listed).enumerated()), id: \.offset) { _, name in
                row(icon: "doc", text: name, secondary: false)
            }
            if count > Self.listed {
                row(
                    icon: "ellipsis",
                    text: localization.localizedText(
                        "folders.delete.andMore", arguments: ["count": count - Self.listed]),
                    secondary: true)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Self.grayFill.opacity(0.57))
        )
    }

    private func row(icon: String, text: String, secondary: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(width: 18)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(secondary ? .secondary : .primary)
                .lineLimit(2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    // MARK: Pieces

    /// Two pills side by side, stacked once Dynamic Type leaves no room for both.
    private func sideBySide<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { content() }
            VStack(spacing: 8) { content() }
        }
    }

    /// A pill's label. The Button sits at each call site so the puppet gate can read the
    /// catalog key it is labelled with.
    private func pillLabel(
        _ text: String, color: Color = .primary, weight: Font.Weight = .regular
    ) -> some View {
        Text(text)
            .font(.system(.body, weight: weight))
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(color)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 48)
    }

    private func advance(to next: Int) {
        withAnimation(
            reduceMotion
                ? .easeInOut(duration: 0.2) : .spring(response: 0.42, dampingFraction: 0.82)
        ) {
            step = next
        }
    }

    private static let grayFill = Color(hex: 0x787880, alpha: 0.14)

    private static func preferredText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0xFF9A5C) : Color(hex: 0xC2510F)
    }

    private static func badgeFill(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Theme.danger.opacity(0.28) : Color(hex: 0xFDE3E3)
    }

    // MARK: Puppet

    private var verbs: [PuppetVerbs.Verb] {
        if count == 0 {
            return [
                PuppetVerbs.Verb("ConfirmDialog", controls: ["common.actions.delete"]) {
                    await onFolderOnly()
                },
                PuppetVerbs.Verb("DismissDialog", controls: ["common.actions.cancel"]) {
                    onCancel()
                },
            ]
        }
        if step == 1 {
            return [
                PuppetVerbs.Verb("DeleteFolderOnly", controls: ["folders.delete.folderOnly"]) { _ in
                    await onFolderOnly()
                    return ["deleted": "folder", "keptNotes": count]
                },
                PuppetVerbs.Verb(
                    "DeleteFolderAndNotes", controls: ["folders.delete.folderAndNotes"]
                ) { _ in
                    advance(to: 2)
                    return ["step": 2, "notes": count]
                },
                PuppetVerbs.Verb("DismissDialog", controls: ["common.actions.cancel"]) {
                    onCancel()
                },
            ]
        }
        return [
            PuppetVerbs.Verb("DeleteAllNotes", controls: ["folders.delete.deleteAll"]) { _ in
                guard armed else {
                    throw PuppetVerbRefusal(409, "Delete all is not armed yet; retry in 0.6 s")
                }
                await onDeleteAll()
                return ["deleted": "folder and notes", "deletedNotes": count]
            },
            PuppetVerbs.Verb("BackToChoice", controls: ["common.actions.back"]) { _ in
                advance(to: 1)
                return ["step": 1]
            },
        ]
    }
}

private struct PaneHeightKey: PreferenceKey {
    static let defaultValue: [Int: CGFloat] = [:]
    static func reduce(value: inout [Int: CGFloat], nextValue: () -> [Int: CGFloat]) {
        value.merge(nextValue()) { $1 }
    }
}

private struct PillStyle: ButtonStyle {
    let fill: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 24, style: .continuous).fill(fill)
                    .overlay(
                        RoundedRectangle(cornerRadius: 24, style: .continuous)
                            .fill(Color(hex: 0x787880, alpha: configuration.isPressed ? 0.14 : 0)))
            )
            .contentShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}
