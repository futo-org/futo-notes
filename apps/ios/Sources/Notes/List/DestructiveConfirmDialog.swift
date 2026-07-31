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
struct DestructiveConfirmDialog: View {
    let message: String
    let destructiveLabel: String
    let onCancel: () -> Void
    let onDestructive: () -> Void

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
                        Text("Cancel")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    Divider()
                        .frame(height: 44)
                    Button(role: .destructive, action: onDestructive) {
                        Text(destructiveLabel)
                            .foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
            }
            .frame(width: 270)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        }
    }
}
