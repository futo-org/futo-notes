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
    /// True when this replaces a key a person already had. The only difference
    /// on screen: one line saying the old key stopped working (parent spec
    /// user story 32).
    let replaced: Bool
    @Binding var saved: Bool
    let busy: Bool
    let onCopy: () -> Void
    let onShare: () -> Void
    let onContinue: () async -> Void

    @Environment(\.localization) private var localization

    var body: some View {
        HostedStepHeader(
            title: "sync.hosted.recoveryKey.title",
            explanation: "sync.hosted.recoveryKey.body"
        )
        // The step's verbs, on its one row that is always there.
        .puppetVerbs { puppetVerbs }

        if replaced {
            Text(localization.localizedText("sync.hosted.recoveryKey.replaced"))
                .font(.callout)
                .accessibilityIdentifier("hosted-recovery-key-replaced")
        }

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

        // A button rather than a ShareLink, so the share sheet can be opened
        // from code too (the agent's ShareRecoveryKey).
        Button(action: onShare) {
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

        Button(localization.localizedText("sync.hosted.recoveryKey.continue")) {
            Task { await onContinue() }
        }
        .disabled(!saved || busy)
        .accessibilityIdentifier("hosted-recovery-key-continue")
    }
    private var puppetVerbs: [PuppetVerbs.Verb] {
        [
            PuppetVerbs.Verb("CopyRecoveryKey", controls: ["sync.hosted.recoveryKey.copy"]) {
                if busy { throw PuppetVerbRefusal(409, "hosted sync is busy") }
                onCopy()
            },
            PuppetVerbs.Verb("ShareRecoveryKey", controls: ["sync.hosted.recoveryKey.share"]) {
                onShare()
            },
            PuppetVerbs.Verb(
                "SetRecoveryKeySaved", required: ["saved"], booleans: ["saved"],
                controls: ["sync.hosted.recoveryKey.confirmSaved"]
            ) { arguments in
                saved = (arguments["saved"] as? Bool) ?? false
                return ["saved": saved]
            },
            PuppetVerbs.Verb("ContinueRecoveryKey", controls: ["sync.hosted.recoveryKey.continue"])
            {
                guard saved else { throw PuppetVerbRefusal(409, "tick SetRecoveryKeySaved first") }
                if busy { throw PuppetVerbRefusal(409, "hosted sync is busy") }
                await onContinue()
            },
        ]
    }
}
