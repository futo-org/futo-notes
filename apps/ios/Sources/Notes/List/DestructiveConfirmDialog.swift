import SwiftUI

/// Toggles state without the implicit full-screen-cover transition, so the
/// centered card appears like a system alert instead of sliding up.
func presentWithoutAnimation(_ mutate: () -> Void) {
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction, mutate)
}

/// Alert-look-alike card for destructive confirmations, hosted in a transparent
/// `fullScreenCover`. Unlike `.confirmationDialog`, it is always centered and
/// never anchors an arrow to an unrelated row on a regular-width device.
/// `destructiveLabelKey` is the destructive button's catalog key, so its row reads
/// `→ ConfirmDialog`. `onDestructive` is the whole act: the `ConfirmDialog` verb answers once
/// it has finished, so its receipt shows what confirming did.
struct DestructiveConfirmDialog: View {
    let message: String
    let destructiveLabelKey: String
    let onCancel: () -> Void
    let onDestructive: () async -> Void
    @Environment(\.localization) private var localization

    var body: some View {
        ZStack {
            Color.black.opacity(0.2)
                .ignoresSafeArea()
            VStack(spacing: 0) {
                Text(message)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)
                    .padding(.top, 19)
                    .padding(.bottom, 16)
                Divider()
                HStack(spacing: 0) {
                    Button(action: onCancel) {
                        Text(localization.localizedText("common.actions.cancel"))
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    Divider()
                        .frame(height: 44)
                    Button(role: .destructive) { Task { await onDestructive() } } label: {
                        Text(localization.localizedText(destructiveLabelKey))
                            .foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
            }
            .frame(width: 270)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        }
        // While it is up it is all a person can reach.
        .puppetVerbs(modal: true) {
            [
                PuppetVerbs.Verb("ConfirmDialog", controls: [destructiveLabelKey]) {
                    await onDestructive()
                },
                PuppetVerbs.Verb("DismissDialog", controls: ["common.actions.cancel"]) {
                    onCancel()
                },
            ]
        }
    }
}
