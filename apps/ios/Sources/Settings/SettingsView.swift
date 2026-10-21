import SwiftUI
import UIKit

/// App settings sheet (gear button in the note list). Mirrors the desktop
/// Settings surface (settings.md): the License row, a single "Sync" row, appearance,
/// storage readout, issue reporting, about, and the danger-zone full reset.
/// Sync details/actions stay in SyncView — the Sync row just opens it.
struct SettingsView: View {
    private static let licenseCardID = "license-card"
    static let systemSettingsURL = URL(string: UIApplication.openSettingsURLString)!

    @EnvironmentObject private var store: NotesStore
    @EnvironmentObject private var sync: SyncManager
    @EnvironmentObject private var license: LicenseModel
    @EnvironmentObject private var licenseStorefront: LicenseStorefront
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

    @State private var appIcons = AppIconController()
    @State private var showAppIcons = false
    /// The one-time header above the picker's grid after an activation. Set when
    /// the landing opens the picker and dropped when it closes: nothing is
    /// persisted, so reopening shows the plain grid.
    @State private var showsLanding = false
    /// Bumped by "I already paid" in the picker's sheet; the License card opens
    /// its key field on each change.
    @State private var keyEntryRequest = 0
    /// The icon whose ask sheet is up over the picker. Lives here, not in the
    /// picker, so it survives the picker being re-created on foregrounding.
    @State private var askingIcon: AppIcon?
    @Environment(\.scenePhase) private var scenePhase
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
                // The License row is the FIRST row of Settings on mobile:
                // there is no ambient label anywhere else on this platform, so
                // this row's status text IS the label (docs/spec/license.md
                // § States and copy).
                LicenseSettingsSection(
                    license: license, linkOut: licenseStorefront.linkOut,
                    keyEntryRequest: keyEntryRequest
                )
                .id(Self.licenseCardID)

                // The whole Sync surface is one "Sync" row: cloud
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
                                Text(localization.localizedText("settings.sync.label"))
                                    .foregroundStyle(.primary)
                                Text(
                                    sync.connected
                                        ? sync.localizedStatus(localization)
                                        : localization.localizedText(
                                            "settings.sync.localDescription")
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
                        localization.localizedText("settings.appearance.theme"),
                        selection: $themeMode
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

                Section(localization.localizedText("settings.appIcon.heading")) {
                    Button {
                        showAppIcons = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(appIcons.selected.previewName)
                                .resizable().scaledToFit().frame(width: 40, height: 40)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                            Text(localization.localizedText(appIcons.selected.labelKey))
                                .foregroundStyle(.primary)
                            Spacer()
                            // Unknown (still loading) is not "unlicensed".
                            if license.view != nil && !license.includes.contains(.appIcon) {
                                appIconHint
                            }
                            Image(systemName: "chevron.right").foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityIdentifier("settings-app-icon")
                }

                Section(localization.localizedText("settings.language.heading")) {
                    Link(destination: Self.systemSettingsURL) {
                        HStack {
                            Image(systemName: "globe")
                                .foregroundStyle(Theme.primary)
                            Text(
                                localization.localizedText(
                                    "settings.language.ios.openSystemSettings"
                                )
                            )
                            Spacer()
                            Text(localization.effectiveLanguage.nativeName)
                                .foregroundStyle(.secondary)
                            Image(systemName: "arrow.up.right")
                        }
                    }
                    .accessibilityIdentifier("settings-language")
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
                    NavigationLink {
                        FeedbackView()
                    } label: {
                        Text(localization.localizedText("settings.issueReporting.sendFeedback"))
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
                        Button(localization.localizedText("common.actions.cancel"), role: .cancel) {
                        }
                    }
                    #if DEBUG
                        Button(role: .destructive) {
                            fatalError("Test crash from Settings (DEBUG)")
                        } label: {
                            Text(localization.localizedText("settings.debug.testCrash.title"))
                        }
                    #endif
                }
            }
            .onChange(of: license.pendingLanding, initial: true) { _, pending in
                guard pending else { return }
                // Taken now, whatever happens next: a landing is for the moment
                // of activation and is never kept for a later visit.
                license.consumeLanding()
                // The OS cannot change icons (the picker would only say so),
                // or something Settings owns is already up and SwiftUI would
                // drop the presentation: the toast alone is the landing.
                guard appIcons.available, !showSync, !showResetConfirm, !resetting else { return }
                showsLanding = true
                // Already open (the user paid from its sheet): it only gains
                // the header.
                showAppIcons = true
            }
            .onChange(of: showAppIcons) { _, shown in
                if !shown {
                    showsLanding = false
                    askingIcon = nil
                }
            }
            .modifier(ScrollOnChange(id: Self.licenseCardID, trigger: keyEntryRequest))
            .navigationTitle(localization.localizedText("settings.heading"))
            .navigationBarTitleDisplayMode(.inline)
            .tint(Theme.primary)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(localization.localizedText("common.actions.done")) { dismiss() }
                        .disabled(resetting)
                }
            }
            .sheet(isPresented: $showAppIcons) {
                AppIconPicker(
                    controller: appIcons, license: license, linkOut: licenseStorefront.linkOut,
                    showsLanding: showsLanding, asking: $askingIcon,
                    onAlreadyPaid: {
                        showAppIcons = false
                        // Scrolls to the card and opens its key field.
                        keyEntryRequest += 1
                    })
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
        .onAppear { appIcons.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { appIcons.refresh() }
        }
        .transientMessageBanner(store)
        .interactiveDismissDisabled(resetting)
    }

    /// The coin and "More with a license" on the App icon row while the license does
    /// not include icons — on key-only builds too: it names a fact, not a sale.
    private var appIconHint: some View {
        HStack(spacing: 6) {
            CoinBadge(diameter: 18, ring: false)
            Text(localization.localizedText("settings.appIcon.license.rowHint"))
                .font(.subheadline)
                // The row is a tinted Button: `.secondary` derives from the
                // tint, so name the gray outright.
                .foregroundStyle(Color(.secondaryLabel))
        }
    }

    /// SYNCED / LOCAL pill shown on the single "Sync" row.
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
    /// The stored license goes with it — it is a preference like any other
    /// (settings.md, Danger zone).
    private func runFullReset() async {
        resetting = true
        defer {
            sync.finishReset()
            resetting = false
        }
        do {
            try await performFullReset(
                beginStoreReset: { store.beginFullReset() },
                disconnectSync: { await sync.disconnectForReset() },
                resetStore: { try await store.fullReset() },
                clearLicense: { license.clearForFullReset() },
                resetIcon: {
                    do { try await appIcons.reset() } catch {
                        store.showTransient(LocalizedMessage("settings.appIcon.resetFailed"))
                    }
                }
            )
        } catch {
            store.showTransient(LocalizedMessage("settings.danger.failed"))
        }
    }
}

/// Scrolls to `id` whenever `trigger` changes. A modifier so the `Form` does not
/// need a `ScrollViewReader` wrapped around (and re-indented under) it.
private struct ScrollOnChange<Trigger: Equatable>: ViewModifier {
    let id: String
    let trigger: Trigger

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content.onChange(of: trigger) {
                withAnimation { proxy.scrollTo(id, anchor: .top) }
            }
        }
    }
}
