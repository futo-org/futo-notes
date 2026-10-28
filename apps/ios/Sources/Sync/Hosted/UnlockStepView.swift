import SwiftUI

/// The three doors into an existing vault, all on one screen so a person picks
/// whichever they can do right now (parent spec user story 19).
///
/// The door is chosen through a callback rather than a binding because leaving
/// the scan door has to stop a live pairing wait, which only the model can do.
struct UnlockStepView: View {
    let door: UnlockDoor
    let busy: Bool
    let pairing: PairingState
    let pairingPayload: String?
    let pairingExpiresAt: String?
    let onChooseDoor: (UnlockDoor) -> Void
    let onVaultPassword: (String) async -> Void
    let onRecoveryKey: (String) async -> Void
    let onShowPairingCode: () async -> Void
    let onCancelPairing: () -> Void

    @Environment(\.localization) private var localization
    @State private var vaultPassword = ""
    @State private var typedRecoveryKey = ""

    var body: some View {
        HostedStepHeader(
            title: "sync.hosted.unlock.title",
            explanation: "sync.hosted.unlock.body"
        )
        // The step's verbs, on its one row that is always there.
        .puppetVerbs { puppetVerbs }

        ForEach(UnlockDoor.allCases) { option in
            Button {
                onChooseDoor(option)
            } label: {
                HStack {
                    Text(localization.localizedText("sync.hosted.unlock.doors.\(option.rawValue)"))
                        .foregroundStyle(.primary)
                    Spacer()
                    if door == option {
                        Image(systemName: "checkmark").foregroundStyle(Theme.primary)
                    }
                }
            }
            .accessibilityIdentifier("hosted-door-\(option.rawValue)")
            .accessibilityAddTraits(door == option ? [.isSelected] : [])
        }

        switch door {
        case .vaultPassword:
            SecureField(
                localization.localizedText("sync.hosted.unlock.vaultPasswordPlaceholder"),
                text: $vaultPassword
            )
            .textContentType(.password)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityLabel(
                localization.localizedText("sync.hosted.unlock.vaultPasswordLabel")
            )
            .accessibilityIdentifier("hosted-unlock-password")
            .onSubmit(submit)
            unlockButton(enabled: !vaultPassword.isEmpty)
        case .scan:
            ShowPairingCodeView(
                pairing: pairing,
                payload: pairingPayload,
                expiresAt: pairingExpiresAt,
                busy: busy,
                onShow: onShowPairingCode,
                onCancel: onCancelPairing
            )
        case .recoveryKey:
            TextField(
                localization.localizedText("sync.hosted.unlock.recoveryKeyPlaceholder"),
                text: $typedRecoveryKey
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityLabel(localization.localizedText("sync.hosted.unlock.recoveryKeyLabel"))
            .accessibilityIdentifier("hosted-unlock-recovery-key")
            .onSubmit(submit)
            Text(localization.localizedText("sync.hosted.unlock.recoveryKeyHint"))
                .font(.caption2)
                .foregroundStyle(.secondary)
            unlockButton(enabled: !typedRecoveryKey.isEmpty)
        }
    }

    private func unlockButton(enabled: Bool) -> some View {
        Button(
            busy
                ? localization.localizedText("sync.working")
                : localization.localizedText("sync.hosted.unlock.button"),
            action: submit
        )
        .disabled(busy || !enabled)
        .accessibilityIdentifier("hosted-unlock")
    }

    private func submit() {
        if busy { return }
        switch door {
        case .vaultPassword where !vaultPassword.isEmpty:
            Task { await onVaultPassword(vaultPassword) }
        case .recoveryKey where !typedRecoveryKey.isEmpty:
            Task { await onRecoveryKey(typedRecoveryKey) }
        default:
            break
        }
    }

    /// What the agent calls each door: `scan` is THIS device showing a code for
    /// another to scan, which a name with "scan" in it would read backwards.
    private static let methods: [UnlockDoor: String] = [
        .vaultPassword: "vaultPassword", .recoveryKey: "recoveryKey", .scan: "anotherDevice",
    ]

    /// The open door's field is the Unlock button's one argument, typed in as a
    /// person would. The scan door's own controls are ShowPairingCodeView's.
    private var puppetVerbs: [PuppetVerbs.Verb] {
        var verbs = [
            PuppetVerbs.Verb("SelectUnlockMethod", required: ["method"]) { arguments in
                let method = arguments["method"] as? String
                guard let chosen = Self.methods.first(where: { $0.value == method })?.key else {
                    throw PuppetVerbRefusal(
                        400, "method is vaultPassword, recoveryKey or anotherDevice")
                }
                onChooseDoor(chosen)
                return [:]
            }
        ]
        let field = door == .vaultPassword ? "vaultPassword" : "recoveryKey"
        if door != .scan {
            verbs.append(
                PuppetVerbs.Verb(
                    "UnlockVault", required: [field],
                    controls: [
                        "sync.hosted.unlock.vaultPasswordLabel",
                        "sync.hosted.unlock.recoveryKeyLabel", "sync.hosted.unlock.button",
                        "sync.working",
                    ]
                ) { arguments in
                    if busy { throw PuppetVerbRefusal(409, "hosted sync is busy") }
                    let typed = (arguments[field] as? String) ?? ""
                    if door == .vaultPassword {
                        vaultPassword = typed
                        await onVaultPassword(typed)
                    } else {
                        typedRecoveryKey = typed
                        await onRecoveryKey(typed)
                    }
                    return [:]
                })
        }
        return verbs
    }
}
