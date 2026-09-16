import SwiftUI

/// The three doors into an existing vault, all on one screen so a person picks
/// whichever they can do right now (parent spec user story 19).
///
/// The scan door is named and visible from the start rather than hidden,
/// because the choice is made once; it says pairing is not available yet
/// instead of pretending, until futo-notes#182 lands it.
struct UnlockStepView: View {
    @Binding var door: UnlockDoor
    let busy: Bool
    let onVaultPassword: (String) -> Void
    let onRecoveryKey: (String) -> Void

    @Environment(\.localization) private var localization
    @State private var vaultPassword = ""
    @State private var typedRecoveryKey = ""

    var body: some View {
        HostedStepHeader(
            title: "sync.hosted.unlock.title",
            explanation: "sync.hosted.unlock.body")

        ForEach(UnlockDoor.allCases) { option in
            Button {
                door = option
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
            Text(localization.localizedText("sync.hosted.unlock.scanNotReady"))
                .font(.caption)
                .foregroundStyle(.secondary)
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
