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

/// What the plate puts on screen, before any of it is drawn.
///
/// Four independent yes/no answers, and every one of them is a decision the
/// desktop plate made in September 2026 and this shell was behind on. A free
/// function rather than four `private var`s so the decisions are testable
/// without hosting a SwiftUI view — the same reason `licenseKeyRowText` is one.
struct LicensePlateShape: Equatable {
    /// The 184pt well, and only while Licensed: an empty circle read as
    /// something that had failed to load rather than as "no license".
    let well: Bool
    /// Badge, "Client license" eyebrow, uppercase product name. Letterhead
    /// belongs to a card, and only a stored license makes this one.
    let letterhead: Bool
    /// The whole ledger — there is no "Licensed since" row and no "Term" row,
    /// because nothing records a purchase date and nothing limits a license.
    let keyRow: Bool
    /// "Pay for FUTO Notes". The ask stands in for the letterhead, never
    /// beside it.
    let headline: Bool
}

/// `nil` while the stored pair is still being read: the plate renders its frame
/// and claims nothing (M1).
func licensePlateShape(_ card: LicenseCardModel?) -> LicensePlateShape {
    guard let card else {
        return LicensePlateShape(well: false, letterhead: false, keyRow: false, headline: false)
    }
    let stored = card.maskedKey != nil
    return LicensePlateShape(
        well: card.status == .licensed,
        letterhead: stored,
        keyRow: stored,
        headline: !stored)
}

