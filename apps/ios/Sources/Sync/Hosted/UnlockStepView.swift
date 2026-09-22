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
    let onVaultPassword: (String) -> Void
    let onRecoveryKey: (String) -> Void
    let onShowPairingCode: () -> Void
    let onCancelPairing: () -> Void

    @Environment(\.localization) private var localization
    @State private var vaultPassword = ""
    @State private var typedRecoveryKey = ""

    var body: some View {
        HostedStepHeader(
            title: "sync.hosted.unlock.title",
            explanation: "sync.hosted.unlock.body")

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
            onVaultPassword(vaultPassword)
        case .recoveryKey where !typedRecoveryKey.isEmpty:
            onRecoveryKey(typedRecoveryKey)
        default:
            break
        }
    }
}
