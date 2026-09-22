import SwiftUI

/// Which of the two vault-password screens this is: the wizard's "choose one",
/// or the account card's "choose a new one". Everything below the heading is
/// the same either way — the minimum, the meter, the repeat field — so the two
/// share one view rather than one copying the other.
enum VaultPasswordPurpose: String {
    case create
    case change
}

/// Choose the password that encrypts this vault.
///
/// `minimumLength` is Rust's own minimum, read through the FFI, so this screen
/// and the engine cannot disagree about what a long-enough password is. The
/// strength readout is advice on top of that one rule — there are no
/// composition rules (ADR 0003, decision 7).
///
/// The change screen asks for no current secret: this device already holds the
/// vault key, and a device paired by QR never knew the old password (ADR 0003,
/// decision 10).
struct VaultPasswordStepView: View {
    let purpose: VaultPasswordPurpose
    let minimumLength: Int
    let busy: Bool
    let onSubmit: (String) -> Void
    /// Only the change screen offers a way back; the wizard has none.
    var onCancel: (() -> Void)?

    @Environment(\.localization) private var localization
    @State private var password = ""
    @State private var repeated = ""

    private var strength: VaultPasswordStrength {
        vaultPasswordStrength(password, minimumLength: minimumLength)
    }

    private var strengthLabel: String {
        strength == .tooShort
            ? localization.localizedText(
                "sync.hosted.vaultPassword.strength.tooShort",
                arguments: ["minimum": minimumLength])
            : localization.localizedText("sync.hosted.vaultPassword.strength.\(strength.rawValue)")
    }

    private var mismatch: Bool { !repeated.isEmpty && repeated != password }

    private var ready: Bool {
        password.unicodeScalars.count >= minimumLength && repeated == password && !busy
    }

    var body: some View {
        HostedStepHeader(
            title: "sync.hosted.vaultPassword.\(purpose.rawValue).title",
            explanation: "sync.hosted.vaultPassword.\(purpose.rawValue).body")

        SecureField(
            localization.localizedText(
                "sync.hosted.vaultPassword.placeholder", arguments: ["minimum": minimumLength]),
            text: $password
        )
        .textContentType(.newPassword)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .accessibilityLabel(localization.localizedText("sync.hosted.vaultPassword.label"))
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
                "sync.hosted.vaultPassword.strengthAccessibilityLabel",
                arguments: ["strength": strengthLabel])
        )

        SecureField(
            localization.localizedText("sync.hosted.vaultPassword.repeatPlaceholder"),
            text: $repeated
        )
        .textContentType(.newPassword)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .accessibilityLabel(localization.localizedText("sync.hosted.vaultPassword.repeatLabel"))
        .accessibilityIdentifier("hosted-vault-password-repeat")
        .onSubmit(submit)

        if mismatch {
            Text(localization.localizedText("sync.hosted.vaultPassword.mismatch"))
                .font(.caption)
                .foregroundStyle(.red)
        }

        Button(
            busy
                ? localization.localizedText("sync.working")
                : localization.localizedText(
                    "sync.hosted.vaultPassword.\(purpose.rawValue).button"),
            action: submit
        )
        .disabled(!ready)
        .accessibilityIdentifier("hosted-vault-password-submit")

        if let onCancel {
            Button(localization.localizedText("sync.hosted.cancel"), action: onCancel)
                .accessibilityIdentifier("hosted-vault-password-cancel")
        }
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
        if ready { onSubmit(password) }
    }
}
