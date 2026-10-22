import SwiftUI

/// Sync settings + actions sheet.
///
/// With hosted sync compiled in this leads with "Log in with FUTO" and
/// discloses today's self-hosted fields below it; with the flag off it IS
/// today's self-hosted screen and nothing else exists (ADR 0003, decision 13).
/// Either way `SyncManager` owns post-cycle projection for every trigger.
struct SyncView: View {
    @EnvironmentObject private var sync: SyncManager
    @EnvironmentObject private var store: NotesStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.localization) private var localization

    var body: some View {
        NavigationStack {
            Group {
                // The hosted screen owns its Form: the scanner it pushes has to be
                // declared outside the Form's rows to be pushed at all.
                if HostedSyncBuild.isEnabled {
                    HostedSyncSections(notesRoot: store.notesRoot.path, store: store, sync: sync)
                } else {
                    Form {
                        SelfHostedSyncSections()
                        NotesFolderSection()
                    }
                }
            }
            .navigationTitle(localization.localizedText("sync.heading"))
            .navigationBarTitleDisplayMode(.inline)
            .tint(Theme.primary)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(localization.localizedText("common.actions.done")) { dismiss() }
                }
            }
        }
        // The wizard's confirmations (a copied recovery key) are transient
        // banners, and a banner attached to the presenting screen renders
        // BEHIND this sheet — invisible. It belongs to whatever is on top.
        .transientMessageBanner(store)
    }
}

/// Which on-disk folder this install reads/writes. Surfaced so a "synced but no
/// notes" report is self-diagnosing: distinct app installs (dev vs release vs
/// custom bundle ids) use SEPARATE sandboxes, so notes pulled by one install
/// never appear in another. This row makes the active sandbox visible at a glance.
struct NotesFolderSection: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.localization) private var localization

    var body: some View {
        Section(localization.localizedText("sync.notesFolderSection")) {
            Text(store.notesRoot.path)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }
}
