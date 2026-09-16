import SwiftUI
import UIKit

/// What the Key row shows: the masked key until it is tapped, the stored key
/// after (decision D4).
///
/// A free function rather than a `@State`-derived expression so the reveal rule
/// is testable without hosting a SwiftUI view, and so masked and revealed can
/// never disagree about which license they came from: both start at the same
/// card model, and a card with no key has no row value in either state.
func licenseKeyRowText(_ card: LicenseCardModel, key: String?, revealed: Bool) -> String? {
    guard let masked = card.maskedKey else { return nil }
    guard revealed, let key, !key.isEmpty else { return masked }
    return key
}

/// The License card — the FIRST section of Settings on mobile, and the only
/// place a license is visible on this platform (docs/spec/license.md § States
/// and copy).
///
/// It is the "Steel Ledger" plate: one container, a gunmetal gradient, a gold
/// accent, and a 184pt well that holds the supporter coin when licensed
/// (docs/plan/license-ship.md D1). The well is unpainted space since
/// 2026-09-16 — see `well` — and the coin TURNS, as it does on the other two
/// platforms, and can be dragged; `SupporterCoin` renders the same Blender model
/// all three shells render (D5, superseded).
///
/// Nothing in the app is gated on a license: this card is the only difference a
/// purchase makes. Which controls each state offers is Rust's answer
/// (`licenseRowActions`), and how each state reads is the shared card model
/// (`licenseCardModel`), so iOS and Android render the same thing and the
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
    /// Reveal lasts only while the card is on screen: leaving Settings, or a
    /// license arriving or being removed, re-masks it.
    @State private var revealed = false
    @FocusState private var fieldFocused: Bool

    /// The well and the coin, in points. Named because two of the three
    /// platforms quote the same numbers.
    private static let wellDiameter: CGFloat = 184
    private static let coinDiameter: CGFloat = 160

    /// What is actually submitted — the one definition of "the field has
    /// something in it", so the button's enabled state and the submit guard
    /// can never disagree.
    private var submittableDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `nil` until the license has been read and evaluated off the main actor.
    /// The plate still renders its frame in that window — the shell never waits
    /// on I/O to paint (M1).
    private var card: LicenseCardModel? {
        license.view.map { licenseCardModel($0, localization) }
    }

    var body: some View {
        Section(localization.localizedText("license.sectionTitle")) {
            plate
                // The plate IS the card, so it replaces the grouped row
                // background rather than sitting inside one.
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                // A different license is a different key: re-mask rather than
                // reveal a key the user never asked to see. Leaving Settings
                // re-masks on its own — the sheet drops this view's @State.
                .onChange(of: license.view?.key) { revealed = false }
        }
    }

    private var plate: some View {
        VStack(alignment: .leading, spacing: 20) {
            well.frame(maxWidth: .infinity, alignment: .center)
            identity
            ledger
            controls
            explanation
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Theme.Plate.gradient,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }

    /// The well is present in every state — empty is a state, not an absence
    /// (D1) — but it is now a reserved SPACE rather than a drawn recess. @justin
    /// 2026-09-16 asked for the circle border gone on all three platforms, and
    /// the filled disc plus its inset edge was that border; the coin sits on the
    /// plate directly. The frame stays, so the layout and the label do not move.
    private var well: some View {
        Color.clear
            .frame(width: Self.wellDiameter, height: Self.wellDiameter)
            .overlay {
                if card?.status == .licensed {
                    // The well already carries the coin's catalog label, so the
                    // coin itself is hidden from VoiceOver rather than being a
                    // second stop that says the same thing.
                    SupporterCoin(diameter: Self.coinDiameter)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isImage)
            .accessibilityLabel(
                localization.localizedText(
                    card?.status == .licensed
                        ? "license.coinAccessibilityLabel" : "license.card.emptyWell")
            )
            // The well is the one element present in every state, so it is also
            // where the state is readable from: Licensed shows no badge, exactly
            // as the desktop and Android plates do.
            .accessibilityValue(statusName)
            .accessibilityIdentifier("license-well")
    }

    /// Status, eyebrow, product name. Licensed wears no chip: the coin in the
    /// well is the statement, and the state stays readable from the well's
    /// accessibility value in every state.
    private var identity: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let badge = card?.badge {
                status(badge)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(localization.localizedText("license.card.eyebrow"))
                    .font(.caption2.weight(.semibold))
                    .textCase(.uppercase)
                    .tracking(1.4)
                    .foregroundStyle(Theme.Plate.accent)
                Text(localization.localizedText("license.card.productName"))
                    .font(.system(size: 26, weight: .bold))
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(Theme.Plate.ink)
            }
        }
    }

    /// Unlicensed and Expired name themselves in a gold chip.
    private func status(_ badge: String) -> some View {
        Text(badge)
            .font(.caption2.weight(.bold))
            .textCase(.uppercase)
            .tracking(1.0)
            .foregroundStyle(Theme.Plate.accent)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .overlay(
                Capsule().stroke(Theme.Plate.accent.opacity(0.7), lineWidth: 1)
            )
            .accessibilityIdentifier("license-status")
    }

    /// The state as one word, for the well's accessibility value. Licensed has
    /// no badge to borrow, so it reads its own catalog entry; before the
    /// license has been evaluated there is no state to name.
    private var statusName: String {
        guard let card else { return "" }
        return card.badge ?? localization.localizedText("license.statusLicensed")
    }

    /// Key, Licensed since, Term — three rows, present in every state. A row
    /// with nothing to say renders blank; nothing is invented to fill it (D2).
    private var ledger: some View {
        VStack(alignment: .leading, spacing: 0) {
            ledgerRow("license.card.keyLabel") { keyValue }
            rule
            ledgerRow("license.card.sinceLabel") { value(card?.since) }
            rule
            ledgerRow("license.card.termLabel") { value(card?.term) }
        }
    }

    /// Label above value: the key is 39 characters in both its masked and
    /// revealed forms, which no phone-width two-column row can hold.
    private func ledgerRow(
        _ label: String, @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(localization.localizedText(label))
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .tracking(0.8)
                .foregroundStyle(Theme.Plate.inkDim)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 9)
    }

    private var rule: some View {
        Theme.Plate.rule.opacity(0.6).frame(height: 1)
    }

    private func value(_ text: String?) -> some View {
        // An empty string still reserves the line, so the three rows keep
        // their rhythm whatever the state.
        Text(text?.isEmpty == false ? text! : " ")
            .font(.subheadline)
            .foregroundStyle(Theme.Plate.ink)
    }

    /// Masked until tapped, then the stored key plus a Copy control. The whole
    /// masked value is the button: it is the affordance.
    @ViewBuilder private var keyValue: some View {
        if let card, let shown = licenseKeyRowText(card, key: license.view?.key, revealed: revealed)
        {
            if revealed {
                VStack(alignment: .leading, spacing: 8) {
                    keyText(shown)
                    Button {
                        copyKey(license.view?.key)
                    } label: {
                        Label {
                            Text(localization.localizedText("license.card.copyKey"))
                        } icon: {
                            Image(systemName: "doc.on.doc")
                        }
                        .font(.footnote.weight(.semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.Plate.accent)
                    .accessibilityIdentifier("license-key-copy")
                }
            } else {
                Button {
                    revealed = true
                } label: {
                    keyText(shown)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(localization.localizedText("license.card.revealKey"))
                .accessibilityIdentifier("license-key-masked")
            }
        } else {
            value(nil)
        }
    }

    private func keyText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 13, design: .monospaced))
            .foregroundStyle(Theme.Plate.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Buy/Renew is the one filled button; everything else is a text button.
    /// The list itself is Rust's (`licenseRowActions`), including what
    /// `LICENSE_LINK_OUT` hides.
    @ViewBuilder private var controls: some View {
        if let view = license.view {
            if entering {
                keyField
            } else {
                let actions = licenseRowActions(status: view.status, linkOut: linkOut)
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(actions.filter(Self.isPrimary), id: \.self) { action in
                        filledButton(for: action)
                    }
                    let secondary = actions.filter { !Self.isPrimary($0) }
                    if !secondary.isEmpty {
                        HStack(spacing: 20) {
                            ForEach(secondary, id: \.self) { action in
                                textButton(for: action)
                            }
                        }
                    }
                }
            }
        }
    }

    private static func isPrimary(_ action: LicenseAction) -> Bool {
        action == .buy || action == .renew
    }

    private var explanation: some View {
        // Never "free to use": Unlicensed asks, Licensed thanks
        // (docs/spec/license.md § States and copy).
        Text(
            localization.localizedText(
                license.view?.status == .licensed
                    ? "license.explanationLicensed" : "license.explanation")
        )
        .font(.caption)
        .foregroundStyle(Theme.Plate.inkDim)
    }

    /// One text field for all three accepted shapes (a bare key, `key/activation`,
    /// or a `futonotes://` link) — recognising which is Rust's job, not this
    /// view's. A field with no submit is not operable, so Activate and Cancel
    /// come with it; the desktop projection supplies the same three controls.
    @ViewBuilder private var keyField: some View {
        VStack(alignment: .leading, spacing: 14) {
            TextField(
                localization.localizedText("license.keyLabel"),
                text: $draft,
                prompt: Text(localization.localizedText("license.keyPlaceholder"))
                    .foregroundStyle(Theme.Plate.inkDim)
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .focused($fieldFocused)
            .font(.system(size: 14, design: .monospaced))
            .foregroundStyle(Theme.Plate.ink)
            .tint(Theme.primary)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                Theme.Plate.recess,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .accessibilityIdentifier("license-key-field")
            .onSubmit { Task { await submit() } }

            HStack(spacing: 20) {
                Button {
                    Task { await submit() }
                } label: {
                    filledLabel(
                        license.busy
                            ? localization.localizedText("license.activating")
                            : localization.localizedText("license.activate")
                    )
                }
                .buttonStyle(.plain)
                .disabled(license.busy || submittableDraft.isEmpty)
                .opacity(license.busy || submittableDraft.isEmpty ? 0.5 : 1)
                .accessibilityIdentifier("license-activate")

                Button(role: .cancel) {
                    cancelEntry()
                } label: {
                    textLabel(localization.localizedText("license.cancelEntry"))
                }
                .buttonStyle(.plain)
                .disabled(license.busy)
                .accessibilityIdentifier("license-cancel-entry")
            }
        }
    }

    private func filledButton(for action: LicenseAction) -> some View {
        Button {
            perform(action)
        } label: {
            filledLabel(localization.localizedText(Self.copyPath(for: action)))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(Self.identifier(for: action))
    }

    private func textButton(for action: LicenseAction) -> some View {
        Button {
            perform(action)
        } label: {
            textLabel(localization.localizedText(Self.copyPath(for: action)))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(Self.identifier(for: action))
    }

    /// The filled button keeps the app orange; the plate's gold is for the
    /// eyebrow, the status chip and the text buttons only.
    private func filledLabel(_ text: String) -> some View {
        Text(text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 11)
            .background(Theme.primary, in: Capsule())
    }

    private func textLabel(_ text: String) -> some View {
        Text(text)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Theme.Plate.accent)
    }

    private static func copyPath(for action: LicenseAction) -> String {
        switch action {
        case .buy: return "license.buy"
        case .renew: return "license.renew"
        case .enterKey: return "license.enterKey"
        case .lostKey: return "license.lostKey"
        case .remove: return "license.remove"
        }
    }

    private static func identifier(for action: LicenseAction) -> String {
        switch action {
        case .buy: return "license-buy"
        case .renew: return "license-renew"
        case .enterKey: return "license-enter-key"
        case .lostKey: return "license-lost-key"
        case .remove: return "license-remove"
        }
    }

    private func perform(_ action: LicenseAction) {
        switch action {
        case .buy, .renew:
            open(license.links.buy)
        case .lostKey:
            open(license.links.support)
        case .enterKey:
            entering = true
            draft = ""
            fieldFocused = true
        case .remove:
            license.remove()
        }
    }

    /// Copying is local UI, not a rule: the stored key goes to the pasteboard
    /// verbatim, and the confirmation rides the same banner path as every
    /// license outcome so the user never gets two kinds of toast.
    private func copyKey(_ key: String?) {
        guard let key, !key.isEmpty else { return }
        UIPasteboard.general.string = key
        license.announce(LocalizedMessage("license.card.keyCopied"))
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
