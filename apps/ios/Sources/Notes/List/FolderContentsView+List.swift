import SwiftUI

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
            if !subfolders.isEmpty {
                Section {
                    ForEach(subfolders, id: \.self) { child in
                        NavigationLink(value: Route.folder(child)) {
                            Label {
                                Text(child.split(separator: "/").last.map(String.init) ?? child)
                                    .font(.headline)
                            } icon: {
                                Image(systemName: "folder.fill")
                                    .foregroundStyle(Theme.primary)
                            }
                        }
                        .listRowBackground(Theme.surface)
                        .id(ListRowID.folder(child))
                        .accessibilityIdentifier(ListRowID.folder(child))
                        // allowsFullSwipe off: a destructive full swipe animates
                        // the row away even though we only show a confirmation.
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
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
                        .contextMenu {
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
                    }
                }
            }
            if !notes.isEmpty {
                Section {
                    ForEach(notes) { note in
                        NavigationLink(value: Route.note(note.id)) {
                            NoteRow(note: note, showFolder: false)
                        }
                        .listRowBackground(Theme.surface)
                        .id(ListRowID.note(note.id))
                        .accessibilityIdentifier(ListRowID.note(note.id))
                        // allowsFullSwipe off — see the folder rows above.
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                setDeleteTarget(note)
                            } label: {
                                Label(
                                    localization.localizedText("common.actions.delete"),
                                    systemImage: "trash"
                                )
                            }
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
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
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
