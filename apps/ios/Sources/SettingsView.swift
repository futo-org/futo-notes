import SwiftUI

/// App settings sheet (gear button in the note list). Mirrors the desktop
/// Settings surface (settings.md): account/sync status, appearance, the
/// notes-are-files principle, storage readout, crash reporting, about, and the
/// danger-zone full reset. Sync details/actions stay in SyncView — rows here
/// just open it.
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
                accountHeader

                Section("Sync") {
                    Button {
                        showSync = true
                    } label: {
                        row(label: "Hosted sync", system: "arrow.triangle.2.circlepath",
                            value: sync.connected ? sync.status : "Off")
                    }
                    Button {
                        showSync = true
                    } label: {
                        row(label: "Server", system: "server.rack", value: sync.serverURL)
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

                Section("Editor") {
                    Text("Notes are Markdown files — file over app.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
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

    /// Account header: where the notes live + a SYNCED/LOCAL badge. Tapping
    /// opens the sync sheet (the iOS account surface).
    private var accountHeader: some View {
        Section {
            Button {
                showSync = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: sync.connected ? "checkmark.icloud.fill" : "iphone")
                        .font(.title2)
                        .foregroundStyle(Theme.primary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(sync.connected ? "Hosted sync" : "This device")
                            .font(.headline)
                            .foregroundStyle(.primary)
                        Text(sync.connected
                            ? sync.serverURL
                            : "Notes stay on this device until you connect sync.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Text(sync.connected ? "SYNCED" : "LOCAL")
                        .font(.caption2.bold())
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .foregroundStyle(sync.connected ? Color.green : Color.secondary)
                        .background(
                            (sync.connected ? Color.green : Color.secondary).opacity(0.15),
                            in: Capsule())
                }
            }
        }
    }

    @ViewBuilder
    private func row(label: String, system: String, value: String) -> some View {
        HStack {
            Label {
                Text(label).foregroundStyle(.primary)
            } icon: {
                Image(systemName: system).foregroundStyle(Theme.primary)
            }
            Spacer()
            Text(value)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
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
