import SwiftUI

struct MoveFolderSheet: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.localization) private var localization

    let folder: String

    private var sourceParent: String {
        guard let slash = folder.lastIndex(of: "/") else { return "" }
        return String(folder[..<slash])
    }

    private var destinations: [String] {
        store.folders.filter { path in
            path != folder && !path.hasPrefix(folder + "/")
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        move(to: "")
                    } label: {
                        rowLabel(
                            text: localization.localizedText("folders.root"),
                            system: "house.fill",
                            isCurrent: sourceParent.isEmpty
                        )
                    }
                    .accessibilityIdentifier(ListRowID.folder(""))
                }
                if !destinations.isEmpty {
                    Section(localization.localizedText("folders.heading")) {
                        ForEach(destinations, id: \.self) { path in
                            Button {
                                move(to: path)
                            } label: {
                                rowLabel(
                                    text: path,
                                    system: "folder.fill",
                                    isCurrent: sourceParent == path)
                            }
                            .accessibilityIdentifier(ListRowID.folder(path))
                        }
                    }
                }
            }
            .navigationTitle(
                localization.localizedText(
                    "folders.moveNamedHeading",
                    arguments: [
                        "folderName": folder.split(separator: "/").last.map(String.init) ?? folder
                    ]
                )
            )
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(localization.localizedText("common.actions.cancel")) { dismiss() }
                        .tint(Theme.primary)
                }
            }
        }
        .puppetVerbs(modal: true) {
            moveSheetVerbs(
                offering: destinations, of: store.folders,
                pick: { destination in await move(to: destination).value },
                cancel: { dismiss() })
        }
    }

    @ViewBuilder
    private func rowLabel(text: String, system: String, isCurrent: Bool) -> some View {
        HStack {
            Label {
                Text(text).foregroundStyle(.primary)
            } icon: {
                Image(systemName: system).foregroundStyle(Theme.primary)
            }
            Spacer()
            if isCurrent {
                Image(systemName: "checkmark")
                    .foregroundStyle(Theme.primary)
            }
        }
    }

    /// Starts the move and closes the sheet; the task answers whether the move landed.
    @discardableResult
    private func move(to destination: String) -> Task<Bool, Never> {
        let moving = Task { () async -> Bool in
            guard await store.moveFolder(from: folder, destinationParent: destination) != nil
            else {
                store.showTransient(LocalizedMessage("folders.errors.moveFailed"))
                return false
            }
            if destination.isEmpty {
                store.showTransient(LocalizedMessage("folders.movedToRoot"))
            } else {
                store.showTransient(
                    LocalizedMessage(
                        "folders.movedTo",
                        arguments: ["destination": destination]
                    )
                )
            }
            return true
        }
        dismiss()
        return moving
    }
}
