import SwiftUI

/// The recovery key, shown exactly once.
///
/// Rust returns it from `createVault` and keeps no copy, the model holds it
/// only while this screen is up, and continuing past here ends it — so there is
/// no way to ask for it again (ADR 0003, decision 3). Copy and the system share
/// sheet are the two ways off the device; the checkbox gates Continue, and
/// there is no type-back.
struct RecoveryKeyStepView: View {
    let recoveryKey: String
    @Binding var saved: Bool
    let busy: Bool
    let onCopy: () -> Void
    let onContinue: () -> Void

    @Environment(\.localization) private var localization

    var body: some View {
        HostedStepHeader(
            title: "sync.hosted.recoveryKey.title",
            explanation: "sync.hosted.recoveryKey.body")

        Text(recoveryKey)
            .font(.body.monospaced())
            .textSelection(.enabled)
            .accessibilityLabel(
                localization.localizedText("sync.hosted.recoveryKey.accessibilityLabel")
            )
            .accessibilityValue(recoveryKey)
            .accessibilityIdentifier("hosted-recovery-key")

        Button {
            onCopy()
        } label: {
            Label(
                localization.localizedText("sync.hosted.recoveryKey.copy"),
                systemImage: "doc.on.doc")
        }
        .disabled(busy)
        .accessibilityIdentifier("hosted-recovery-key-copy")

        // The key alone, so what gets shared pastes straight back into the
        // unlock field.
        ShareLink(item: recoveryKey) {
            Label(
                localization.localizedText("sync.hosted.recoveryKey.share"),
                systemImage: "square.and.arrow.up")
        }
        .accessibilityIdentifier("hosted-recovery-key-share")

        Text(localization.localizedText("sync.hosted.recoveryKey.warning"))
            .font(.caption)
            .foregroundStyle(.red)
        Text(localization.localizedText("sync.hosted.recoveryKey.shownOnce"))
            .font(.caption)
            .foregroundStyle(.secondary)

        Toggle(
            localization.localizedText("sync.hosted.recoveryKey.confirmSaved"),
            isOn: $saved
        )
        .accessibilityIdentifier("hosted-recovery-key-saved")

        Button(localization.localizedText("sync.hosted.recoveryKey.continue"), action: onContinue)
            .disabled(!saved || busy)
            .accessibilityIdentifier("hosted-recovery-key-continue")
    }
}
