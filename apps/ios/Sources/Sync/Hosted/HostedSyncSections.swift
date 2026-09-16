import SwiftUI

/// The hosted sync surface on the Sync sheet: the wizard, the account card, the
/// two refused-write banners, and the "Use my own server" disclosure.
///
/// Which screen this shows comes from Rust's `currentStep` every time it loads.
/// Nothing here remembers a position, which is what makes quitting halfway
/// through setup and reopening land on the right step (ADR 0003, decision 3).
struct HostedSyncSections: View {
    @StateObject private var model: HostedSetupModel
    @Environment(\.localization) private var localization

    init(notesRoot: String, store: NotesStore) {
        _model = StateObject(
            wrappedValue: HostedSetupModel.live(notesRoot: notesRoot, store: store)
        )
    }

    var body: some View {
        Group {
            if let error = model.errorMessage {
                Section {
                    Text(localization.localizedText(error.path, arguments: error.arguments))
                        .font(.callout)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("hosted-error")
                }
            }

            bannerSection

            Section { stepContent }

            if let waiting = model.waiting {
                Section {
                    HStack {
                        ProgressView()
                        Text(
                            localization.localizedText(
                                waiting == .signIn
                                    ? "sync.hosted.signIn.waiting"
                                    : "sync.hosted.subscribe.waiting")
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    Button(localization.localizedText("sync.hosted.cancel")) {
                        model.cancelWaiting()
                    }
                }
            }

            // Self-hosting is unchanged and stays available. The disclosed
            // panel is literally the sections a flag-off build renders, not a
            // copy of them (parent spec user story 34). The offer goes away
            // once hosted sync is set up.
            if model.screen != .account {
                Section {
                    Button {
                        model.selfHostedOpen.toggle()
                    } label: {
                        Label(
                            localization.localizedText("sync.hosted.useMyOwnServer"),
                            systemImage: model.selfHostedOpen ? "chevron.down" : "chevron.right"
                        )
                    }
                    .accessibilityIdentifier("hosted-use-my-own-server")
                }
                if model.selfHostedOpen {
                    SelfHostedSyncSections()
                }
            }
        }
        .task { await model.load() }
    }

    @ViewBuilder
    private var bannerSection: some View {
        switch model.banner {
        case .none:
            EmptyView()
        case .syncPaused:
            Section {
                banner(
                    title: "sync.hosted.banner.syncPaused.title",
                    explanation: "sync.hosted.banner.syncPaused.body",
                    action: "sync.hosted.banner.syncPaused.action",
                    identifier: "hosted-banner-sync-paused"
                ) {
                    Task { await model.subscribe() }
                }
            }
        case .vaultFull:
            Section {
                banner(
                    title: "sync.hosted.banner.vaultFull.title",
                    explanation: "sync.hosted.banner.vaultFull.body",
                    action: "sync.hosted.banner.vaultFull.action",
                    identifier: "hosted-banner-vault-full"
                ) {
                    Task { await model.manageSubscription() }
                }
            }
        }
    }

    private func banner(
        title: String,
        explanation: String,
        action: String,
        identifier: String,
        onAction: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(localization.localizedText(title))
                .font(.headline)
                .accessibilityIdentifier(identifier)
            Text(localization.localizedText(explanation))
                .font(.caption)
                .foregroundStyle(.secondary)
            Button(localization.localizedText(action), action: onAction)
                .disabled(model.busy)
        }
    }

    @ViewBuilder
    private var stepContent: some View {
        switch model.screen {
        case .loading:
            Text(localization.localizedText("sync.hosted.loading"))
                .font(.caption)
                .foregroundStyle(.secondary)
        case .unavailable:
            Text(localization.localizedText("sync.hosted.unavailable"))
                .font(.caption)
                .foregroundStyle(.secondary)
        case .signIn:
            HostedStepHeader(
                title: "sync.hosted.signIn.title", explanation: "sync.hosted.signIn.body")
            Button {
                Task { await model.signIn() }
            } label: {
                Label(
                    localization.localizedText("sync.hosted.signIn.button"),
                    systemImage: "person.crop.circle.badge.checkmark")
            }
            .disabled(model.busy)
            .accessibilityIdentifier("hosted-sign-in")
            Text(
                localization.localizedText(
                    "sync.hosted.signIn.serverLine", arguments: ["server": model.serverURL])
            )
            .font(.caption2)
            .foregroundStyle(.secondary)
        case .subscribe:
            HostedStepHeader(
                title: "sync.hosted.subscribe.title", explanation: "sync.hosted.subscribe.body")
            Button(localization.localizedText("sync.hosted.subscribe.button")) {
                Task { await model.subscribe() }
            }
            .disabled(model.busy)
            .accessibilityIdentifier("hosted-subscribe")
        case .createVault:
            CreateVaultStepView(minimumLength: model.minimumVaultPasswordLength, busy: model.busy) {
                vaultPassword in
                Task { await model.createVault(vaultPassword: vaultPassword) }
            }
        case .recoveryKey:
            if let recoveryKey = model.recoveryKey {
                RecoveryKeyStepView(
                    recoveryKey: recoveryKey,
                    saved: $model.recoveryKeySaved,
                    busy: model.busy,
                    onCopy: { model.copyRecoveryKey() },
                    onContinue: { Task { await model.continueAfterRecoveryKey() } }
                )
            }
        case .unlock:
            UnlockStepView(
                door: $model.unlockDoor,
                busy: model.busy,
                onVaultPassword: { vaultPassword in
                    Task { await model.unlockWithPassword(vaultPassword) }
                },
                onRecoveryKey: { typed in
                    Task { await model.unlockWithRecoveryKey(typed) }
                }
            )
        case .account:
            HostedAccountCardView(
                email: model.email,
                billing: model.billing,
                busy: model.busy,
                onManage: { Task { await model.manageSubscription() } },
                onSignOut: { Task { await model.signOut() } }
            )
        }
    }
}

/// The title and explanation every wizard step opens with.
struct HostedStepHeader: View {
    let title: String
    let explanation: String
    @Environment(\.localization) private var localization

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(localization.localizedText(title))
                .font(.headline)
            Text(localization.localizedText(explanation))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
