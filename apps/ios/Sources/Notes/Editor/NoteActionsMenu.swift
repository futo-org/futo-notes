import SwiftUI
import UIKit

/// Both iOS editors offer the same note actions; each supplies its attachment's workflows.
struct NoteActionsMenu: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.localization) private var localization
    let noteId: String
    let content: () -> String
    let find: () -> Void
    let rename: () -> Void
    let move: () -> Void
    let delete: () -> Void

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
            ShareLink(item: content()) {
                Label(
                    localization.localizedText("notes.actions.share"),
                    systemImage: "square.and.arrow.up"
                )
            }
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
    }
}
