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

    private func move(to destination: String) {
        Task {
            if await store.moveFolder(from: folder, destinationParent: destination) != nil {
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
            } else {
                store.showTransient(LocalizedMessage("folders.errors.moveFailed"))
            }
        }
        dismiss()
    }
}
