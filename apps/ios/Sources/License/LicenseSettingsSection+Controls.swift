import SwiftUI

extension LicenseSettingsSection {
    /// Unlicensed with the website offered: the headline and its reason as one
    /// block, with the supporter coin beside them as the card's mark.
    var ask: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                headline
                if let status = license.view?.status {
                    Text(
                        localization.localizedText(
                            licenseExplanationPath(status: status, linkOut: linkOut))
                    )
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("license-explanation")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            CoinBadge(diameter: 30, ring: false)
                .padding(.top, 1)
        }
    }

    /// The reason above the controls it argues for, and — once Licensed — the
    /// thank-you in its place. Unlicensed and Expired read identically here;
    /// only the button's word differs.
    @ViewBuilder func stateBody(for status: LicenseStatus?) -> some View {
        if status == nil {
            EmptyView()
        } else if entering {
            keyField
        } else if license.plate == .appStore {
            VStack(alignment: .leading, spacing: 8) {
                Text(localization.localizedText("license.appStore.purchasedTitle"))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("license-app-store-title")
                Text(localization.localizedText("license.appStore.purchasedBody"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("license-explanation")
            }
            .fixedSize(horizontal: false, vertical: true)
        } else if status == .licensed {
            Text(
                localization.localizedText(
                    licenseExplanationPath(status: .licensed, linkOut: linkOut))
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("license-explanation")
        } else if let status {
            // The mission paragraph is the ONLY paragraph, and it sits above
            // the button it argues for: an argument printed under its own
            // button is a footnote (@justin 2026-09-18).
            Text(
                localization.localizedText(licenseExplanationPath(status: status, linkOut: linkOut))
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("license-explanation")
        }
    }

    /// Every control, in Rust's order (`licenseControlGroups`). The rows under
    /// a pair are not here: they are their own Section (`body`).
    @ViewBuilder var controls: some View {
        let groups = licenseControlGroups(actions)
        ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
            switch group {
            case .pair(let web):
                LicenseBuyPair(
                    web: pairChoice(for: web),
                    appStore: pairChoice(for: .buyInAppStore),
                    appStoreBusy: license.appStoreBusy
                )
                .padding(.top, 4)
            case .outlined(.buyInAppStore):
                // What the purchase is not, directly under it.
                VStack(alignment: .leading, spacing: 8) {
                    outlinedButton(for: .buyInAppStore)
                    Text(localization.localizedText("license.appStore.scope"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("license-app-store-scope")
                }
            case .filled(let action):
                filledButton(for: action)
            case .outlined(let action):
                outlinedButton(for: action)
            case .text(let run):
                textRow(run)
            case .rows:
                EmptyView()
            }
        }
    }

    private func pairChoice(for action: LicenseAction) -> LicenseBuyPair.Choice {
        LicenseBuyPair.Choice(
            title: localization.localizedText(Self.copyPath(for: action)),
            caption: localization.localizedText(
                action == .buyInAppStore ? "license.appStore.caption" : "license.buyCaption"),
            leavesApp: action != .buyInAppStore,
            id: Self.identifier(for: action),
            captionID: action == .buyInAppStore
                ? "license-app-store-scope" : "license-buy-caption",
            action: { perform(action) })
    }

    /// One list row under the pair: the app's orange glyph, the action, and
    /// where it goes — on into the key field, or out of the app.
    func actionRow(for action: LicenseAction) -> some View {
        Button {
            perform(action)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: Self.rowSymbol(for: action))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.primary)
                    .frame(width: 20)
                // Label colors, not `.primary`: inside a Form button that
                // resolves to the tint, and the rows are not links.
                Text(localization.localizedText(Self.copyPath(for: action)))
                    .font(.subheadline)
                    .foregroundStyle(Color(.label))
                    .layoutPriority(1)
                Spacer(minLength: 8)
                if action == .enterKey {
                    Text(localization.localizedText("license.enterKeyHint"))
                        .font(.footnote)
                        .foregroundStyle(Color(.secondaryLabel))
                        .lineLimit(1)
                }
                switch action {
                case .enterKey:
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color(.tertiaryLabel))
                case .lostKey:
                    Image(systemName: "arrow.up.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color(.tertiaryLabel))
                default:
                    EmptyView()
                }
            }
            .contentShape(Rectangle())
        }
        .accessibilityIdentifier(Self.identifier(for: action))
    }

    private static func rowSymbol(for action: LicenseAction) -> String {
        switch action {
        case .enterKey: return "key.horizontal"
        case .restorePurchases: return "arrow.clockwise"
        case .lostKey: return "questionmark.circle"
        default: return "circle"
        }
    }

    /// Neighboring text buttons on one line when they fit, stacked when they
    /// don't (three of them overflow a phone at larger text sizes).
    private func textRow(_ run: [LicenseAction]) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 20) {
                ForEach(run, id: \.self) { textButton(for: $0) }
            }
            VStack(alignment: .leading, spacing: 12) {
                ForEach(run, id: \.self) { textButton(for: $0) }
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

    private func outlinedButton(for action: LicenseAction) -> some View {
        Button {
            perform(action)
        } label: {
            Text(localization.localizedText(Self.copyPath(for: action)))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.primary)
                .padding(.horizontal, 18)
                .padding(.vertical, 11)
                .frame(maxWidth: .infinity)
                .overlay(Capsule().stroke(Theme.primary, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .disabled(license.appStoreBusy)
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
    func filledLabel(_ text: String) -> some View {
        Text(text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 11)
            .background(Theme.primary, in: Capsule())
    }

    func textLabel(_ text: String) -> some View {
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
        case .buyInAppStore: return "license.appStore.buy"
        case .restorePurchases: return "license.appStore.restore"
        }
    }

    private static func identifier(for action: LicenseAction) -> String {
        switch action {
        case .buy: return "license-buy"
        case .renew: return "license-renew"
        case .enterKey: return "license-enter-key"
        case .lostKey: return "license-lost-key"
        case .remove: return "license-remove"
        case .buyInAppStore: return "license-buy-app-store"
        case .restorePurchases: return "license-restore-purchases"
        }
    }
}
