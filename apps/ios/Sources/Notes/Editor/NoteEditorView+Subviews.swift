import SwiftUI
import UIKit

extension NoteEditorView {
    var titleAndEditor: some View {
        VStack(spacing: 0) {
            // Backed by UITextField so tapping a still-placeholder title
            // ("Untitled"/"Untitled-N") selects it whole — a keystroke replaces
            // it — while a real title takes the caret at the tapped character.
            // Edits rename the file, debounced (scheduleRename). [list.md]
            TitleTextField(
                text: $titleField,
                placeholder: localization.localizedText("notes.untitledPlaceholder"),
                onChange: { handleTitleChange($0) },
                onForbidden: {
                    setTitleWarning(
                        LocalizedMessage("notes.title.forbiddenCharacter"),
                        transient: true
                    )
                }
            )
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, titleWarning == nil ? 6 : 2)
            if let warning = titleWarning {
                Text(localization.localizedText(warning.path, arguments: warning.arguments))
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            EditorWebView(
                noteId: loaded ? noteId : "",
                content: content,
                theme: theme,
                localization: localization,
                autoFocus: autoFocus,
                onChange: { receiveEditorChange($0) },
                onDocumentLoaded: { id in
                    guard loaded, id == noteId else { return }
                    let first = !documentReady
                    documentReady = true
                    if first {
                        scheduleOpenNoteReconciliation(openNoteChangeBuffer.finishInitialLoad())
                    }
                },
                onFocusChange: { focused in
                    editorFocused = focused
                    if openNoteReconciler.shouldReconcileAfterFocusChange(
                        isFocused: focused
                    ) {
                        scheduleOpenNoteReconciliation(.external)
                    }
                },
                onOpenNote: { id in
                    openLinkedNote(id)
                },
                onFindMatches: { report in
                    findQuery = report.query
                    findLabel = report.label
                },
                attachment: editorAttachmentSlot
            )
            // Measured INSIDE ignoresSafeArea: that is the WebView's RENDERED
            // bottom (the window's edge, or the keyboard's top when the IME is
            // up). Measured outside, SwiftUI reports the pre-expansion layout
            // frame instead — which shrinks by exactly the bar's height when the
            // bar appears and would report an overlay of zero.
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.frame(in: .global).maxY
            } action: { bottom in
                editorBottomGlobalY = bottom
                publishFindOverlayInset()
            }
            .ignoresSafeArea(.container, edges: .bottom)
        }
    }

    var noteActionsToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button {
                    openFind()
                } label: {
                    Label(
                        localization.localizedText("editor.find.open"),
                        systemImage: "magnifyingglass"
                    )
                }
                Button {
                    renameField = splitId(id: noteId).title
                    showRename = true
                } label: {
                    Label(
                        localization.localizedText("common.actions.rename"),
                        systemImage: "pencil"
                    )
                }
                Button {
                    prepareMove()
                } label: {
                    Label(
                        localization.localizedText("notes.actions.moveToFolderEllipsis"),
                        systemImage: "folder"
                    )
                }
                Button {
                    copyPath()
                } label: {
                    Label(
                        localization.localizedText("notes.actions.copyFilePath"),
                        systemImage: "doc.on.doc"
                    )
                }
                ShareLink(item: content) {
                    Label(
                        localization.localizedText("notes.actions.share"),
                        systemImage: "square.and.arrow.up"
                    )
                }
                Divider()
                Button(role: .destructive) {
                    presentWithoutAnimation { showDeleteConfirm = true }
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
            .disabled(interactionLocked)
        }
    }
}
