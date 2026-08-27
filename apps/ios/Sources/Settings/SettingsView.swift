import SwiftUI

/// App settings sheet (gear button in the note list). Mirrors the desktop
/// Settings surface (settings.md): a single "Self-hosted sync" row, appearance,
/// storage readout, issue reporting, about, and the danger-zone full reset.
/// Sync details/actions stay in SyncView — the Sync row just opens it.
struct SettingsView: View {
    private let issueTrackerURL = URL(string: "https://github.com/futo-org/futo-notes/issues")!

    @EnvironmentObject private var store: NotesStore
    @EnvironmentObject private var sync: SyncManager
    @Environment(\.dismiss) private var dismiss
    @Environment(\.localization) private var localization

    /// "light" | "dark" | "auto". Applied app-wide by FutoNotesApp's
    /// appearanceOverride; the editor WebView follows automatically because
    /// NoteEditorView derives its pushed theme from @Environment(\.colorScheme).
    @AppStorage(ThemeMode.storageKey) private var themeMode = ThemeMode.auto.rawValue
    /// Crash-reporting prefs, read by CrashReporter's launch scan. Mirror the
    /// desktop prefs.crashReporting.{enabled,alwaysSend} pair.
    @AppStorage("futo.crashReporting.enabled") private var crashEnabled = true
    @AppStorage("futo.crashReporting.alwaysSend") private var crashAlwaysSend = false

    @State private var showSync = false
    /// Full reset is guarded by a modal confirmation dialog: tapping the row
    /// opens it, and only confirming there runs the wipe. (The old in-place
    /// two-tap arm/confirm was removed — a stray double-tap wiped everything
    /// too easily.)
    @State private var showResetConfirm = false
    @State private var resetting = false

    var body: some View {
        NavigationStack {
            Form {
                // The whole Sync surface is one "Self-hosted sync" row: cloud
                // icon, connected-vs-local status, SYNCED/LOCAL badge. No
                // separate account header, no separate "Server" row
                // (settings.md). Tapping opens SyncView.
                Section(localization.localizedText("settings.sections.sync")) {
                    Button {
                        showSync = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: sync.connected ? "checkmark.icloud.fill" : "icloud")
                                .font(.title3)
                                .foregroundStyle(Theme.primary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(localization.localizedText("settings.sync.selfHosted"))
                                    .foregroundStyle(.primary)
                                Text(
                                    sync.connected
                                        ? sync.localizedStatus(localization)
                                        : localization.localizedText("settings.sync.localDescription")
                                )
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            }
                            Spacer()
                            syncBadge
                        }
                    }
                }

                Section(localization.localizedText("settings.sections.appearance")) {
                    Picker(
                        localization.localizedText("settings.appearance.theme"), selection: $themeMode
                    ) {
                        Text(localization.localizedText("settings.appearance.light"))
                            .tag(ThemeMode.light.rawValue)
                        Text(localization.localizedText("settings.appearance.dark"))
                            .tag(ThemeMode.dark.rawValue)
                        Text(localization.localizedText("settings.appearance.auto"))
                            .tag(ThemeMode.auto.rawValue)
                    }
                    .pickerStyle(.segmented)
                }

                Section(localization.localizedText("settings.sections.storage")) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(localization.localizedText("settings.storage.notesFolder"))
                        Text(store.notesRoot.path)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                Section(localization.localizedText("settings.sections.issueReporting")) {
                    Toggle(
                        localization.localizedText("settings.issueReporting.shareCrashReports"),
                        isOn: $crashEnabled
                    )
                    Toggle(
                        localization.localizedText("settings.issueReporting.sendAutomatically"),
                        isOn: $crashAlwaysSend
                    )
                        .disabled(!crashEnabled)
                    Link(destination: issueTrackerURL) {
                        HStack {
                            Text(localization.localizedText("settings.issueReporting.reportIssue"))
                            Spacer()
                            Image(systemName: "arrow.up.right")
                        }
                    }
                }

                Section(localization.localizedText("settings.sections.about")) {
                    Link(
                        localization.localizedText("settings.about.openSource"),
                        destination: URL(string: "https://gitlab.futo.org/futo-notes/futo-notes")!)
                    HStack {
                        Text(localization.localizedText("settings.about.version"))
                        Spacer()
                        Text(appVersion).foregroundStyle(.secondary)
                    }
                }

                Section(localization.localizedText("settings.sections.dangerZone")) {
                    Button(role: .destructive) {
                        showResetConfirm = true
                    } label: {
                        Text(localization.localizedText("settings.danger.fullReset"))
                    }
                    .disabled(resetting)
                    .confirmationDialog(
                        localization.localizedText("settings.danger.confirmation"),
                        isPresented: $showResetConfirm, titleVisibility: .visible
                    ) {
                        Button(
                            localization.localizedText("settings.danger.deleteEverything"),
                            role: .destructive
                        ) {
                            Task { await runFullReset() }
                        }
                        Button(localization.localizedText("common.actions.cancel"), role: .cancel) {}
                    }
                    #if DEBUG
                        // On-device verification hook for the crash pipeline: traps
                        // (SIGTRAP) → the signal handler writes a .crashlogs report
                        // → next launch surfaces the Crash Report sheet.
                        Button(role: .destructive) {
                            fatalError("Test crash from Settings (DEBUG)")
                        } label: {
                            Text(localization.localizedText("settings.debug.testCrash.title"))
                        }
                    #endif
                }
            }
            .navigationTitle(localization.localizedText("settings.heading"))
            .navigationBarTitleDisplayMode(.inline)
            .tint(Theme.primary)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(localization.localizedText("common.actions.done")) { dismiss() }
                        .disabled(resetting)
                }
            }
            .sheet(isPresented: $showSync) {
                SyncView()
                    .environmentObject(sync)
                    .environmentObject(store)
            }
            .overlay {
                if resetting {
                    // Blocking overlay — no interaction until the wipe lands.
                    ZStack {
                        Color.black.opacity(0.45).ignoresSafeArea()
                        VStack(spacing: 12) {
                            ProgressView()
                            Text(localization.localizedText("settings.danger.deleting"))
                                .font(.headline)
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
        Text(
            sync.connected
                ? localization.localizedText("settings.sync.syncedBadge")
                : localization.localizedText("settings.sync.localBadge")
        )
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

    /// Danger-zone full reset: disconnect and clear the stored credential before
    /// wiping the vault root, so an in-flight sync cannot restore deleted data.
    private func runFullReset() async {
        resetting = true
        await performFullReset(
            disconnectSync: { await sync.disconnect() },
            resetStore: { await store.fullReset() }
        )
        resetting = false
    }
}