/// The License card — the FIRST section of Settings on mobile, and the only
/// place a license is visible on this platform (docs/spec/license.md § States
/// and copy).
///
/// It follows the desktop plate, which moved twice in September 2026 and which
/// this shell was two rounds behind until 2026-09-18:
///
///   - **The well exists only while Licensed.** An empty circle read as
///     something that had failed to load rather than as "no license", so the
///     other two states have no 184pt box reserved at all.
///   - **Key is the whole ledger.** Nothing records a purchase date and nothing
///     limits a license, so "Licensed since" and "Term" only ever said blank or
///     "Perpetual". `licenseCardModel` still RETURNS both — it is shared law
///     across the three shells (`license-card-copy`) and did not change; this
///     view simply stopped rendering them.
///   - **Unlicensed has no letterhead.** The badge, the "Client license"
///     eyebrow and the uppercase product name belong to a card, and Unlicensed
///     has no card: it has an ask. The condition is "is there a stored key".
///   - **Unlicensed leads with the ask**, with the reason ABOVE the one filled
///     button rather than under it — the shape Grayjay's Buy screen, FUTO
///     Keyboard's Payment screen and Immich's purchase panel all use.
///   - **The plate sits on the ordinary Settings card surface.** It carried a
///     gunmetal gradient of its own, which read as a foreign object in the
///     sheet; only the gold accent is still the plate's own, because the app has
///     no token for it.
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

    private var shape: LicensePlateShape { licensePlateShape(card) }

    var body: some View {
        Section(localization.localizedText("license.sectionTitle")) {
            plate
                // A different license is a different key: re-mask rather than
                // reveal a key the user never asked to see. Leaving Settings
                // re-masks on its own — the sheet drops this view's @State.
                .onChange(of: license.view?.key) { revealed = false }
        }
    }

    /// The plate keeps the Form's own row background: it is one of the sheet's
    /// cards, not a slab of its own material.
    private var plate: some View {
        VStack(alignment: .leading, spacing: 18) {
            // The well exists only when there is a coin to sit in it.
            if shape.well {
                well.frame(maxWidth: .infinity, alignment: .center)
            }

            if shape.letterhead {
                identity
            }
            if shape.keyRow {
                keyRow
            }
            if shape.headline {
                Text(localization.localizedText("license.unlicensedHeadline"))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("license-headline")
            }

            stateBody(for: license.view?.status)
            secondaryControls
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Where the state is machine-readable from, in EVERY state. It used to
        // hang off the well, and the well is now gone from two of the three
        // states — so the plate, which is always here, carries it. A QA
        // playbook reads `license-plate`'s VALUE; `license-status` still exists
        // as the visible chip, but only where there is a badge to show (Expired).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("license-plate")
        .accessibilityValue(statusName)
    }

    /// The state as one word. Licensed and Unlicensed have no badge to borrow —
    /// Licensed is said by the coin and Unlicensed by the ask — so each reads
    /// its own catalog entry; before the license has been evaluated there is no
    /// state to name.
    private var statusName: String {
        guard let card else { return "" }
        if let badge = card.badge { return badge }
        return localization.localizedText(
            card.status == .licensed ? "license.statusLicensed" : "license.unlicensed")
    }

    /// The reason, the one filled button, and — once Licensed — the thank-you
    /// in its place. Unlicensed and Expired read identically here; only the
    /// button's word differs.
    @ViewBuilder private func stateBody(for status: LicenseStatus?) -> some View {
        if status == nil {
            EmptyView()
        } else if entering {
            keyField
        } else if status == .licensed {
            Text(localization.localizedText("license.explanationLicensed"))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("license-explanation")
        } else {
            // The mission paragraph is the ONLY paragraph, and it sits above
            // the button it argues for: an argument printed under its own
            // button is a footnote (@justin 2026-09-18).
            Text(localization.localizedText("license.explanation"))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("license-explanation")
            ForEach(primaryActions, id: \.self) { action in
                filledButton(for: action)
            }
        }
    }

    /// The well is unpainted space, not a drawn recess: @justin 2026-09-16 asked
    /// for the circle border gone on all three platforms, and the filled disc
    /// plus its inset edge was that border. What is left reserves the box and
    /// carries the accessibility label.
    private var well: some View {
        Color.clear
            .frame(width: Self.wellDiameter, height: Self.wellDiameter)
            .overlay {
                // The well already carries the coin's catalog label, so the
                // coin itself is hidden from VoiceOver rather than being a
                // second stop that says the same thing.
                SupporterCoin(diameter: Self.coinDiameter)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isImage)
            .accessibilityLabel(localization.localizedText("license.coinAccessibilityLabel"))
            .accessibilityIdentifier("license-well")
    }

    /// Status, eyebrow, product name — the letterhead, and only where there is
    /// a card to put it on. Licensed wears no chip: the coin in the well is the
    /// statement.
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
                    .foregroundStyle(.primary)
            }
        }
    }

    /// Expired names itself in a gold chip. Unlicensed used to as well, and
    /// stopped: the section heading already says "License" and the state has no
    /// card to wear a badge on.
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

    /// Key is the whole ledger: label above value, because the key is 39
    /// characters in both its masked and revealed forms and no phone-width
    /// two-column row can hold it.
    private var keyRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(localization.localizedText("license.card.keyLabel"))
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .tracking(0.8)
                .foregroundStyle(.secondary)
            keyValue
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Masked until tapped, then the stored key as plain selectable text. There
    /// is no Copy control: copying is a deliberate press-and-copy, because a
    /// license key should not be one tap from the clipboard (@justin
    /// 2026-09-17). The whole masked value is the button — it is the affordance.
    @ViewBuilder private var keyValue: some View {
        if let card, let shown = licenseKeyRowText(card, key: license.view?.key, revealed: revealed)
        {
            // The same `keyText` in both states, never a Button swapped for a
            // label: that swap changed the row's metrics and moved everything
            // under it. The two branches differ only in what the value DOES —
            // the Text, its font and its frame are identical — and because the
            // mask is the key's own length in a monospace face, the reveal is a
            // glyph-for-glyph swap that moves nothing at all (@justin
            // 2026-09-18).
            if revealed {
                keyText(shown)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("license-key-revealed")
            } else {
                keyText(shown)
                    .contentShape(Rectangle())
                    .onTapGesture { revealed = true }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel(localization.localizedText("license.card.revealKey"))
                    .accessibilityIdentifier("license-key-masked")
            }
        }
    }

    private func keyText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 13, design: .monospaced))
            .foregroundStyle(.primary)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Buy/Renew is the one filled button; everything else is a text button.
    /// The list itself is Rust's (`licenseRowActions`), including what
    /// `LICENSE_LINK_OUT` hides.
    private var primaryActions: [LicenseAction] {
        guard let view = license.view, !entering else { return [] }
        return licenseRowActions(status: view.status, linkOut: linkOut).filter(Self.isPrimary)
    }

    @ViewBuilder private var secondaryControls: some View {
        if let view = license.view, !entering {
            let secondary = licenseRowActions(status: view.status, linkOut: linkOut)
                .filter { !Self.isPrimary($0) }
            if !secondary.isEmpty {
                HStack(spacing: 20) {
                    ForEach(secondary, id: \.self) { action in
                        textButton(for: action)
                    }
                }
            }
        }
    }

    private static func isPrimary(_ action: LicenseAction) -> Bool {
        action == .buy || action == .renew
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
                    .foregroundStyle(.secondary)
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .focused($fieldFocused)
            .font(.system(size: 14, design: .monospaced))
            .foregroundStyle(.primary)
            .tint(Theme.primary)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
                    .stroke(Color(.separator), lineWidth: 1)
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
                .frame(maxWidth: .infinity)
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
