import SwiftUI

/// Choose the password that encrypts this vault.
///
/// `minimumLength` is Rust's own minimum, read through the FFI, so this screen
/// and the engine cannot disagree about what a long-enough password is. The
/// strength readout is advice on top of that one rule — there are no
/// composition rules (ADR 0003, decision 7).
struct CreateVaultStepView: View {
    let minimumLength: Int
    let busy: Bool
    let onCreate: (String) -> Void

    @Environment(\.localization) private var localization
    @State private var password = ""
    @State private var repeated = ""

    private var strength: VaultPasswordStrength {
        vaultPasswordStrength(password, minimumLength: minimumLength)
    }

    private var strengthLabel: String {
        strength == .tooShort
            ? localization.localizedText(
                "sync.hosted.createVault.strength.tooShort", arguments: ["minimum": minimumLength])
            : localization.localizedText("sync.hosted.createVault.strength.\(strength.rawValue)")
    }

    private var mismatch: Bool { !repeated.isEmpty && repeated != password }

    private var ready: Bool {
        password.unicodeScalars.count >= minimumLength && repeated == password && !busy
    }

    var body: some View {
        HostedStepHeader(
            title: "sync.hosted.createVault.title",
            explanation: "sync.hosted.createVault.body")

        SecureField(
            localization.localizedText(
                "sync.hosted.createVault.placeholder", arguments: ["minimum": minimumLength]),
            text: $password
        )
        .textContentType(.newPassword)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .accessibilityLabel(localization.localizedText("sync.hosted.createVault.label"))
        .accessibilityIdentifier("hosted-vault-password")

        HStack(spacing: 8) {
            ProgressView(value: strengthFraction)
                .tint(strengthColor)
            Text(strengthLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            localization.localizedText(
                "sync.hosted.createVault.strengthAccessibilityLabel",
                arguments: ["strength": strengthLabel])
        )

        SecureField(
            localization.localizedText("sync.hosted.createVault.repeatPlaceholder"),
            text: $repeated
        )
        .textContentType(.newPassword)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .accessibilityLabel(localization.localizedText("sync.hosted.createVault.repeatLabel"))
        .accessibilityIdentifier("hosted-vault-password-repeat")
        .onSubmit(submit)

        if mismatch {
            Text(localization.localizedText("sync.hosted.createVault.mismatch"))
                .font(.caption)
                .foregroundStyle(.red)
        }

        Button(
            busy
                ? localization.localizedText("sync.working")
                : localization.localizedText("sync.hosted.createVault.button"),
            action: submit
        )
        .disabled(!ready)
        .accessibilityIdentifier("hosted-create-vault")
    }

    private var strengthFraction: Double {
        switch strength {
        case .tooShort: return 0.1
        case .weak: return 0.35
        case .fair: return 0.7
        case .strong: return 1
        }
    }

    private var strengthColor: Color {
        switch strength {
        case .tooShort, .weak: return .red
        case .fair: return .orange
        case .strong: return .green
        }
    }

    private func submit() {
        if ready { onCreate(password) }
    }
}
