import SwiftUI

/// Sync settings + actions sheet. Server URL + password, connect/sync/disconnect,
/// and live status. `SyncManager` owns post-cycle projection for every trigger.
struct SyncView: View {
    @EnvironmentObject private var sync: SyncManager
    @EnvironmentObject private var store: NotesStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.localization) private var localization

    /// Seeded from the Keychain so the masked field reflects the REAL saved
    /// password (its true length), not a fixed placeholder — and so a manual
    /// reconnect resubmits the correct password instead of a stale default.
    /// Empty when nothing is stored (first connect / after disconnect). Because
    /// SyncView is a fresh `.sheet` value each presentation, this initializer
    /// re-runs and re-seeds on every open. Only used on the not-connected
    /// reconnect path — the field is hidden once connected (the in-memory Rust
    /// session already holds the unwrapped vault key; `Sync Now` ignores it).
    @State private var password = Keychain.syncPassword ?? ""

    var body: some View {
        NavigationStack {
            Form {
                Section(localization.localizedText("sync.serverSection")) {
                    // Once connected the server URL is LOCKED (sync.md) — an
                    // edit here writes straight through @Published→UserDefaults
                    // (disconnect() never resets it) and would silently feed
                    // the next connectAndSync/healCollectionGone. Mirrors
                    // Android's `enabled = !sync.connected` (SyncScreen.kt).
                    // Dimmed while disabled so it reads as non-editable — a
                    // disabled TextField keeps primary-colored text otherwise.
                    TextField(localization.localizedText("sync.serverUrl"), text: $sync.serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .disabled(sync.connected)
                        .foregroundStyle(sync.connected ? .secondary : .primary)
                    // Only relevant before connecting: once connected the Rust
                    // session holds the vault key and Sync Now ignores this field.
                    if !sync.connected {
                        SecureField(localization.localizedText("sync.password"), text: $password)
                    }
                }

                // Before connecting, point the user at how to get a server
                // (sync.md): a link to the FUTO Notes server repo.
                if !sync.connected {
                    Section {
                        Link(
                            destination: URL(
                                string: "https://gitlab.futo.org/futo-notes/futo-notes-server")!
                        ) {
                            Label(
                                localization.localizedText("sync.serverSetupLink"),
                                systemImage: "arrow.up.forward.square"
                            )
                            .font(.subheadline)
                        }
                    }
                }

                Section {
                    Button {
                        Task {
                            if sync.connected {
                                await sync.syncNow()
                            } else {
                                await sync.connectAndSync(
                                    notesRoot: store.notesRoot.path, password: password)
                            }
                        }
                    } label: {
                        Label(
                            sync.connected
                                ? localization.localizedText("sync.syncNow")
                                : localization.localizedText("sync.connectAndSync"),
                            systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(sync.busy)

                    if sync.connected {
                        Button(role: .destructive) {
                            Task { await sync.disconnect() }
                        } label: {
                            Label(
                                localization.localizedText("sync.disconnect"),
                                systemImage: "xmark.circle"
                            )
                        }
                        .disabled(sync.busy)
                    }
                }

                Section(localization.localizedText("sync.statusSection")) {
                    HStack {
                        if sync.busy { ProgressView() }
                        Text(sync.localizedStatus(localization))
                            .foregroundStyle(sync.connected ? .primary : .secondary)
                    }
                    // Real pull/push failures only — shown in alarming red.
                    if let err = sync.localizedLastError(localization) {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    // Live-stream health (e.g. a server without SSE, or a
                    // transient stream drop) is NOT a sync failure — the loop
                    // reconnects with backoff and the safety poll still runs.
                    // Shown muted so it doesn't read as "your sync broke".
                    if let live = sync.localizedLiveError(localization) {
                        Text(live)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                // Which on-disk folder this install reads/writes. Surfaced so a
                // "synced but no notes" report is self-diagnosing: distinct app
                // installs (dev vs release vs custom bundle ids) use SEPARATE
                // sandboxes, so notes pulled by one install never appear in
                // another. This row makes the active sandbox visible at a glance.
                Section(localization.localizedText("sync.notesFolderSection")) {
                    Text(store.notesRoot.path)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
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
    }
}
