import SwiftUI

/// "a/b/c" → "a/b"; a top-level folder's parent is the root, "".
func parentPath(of path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return "" }
    return String(path[..<slash])
}

/// The book's folder column: the root and every folder, nested by indent. Picking one
/// shows its notes in the list beside it; a folder's context menu reaches the list's
/// rename, move and delete dialogs.
struct FolderColumn: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.localization) private var localization
    @Binding var selection: String
    @Binding var folderAction: FolderAction?
    let onSync: () -> Void
    let onSettings: () -> Void

    var body: some View {
        NavigationStack {
            List {
                row("", title: localization.localizedText("notes.heading"), icon: "tray.full")
                ForEach(Self.tree(store), id: \.self) { path in
                    row(
                        path, title: path.split(separator: "/").last.map(String.init) ?? path,
                        icon: "folder"
                    )
                    .contextMenu { menu(path) }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.surface)
            .navigationTitle(localization.localizedText("folders.heading"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(id: "folder-column-create-folder", placement: .topBarTrailing) {
                    Button {
                        presentWithoutAnimation { folderAction = .create }
                    } label: {
                        Image(systemName: "folder.badge.plus")
                    }
                    .tint(Theme.primary)
                    .accessibilityLabel(localization.localizedText("folders.newFolder"))
                    .accessibilityIdentifier("nav-create-folder")
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ShellFooter(onSync: onSync, onSettings: onSettings)
                .background(Theme.surface)
        }
    }

    /// Every folder, depth first, so children sit under their parent.
    static func tree(_ store: NotesStore, under parent: String = "") -> [String] {
        store.subfolders(of: parent).flatMap { [$0] + tree(store, under: $0) }
    }

    private func row(_ path: String, title: String, icon: String) -> some View {
        let selected = selection == path
        let depth = path.isEmpty ? 0 : path.split(separator: "/").count - 1
        return Button {
            selection = path
        } label: {
            HStack(spacing: 8) {
                // Orange marks the selection only; resting icons stay quiet.
                Image(systemName: icon)
                    .foregroundStyle(selected ? Theme.primary : Color(uiColor: .secondaryLabel))
                Text(title)
                    .fontWeight(selected ? .semibold : .regular)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(store.notes(in: path).count.formatted())
                    .font(.subheadline)
                    .foregroundStyle(Color(uiColor: .secondaryLabel))
                    .monospacedDigit()
            }
            .padding(.leading, CGFloat(depth) * 12)
            .contentShape(Rectangle())
        }
        .foregroundStyle(Color(uiColor: .label))
        .listRowBackground(selected ? Theme.selectionFill : Color.clear)
        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 10))
        .listRowSeparator(.hidden)
        .accessibilityIdentifier("folder-column:\(path)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder
    private func menu(_ path: String) -> some View {
        Button {
            presentWithoutAnimation { folderAction = .rename(path) }
        } label: {
            Label(localization.localizedText("common.actions.rename"), systemImage: "pencil")
        }
        Button {
            folderAction = .move(path)
        } label: {
            Label(
                localization.localizedText("folders.actions.moveToFolderEllipsis"),
                systemImage: "folder")
        }
        Button(role: .destructive) {
            presentWithoutAnimation { folderAction = .delete(path) }
        } label: {
            Label(
                localization.localizedText("folders.actions.deleteFolderEllipsis"),
                systemImage: "trash")
        }
    }
}

/// Sync state and Settings as a small borderless row: the folder column's footer, or the
/// list pane's (with New folder) when no folder column is showing.
struct ShellFooter: View {
    @EnvironmentObject private var sync: SyncManager
    @Environment(\.localization) private var localization
    let onSync: () -> Void
    let onSettings: () -> Void
    var onNewFolder: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 6) {
            Button(action: onSync) {
                Label(
                    localization.localizedText("sync.heading"),
                    systemImage: sync.connected ? "checkmark.icloud" : "icloud")
            }
            .accessibilityIdentifier("nav-sync")
            Spacer()
            if let onNewFolder {
                Button(action: onNewFolder) { Image(systemName: "folder.badge.plus") }
                    .padding(.trailing, 14)
                    .accessibilityLabel(localization.localizedText("folders.newFolder"))
                    .accessibilityIdentifier("nav-create-folder")
            }
            Button(action: onSettings) { Image(systemName: "gearshape") }
                .accessibilityLabel(localization.localizedText("settings.heading"))
                .accessibilityIdentifier("nav-settings")
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .font(.system(size: 15))
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .overlay(alignment: .top) { Divider() }
        .background(Theme.background)
    }
}

/// The editor pane with nothing open.
struct NoNoteSelectedView: View {
    @Environment(\.localization) private var localization
    let onNewNote: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(
                localization.localizedText("notes.list.ios.noNoteSelected"),
                systemImage: "note.text")
        } description: {
            Text(localization.localizedText("notes.list.ios.noNoteSelectedHint"))
        } actions: {
            Button(action: onNewNote) {
                Label(localization.localizedText("notes.newNote"), systemImage: "square.and.pencil")
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.primary)
            .accessibilityIdentifier("no-note-create")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .toolbar(.hidden, for: .navigationBar)
    }
}

/// A compact search field above a narrow list pane: `.searchable`'s drawer is an
/// oversized pill in a 300 pt column and costs a large title's height before the first row.
struct PaneSearchField: View {
    @Environment(\.localization) private var localization
    @Binding var text: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField(localization.localizedText("search.ios.placeholder"), text: $text)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(localization.localizedText("search.clearAccessibilityLabel"))
            }
        }
        .font(.system(size: 15))
        .padding(.horizontal, 8)
        .frame(height: 34)
        .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, 16)
        .padding(.top, 2)
        .padding(.bottom, 6)
        .accessibilityIdentifier("pane-search-field")
    }
}
