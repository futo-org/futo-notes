import SwiftUI
import UIKit

/// Both iOS editors offer the same note actions; each supplies its attachment's workflows.
struct NoteActionsMenu: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.localization) private var localization
    let noteId: String
    let content: () async -> String?
    let find: () -> Void
    let rename: () -> Void
    let move: () -> Void
    let delete: () -> Void
    @State private var share: SharedContent?
    @State private var readingShare = false

    var body: some View {
        Menu {
            Button {
                find()
            } label: {
                Label(
                    localization.localizedText("editor.find.open"),
                    systemImage: "magnifyingglass"
                )
            }
            Button {
                rename()
            } label: {
                Label(
                    localization.localizedText("common.actions.rename"),
                    systemImage: "pencil"
                )
            }
            Button {
                move()
            } label: {
                Label(
                    localization.localizedText("notes.actions.moveToFolderEllipsis"),
                    systemImage: "folder"
                )
            }
            Button {
                let path = store.notePath(noteId)
                UIPasteboard.general.string = path
                PuppetVerbs.shared.recordCopy(path)
            } label: {
                Label(
                    localization.localizedText("notes.actions.copyFilePath"),
                    systemImage: "doc.on.doc"
                )
            }
            Button {
                readingShare = true
                Task { @MainActor in
                    defer { readingShare = false }
                    if let text = await content() {
                        share = SharedContent(text: text)
                    } else {
                        store.showTransient(LocalizedMessage("notes.navigation.unflushed"))
                    }
                }
            } label: {
                Label(
                    localization.localizedText("notes.actions.share"),
                    systemImage: "square.and.arrow.up"
                )
            }
            .disabled(readingShare)
            Divider()
            Button(role: .destructive) {
                delete()
            } label: {
                Label(
                    localization.localizedText("notes.actions.deleteNote"),
                    systemImage: "trash"
                )
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel(
            localization.localizedText("notes.actions.moreAccessibilityLabel")
        )
        .tint(Theme.primary)
        .sheet(item: $share) { item in
            NoteShareSheet(text: item.text)
        }
    }
}

private struct SharedContent: Identifiable {
    let id = UUID()
    let text: String
}

private struct NoteShareSheet: UIViewControllerRepresentable {
    let text: String

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [text], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
