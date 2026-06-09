import SwiftUI

/// Sync settings + actions sheet. Server URL + password, connect/sync/disconnect,
/// and live status. After a sync, reloads the note store to surface pulled notes.
struct SyncView: View {
    @EnvironmentObject private var sync: SyncManager
    @EnvironmentObject private var store: NotesStore
    @Environment(\.dismiss) private var dismiss

    /// In dev auth mode the server ignores the password; kept for password mode.
    @State private var password = "dev"

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Server URL", text: $sync.serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Password", text: $password)
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
                            store.reload()
                        }
                    } label: {
                        Label(sync.connected ? "Sync Now" : "Connect & Sync",
                              systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(sync.busy)

                    if sync.connected {
                        Button(role: .destructive) {
                            Task { await sync.disconnect() }
                        } label: {
                            Label("Disconnect", systemImage: "xmark.circle")
                        }
                        .disabled(sync.busy)
                    }
                }

                Section("Status") {
                    HStack {
                        if sync.busy { ProgressView() }
                        Text(sync.status)
                            .foregroundStyle(sync.connected ? .primary : .secondary)
                    }
                    if let err = sync.lastError {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Sync")
            .navigationBarTitleDisplayMode(.inline)
            .tint(Theme.primary)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
