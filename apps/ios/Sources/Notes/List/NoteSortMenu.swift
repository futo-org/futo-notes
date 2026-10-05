import SwiftUI

struct NoteSortMenu: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.localization) private var localization

    var body: some View {
        Menu {
            Section {
                ForEach([NoteSortKey.name, NoteSortKey.lastModified], id: \.self) { key in
                    choice(
                        localization.localizedText(NoteSortPreference.keyLabelPath(key)),
                        selected: store.sortOrder.key == key,
                        order: NoteSortPreference.withKey(key, keepingPositionOf: store.sortOrder)
                    )
                }
            } header: {
                // Text, not Label: iOS drops a section header's image.
                Text(localization.localizedText("notes.sort.heading"))
            }
            Section {
                ForEach(NoteSortPreference.directions(for: store.sortOrder.key), id: \.self) {
                    direction in
                    choice(
                        localization.localizedText(
                            NoteSortPreference.directionLabelPath(store.sortOrder.key, direction)
                        ),
                        selected: store.sortOrder.direction == direction,
                        order: NoteSortOrder(key: store.sortOrder.key, direction: direction)
                    )
                }
            } header: {
                Text(localization.localizedText("notes.sort.orderHeading"))
            }
        } label: {
            Image("SortDescending")
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .menuActionDismissBehavior(.disabled)
        .menuOrder(.fixed)
        .tint(Theme.primary)
        .accessibilityLabel(localization.localizedText("notes.sort.heading"))
        .accessibilityIdentifier("note-sort-btn")
    }

    private func choice(_ title: String, selected: Bool, order: NoteSortOrder) -> some View {
        Toggle(
            title,
            isOn: Binding(
                get: { selected },
                set: { turnedOn in
                    if turnedOn { store.setSortOrder(order) }
                }
            )
        )
        .accessibilityIdentifier("note-sort-\(NoteSortPreference.rawValue(order))")
    }
}
