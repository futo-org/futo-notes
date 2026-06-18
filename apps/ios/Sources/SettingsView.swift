import SwiftUI

/// App settings sheet (gear button in the note list). Mirrors the desktop
/// Settings surface (settings.md): a single "Self-hosted sync" row, appearance,
/// storage readout, crash reporting, about, and the danger-zone full reset.
/// Sync details/actions stay in SyncView — the Sync row just opens it.
struct SettingsView: View {
    @EnvironmentObject private var store: NotesStore
    @EnvironmentObject private var sync: SyncManager
    @Environment(\.dismiss) private var dismiss

    /// "light" | "dark" | "auto". Applied app-wide via preferredColorScheme in
    /// FutoNotesApp; the editor WebView follows automatically because
    /// NoteEditorView derives its pushed theme from @Environment(\.colorScheme).
    @AppStorage("futo.themeMode") private var themeMode = "auto"
    /// Crash-reporting prefs, read by CrashReporter's launch scan. Mirror the
    /// desktop prefs.crashReporting.{enabled,alwaysSend} pair.
    @AppStorage("futo.crashReporting.enabled") private var crashEnabled = true
    @AppStorage("futo.crashReporting.alwaysSend") private var crashAlwaysSend = false

    @State private var showSync = false
    /// Full reset is double-confirmed in place: first tap arms the button,
    /// second tap runs. Re-disarmed when the sheet goes away.
    @State private var resetArmed = false
    @State private var resetting = false

    var body: some View {
        NavigationStack {
            Form {
                // The whole Sync surface is one "Self-hosted sync" row: cloud
                // icon, connected-vs-local status, SYNCED/LOCAL badge. No
                // separate account header, no separate "Server" row
                // (settings.md). Tapping opens SyncView.
                Section("Sync") {
                    Button {
                        showSync = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: sync.connected ? "checkmark.icloud.fill" : "icloud")
                                .font(.title3)
                                .foregroundStyle(Theme.primary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Self-hosted sync")
                                    .foregroundStyle(.primary)
                                Text(sync.connected
                                    ? sync.status
                                    : "Notes stay on this device until you connect sync.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            syncBadge
                        }
                    }
                }

                Section("Appearance") {
                    Picker("Theme", selection: $themeMode) {
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                        Text("Auto").tag("auto")
                    }
                    .pickerStyle(.segmented)
                }

                Section("Storage") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Notes folder")
                        Text(store.notesRoot.path)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                Section("Crash reporting") {
                    Toggle("Share crash reports", isOn: $crashEnabled)
                    Toggle("Always send automatically", isOn: $crashAlwaysSend)
                        .disabled(!crashEnabled)
                }

                Section("About") {
                    Link("Open source",
                         destination: URL(string: "https://gitlab.futo.org/futo-notes/futo-notes")!)
                    HStack {
                        Text("Version")
                        Spacer()
                        Text(appVersion).foregroundStyle(.secondary)
                    }
                }

                Section("Danger zone") {
                    Button(role: .destructive) {
                        if resetArmed {
                            Task { await runFullReset() }
                        } else {
                            resetArmed = true
                        }
                    } label: {
                        Text(resetArmed
                            ? "Tap again to confirm — this cannot be undone!"
                            : "Full reset")
                    }
                    .disabled(resetting)
                    #if DEBUG
                    // On-device verification hook for the crash pipeline: traps
                    // (SIGTRAP) → the signal handler writes a .crashlogs report
                    // → next launch surfaces the Crash Report sheet.
                    Button(role: .destructive) {
                        fatalError("Test crash from Settings (DEBUG)")
                    } label: {
                        Text("Test crash")
                    }
                    #endif
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .tint(Theme.primary)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .disabled(resetting)
                }
            }
            .sheet(isPresented: $showSync) {
                SyncView()
                    .environmentObject(sync)
                    .environmentObject(store)
            }
            .onDisappear { resetArmed = false }
            .overlay {
                if resetting {
                    // Blocking overlay — no interaction until the wipe lands.
                    ZStack {
                        Color.black.opacity(0.45).ignoresSafeArea()
                        VStack(spacing: 12) {
                            ProgressView()
                            Text("Deleting all notes…").font(.headline)
                        }
                        .padding(24)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                    }
                }
            }
        }
        .interactiveDismissDisabled(resetting)
    }

    /// SYNCED / LOCAL pill shown on the single "Self-hosted sync" row.
    private var syncBadge: some View {
        Text(sync.connected ? "SYNCED" : "LOCAL")
            .font(.caption2.bold())
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(sync.connected ? Color.green : Color.secondary)
            .background(
                (sync.connected ? Color.green : Color.secondary).opacity(0.15),
                in: Capsule())
    }

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? "0.0.0"
    }

    /// Danger-zone full reset: pause live sync (no push of the deletions),
    /// wipe the vault root (notes, folders, images, .crashlogs), disconnect
    /// the sync session (clears the stored password), reload to empty.
    private func runFullReset() async {
        resetting = true
        sync.pauseLive()
        await store.fullReset()
        await sync.disconnect()
        resetting = false
        resetArmed = false
    }
}
