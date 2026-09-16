import SwiftUI

/// What a signed-in device shows: who is signed in, the subscription in words,
/// storage used against the quota, the payment provider's portal, and Sign out.
///
/// The app writes no billing state — cancellation, invoices, and cards live
/// behind the portal (ADR 0003, decision 8).
struct HostedAccountCardView: View {
    let email: String
    let billing: BillingStatus?
    let busy: Bool
    let onManage: () -> Void
    let onSignOut: () -> Void

    @Environment(\.localization) private var localization
    @State private var confirmingSignOut = false

    var body: some View {
        Text(localization.localizedText("sync.hosted.account.heading"))
            .font(.headline)

        Text(email)
            .font(.callout)
            .textSelection(.enabled)
            .accessibilityIdentifier("hosted-account-email")

        if let billing {
            let state = subscriptionStateMessage(billing, localization)
            Text(localization.localizedText(state.path, arguments: state.arguments))
                .font(.callout)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("hosted-account-state")

            Text(
                localization.localizedText(
                    "sync.hosted.account.storage",
                    arguments: [
                        "used": localization.localizedFileSize(Int64(billing.bytesUsed)),
                        "quota": localization.localizedFileSize(
                            Int64(billing.storageQuotaBytes)),
                    ])
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("hosted-account-storage")
        }

        Button(
            localization.localizedText("sync.hosted.account.manageSubscription"), action: onManage
        )
        .disabled(busy)
        .accessibilityIdentifier("hosted-manage-subscription")

        Button(role: .destructive) {
            confirmingSignOut = true
        } label: {
            Text(localization.localizedText("sync.hosted.account.signOut"))
        }
        .disabled(busy)
        .accessibilityIdentifier("hosted-sign-out")
        .confirmationDialog(
            localization.localizedText("sync.hosted.signOut.confirmationTitle"),
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button(
                localization.localizedText("sync.hosted.account.signOut"),
                role: .destructive,
                action: onSignOut
            )
            Button(localization.localizedText("common.actions.cancel"), role: .cancel) {}
        } message: {
            Text(localization.localizedText("sync.hosted.signOut.ios.confirmationBody"))
        }
    }
}
