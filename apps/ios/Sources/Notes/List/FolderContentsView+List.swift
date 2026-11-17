import SwiftUI

private struct FolderListItem: Identifiable {
    let path: String
    var id: String { ListRowID.folder(path) }
}

extension FolderContentsView {
    var list: some View {
        ScrollViewReader { proxy in
            rows
                .puppetVerbs {
                    navigation.sheet != nil
                        ? [] : [scrollToRowVerb(proxy, notes: { notes }, folders: { subfolders })]
                }
        }
    }

    private var rows: some View {
        List {
            if !subfolders.isEmpty, pane?.showsSubfolders ?? true {
                Section {
                    ForEach(subfolders.map { FolderListItem(path: $0) }) { item in
                        let child = item.path
                        folderLink(child) {
                            Label {
                                Text(child.split(separator: "/").last.map(String.init) ?? child)
                                    .font(.headline)
                            } icon: {
                                Image(systemName: "folder.fill")
                                    .foregroundStyle(Theme.primary)
                            }
                        }
                        .listRowBackground(
                            folderDeleteTarget == child ? Theme.folderDeleteTint : Theme.surface
                        )
                        .accessibilityIdentifier(ListRowID.folder(child))
                        // This action only asks for confirmation. A destructive
                        // role makes List animate removal even on a button tap.
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button {
                                setFolderDeleteTarget(child)
                            } label: {
                                Label(
                                    localization.localizedText(
                                        "folders.actions.deleteFolderEllipsis"
                                    ),
                                    systemImage: "trash"
                                )
                            }
                            .tint(Theme.danger)
                        }
                        .contextMenu { folderMenu(child) }
                    }
                }
            }
            if !notes.isEmpty {
                Section {
                    // One branch around the whole ForEach, never inside a row: a row whose
                    // type is conditional makes List build every row to count them.
                    if let pane {
                        ForEach(notes, id: \.listRowID) { note in
                            noteRow(
                                note,
                                Button {
                                    pane.open(.note(note.id))
                                } label: {
                                    NoteRow(note: note, showFolder: false)
                                }
                                .foregroundStyle(Color(uiColor: .label)))
                        }
                    } else {
                        ForEach(notes, id: \.listRowID) { note in
                            noteRow(
                                note,
                                NavigationLink(value: Route.note(note.id)) {
                                    NoteRow(note: note, showFolder: false)
                                })
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    /// A folder's rename, move and delete actions: its row's context menu.
    @ViewBuilder
    private func folderMenu(_ child: String) -> some View {
        Button {
            setFolderRenameTarget(child)
        } label: {
            Label(
                localization.localizedText("common.actions.rename"),
                systemImage: "pencil"
            )
        }
        Button {
            folderMoveTarget = child
        } label: {
            Label(
                localization.localizedText(
                    "folders.actions.moveToFolderEllipsis"
                ),
                systemImage: "folder"
            )
        }
        Button(role: .destructive) {
            setFolderDeleteTarget(child)
        } label: {
            Label(
                localization.localizedText(
                    "folders.actions.deleteFolderEllipsis"
                ),
                systemImage: "trash"
            )
        }

    }

    /// A subfolder row: pushes the folder on the phone, picks it in place in a pane.
    @ViewBuilder
    private func folderLink<Content: View>(
        _ child: String, @ViewBuilder label: () -> Content
    ) -> some View {
        if let pane {
            Button {
                pane.selectFolder(child)
            } label: {
                label()
            }
            .foregroundStyle(Color(uiColor: .label))
        } else {
            NavigationLink(value: Route.folder(child), label: label)
        }
    }

    /// A note row's background, identity, swipe actions and menu, around its link.
    private func noteRow<Link: View>(_ note: NoteItem, _ link: Link) -> some View {
        link
            .listRowBackground(
                arrivedNoteIDs.contains(note.id)
                    ? Theme.folderArrivalTint
                    : pane?.openNoteId == note.id ? Theme.selectionFill : Theme.surface
            )
            .accessibilityIdentifier(ListRowID.note(note.id))
            // Keep the row in place until deletion is confirmed.
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button {
                    setDeleteTarget(note)
                } label: {
                    Label(
                        localization.localizedText("common.actions.delete"),
                        systemImage: "trash"
                    )
                }
                .tint(Theme.danger)
                Button {
                    moveTarget = note
                } label: {
                    Label(
                        localization.localizedText("common.actions.move"),
                        systemImage: "folder"
                    )
                }
                .tint(Theme.primary)
            }
            .contextMenu {
                Button {
                    moveTarget = note
                } label: {
                    Label(
                        localization.localizedText(
                            "notes.actions.moveToFolderEllipsis"
                        ),
                        systemImage: "folder"
                    )
                }
                Button(role: .destructive) {
                    setDeleteTarget(note)
                } label: {
                    Label(
                        localization.localizedText("common.actions.delete"),
                        systemImage: "trash"
                    )
                }
            }
    }

    var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: folder.isEmpty ? "note.text" : "folder")
                .font(.system(size: 56))
                .foregroundStyle(Theme.primary)
            Text(
                folder.isEmpty
                    ? localization.localizedText("notes.list.rootEmptyHeading")
                    : localization.localizedText("notes.list.folderEmptyHeading")
            )
            .font(.title2.bold())
            Text(localization.localizedText("notes.list.ios.emptyActionHint"))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
