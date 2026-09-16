import SwiftUI

/// The scan door on the unlock screen: this device is the NEW one, so it draws
/// a code for an already-unlocked device to read (parent spec user story 13).
///
/// Four states, each one Rust's answer rendered and nothing this view decided:
/// **waiting** (the code, a live countdown to the relay's own `expires_at`, and
/// Cancel), **received** (the key arrived and the vault is unlocked),
/// **expired**, and **refused**. Showing a code again mints a new one, because
/// a live code cannot be withdrawn.
struct ShowPairingCodeView: View {
    let pairing: PairingState
    /// The payload to draw, straight from Rust.
    let payload: String?
    /// RFC 3339, the relay's own deadline.
    let expiresAt: String?
    let busy: Bool
    let onShow: () -> Void
    let onCancel: () -> Void

    @Environment(\.localization) private var localization

    var body: some View {
        switch pairing {
        case .waiting:
            waiting
        case .received:
            HostedStepHeader(
                title: "sync.hosted.pairing.received.title",
                explanation: "sync.hosted.pairing.ios.received.body"
            )
            .accessibilityIdentifier("hosted-pairing-received")
        case .expired, .refused:
            HostedStepHeader(
                title: pairing == .expired
                    ? "sync.hosted.pairing.expired.title" : "sync.hosted.pairing.refused.title",
                explanation: pairing == .expired
                    ? "sync.hosted.pairing.expired.body" : "sync.hosted.pairing.refused.body"
            )
            .accessibilityIdentifier(
                pairing == .expired ? "hosted-pairing-expired" : "hosted-pairing-refused")
            showButton("sync.hosted.pairing.showNewCode")
        case .idle:
            Text(localization.localizedText("sync.hosted.pairing.body"))
                .font(.caption)
                .foregroundStyle(.secondary)
            showButton("sync.hosted.pairing.showCode")
        }
    }

    @ViewBuilder
    private var waiting: some View {
        HostedStepHeader(
            title: "sync.hosted.pairing.title", explanation: "sync.hosted.pairing.body")

        if let payload, let code = pairingCodeImage(payload: payload) {
            // Fixed black on white in both themes, deliberately: a camera reads
            // dark modules on a light field, so theming this would break the one
            // thing it is for. The padding is the quiet zone a scanner needs to
            // find the code against whatever is next to it.
            Image(uiImage: code)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .frame(width: 220, height: 220)
                .padding(16)
                .background(Color.white)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("hosted-pairing-code")
                .accessibilityLabel(
                    localization.localizedText("sync.hosted.pairing.ios.codeAccessibilityLabel"))
        }

        if let expiresAt {
            // TimelineView ticks this once a second without a timer of its own,
            // and reads the real remaining time on the frame it appears rather
            // than flashing 0:00 until a first tick.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = formatPairingCountdown(
                    pairingSecondsRemaining(until: expiresAt, now: context.date))
                Text(
                    localization.localizedText(
                        "sync.hosted.pairing.expiresIn", arguments: ["remaining": remaining])
                )
                .font(.caption2)
                .foregroundStyle(.secondary)
                .accessibilityLabel(
                    localization.localizedText(
                        "sync.hosted.pairing.expiresInAccessibilityLabel",
                        arguments: ["remaining": remaining]))
            }
            .accessibilityIdentifier("hosted-pairing-expires-in")
        }

        Button(localization.localizedText("sync.hosted.cancel"), action: onCancel)
            .accessibilityIdentifier("hosted-pairing-cancel")
    }

    private func showButton(_ title: String) -> some View {
        Button(localization.localizedText(title), action: onShow)
            .disabled(busy)
            .accessibilityIdentifier("hosted-pairing-show")
    }
}
