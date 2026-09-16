import SwiftUI

/// The License row — the FIRST row of Settings on mobile, and the only place
/// the ambient "Unlicensed" label appears on this platform
/// (docs/spec/license.md § States and copy).
///
/// Nothing in the app is gated on a license: this row is the only difference a
/// purchase makes. Which controls each state offers is Rust's answer
/// (`licenseRowActions`), so iOS and Android render the same table and the
/// `LICENSE_LINK_OUT` flag means the same thing on both.
struct LicenseSettingsSection: View {
    @ObservedObject var license: LicenseModel
    /// The build-time store-posture flag. A parameter rather than a direct
    /// read of the constant so both of its values are exercised by tests.
    var linkOut: Bool = LicenseLinkOut.isEnabled

    @Environment(\.localization) private var localization
    @Environment(\.openURL) private var openURL

    @State private var entering = false
    @State private var draft = ""
    @FocusState private var fieldFocused: Bool

    /// What is actually submitted — the one definition of "the field has
    /// something in it", so the button's enabled state and the submit guard
    /// can never disagree.
    private var submittableDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        Section(localization.localizedText("license.sectionTitle")) {
            if let view = license.view {
                // The plate card is Phase 4/5 of docs/plan/license-ship.md;
                // today this renders the shared model's badge alone.
                Text(
                    licenseCardModel(view, localization).badge
                        ?? localization.localizedText("license.statusLicensed")
                )
                .accessibilityIdentifier("license-status")

                if entering {
                    keyField
                } else {
                    ForEach(
                        licenseRowActions(status: view.status, linkOut: linkOut), id: \.self
                    ) { action in
                        button(for: action)
                    }
                }
            }

            // Never "free to use": Unlicensed asks, Licensed thanks
            // (docs/spec/license.md § States and copy).
            Text(
                localization.localizedText(
                    license.view?.status == .licensed
                        ? "license.explanationLicensed" : "license.explanation")
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    /// One text field for all three accepted shapes (a bare key, `key/activation`,
    /// or a `futonotes://` link) — recognising which is Rust's job, not this
    /// view's. A field with no submit is not operable, so Activate and Cancel
    /// come with it; the desktop projection supplies the same three controls.
    @ViewBuilder private var keyField: some View {
        TextField(
            localization.localizedText("license.keyLabel"),
            text: $draft,
            prompt: Text(localization.localizedText("license.keyPlaceholder"))
        )
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.done)
        .focused($fieldFocused)
        .accessibilityIdentifier("license-key-field")
        .onSubmit { Task { await submit() } }

        Button {
            Task { await submit() }
        } label: {
            Text(
                license.busy
                    ? localization.localizedText("license.activating")
                    : localization.localizedText("license.activate")
            )
        }
        .disabled(license.busy || submittableDraft.isEmpty)
        .accessibilityIdentifier("license-activate")

        Button(role: .cancel) {
            cancelEntry()
        } label: {
            Text(localization.localizedText("license.cancelEntry"))
        }
        .disabled(license.busy)
        .accessibilityIdentifier("license-cancel-entry")
    }

    @ViewBuilder private func button(for action: LicenseAction) -> some View {
        switch action {
        case .buy:
            actionButton("license.buy", identifier: "license-buy") { open(license.links.buy) }
        case .renew:
            actionButton("license.renew", identifier: "license-renew") { open(license.links.buy) }
        case .enterKey:
            actionButton("license.enterKey", identifier: "license-enter-key") {
                entering = true
                draft = ""
                fieldFocused = true
            }
        case .lostKey:
            actionButton("license.lostKey", identifier: "license-lost-key") {
                open(license.links.support)
            }
        case .remove:
            actionButton("license.remove", identifier: "license-remove") { license.remove() }
        }
    }

    private func actionButton(
        _ path: String, identifier: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(localization.localizedText(path))
        }
        .accessibilityIdentifier(identifier)
    }

    private func submit() async {
        guard !submittableDraft.isEmpty else { return }
        if await license.enterKey(draft) {
            cancelEntry()
        }
    }

    private func cancelEntry() {
        entering = false
        draft = ""
        fieldFocused = false
    }

    /// Buy, Renew and Lost-your-key all leave the app: `openURL` hands the
    /// destination to the SYSTEM browser (or mail client), never an in-app
    /// WebView (docs/spec/license.md § Getting a license).
    private func open(_ destination: String) {
        guard let url = URL(string: destination) else { return }
        openURL(url)
    }
}
