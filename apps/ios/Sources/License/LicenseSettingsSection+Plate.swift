import SwiftUI

extension LicenseSettingsSection {
    /// The plate keeps the Form's own row background: it is one of the sheet's
    /// cards, not a slab of its own material.
    var plate: some View {
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
            if shape.headline && !entering {
                ask
            } else {
                if shape.headline {
                    headline
                }
                stateBody(for: license.view?.status)
            }
            controls
        }
        .padding(.top, 6)
        .padding(.bottom, rowActions.isEmpty ? 6 : 8)
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
        if license.plate == .appStore {
            return localization.localizedText("license.appStore.purchasedTitle")
        }
        if let badge = card.badge { return badge }
        return localization.localizedText(
            card.status == .licensed ? "license.statusLicensed" : "license.unlicensed")
    }

    var headline: some View {
        Text(localization.localizedText("license.unlicensedHeadline"))
            .font(.title2.bold())
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("license-headline")
    }

    /// The well is unpainted space, not a drawn recess: @justin 2026-09-16 asked
    /// for the circle border gone on all three platforms, and the filled disc
    /// plus its inset edge was that border. What is left reserves the box and
    /// carries the accessibility label.
    var well: some View {
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
    func status(_ badge: String) -> some View {
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
    var keyRow: some View {
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

    /// One text field for all three accepted shapes (a bare key, `key/activation`,
    /// or a `futonotes://` link) — recognizing which is Rust's job, not this
    /// view's. A field with no submit is not operable, so Activate and Cancel
    /// come with it; the desktop projection supplies the same three controls.
    @ViewBuilder var keyField: some View {
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
}
