import SwiftUI

/// What the picker puts on screen, before any of it is drawn.
///
/// A pure function of the license's `includes` and Rust's `licenseRowActions`,
/// so the rendering is testable without hosting a view and no storefront logic
/// lives here: whether the ask sheet is link-out or key-only is only "does the
/// row-action list contain Buy or Renew" (docs/spec/settings.md § Native app
/// icons).
struct AppIconPickerShape: Equatable {
    enum Sheet: Equatable {
        /// Buy (or Renew when Expired) is the filled button.
        case linkOut(primary: LicenseAction)
        /// Key-only builds: "I already paid" is the filled button, nothing else.
        case keyOnly
    }

    /// Tiles wearing the coin. Never dimmed or disabled.
    let coined: Set<AppIcon>
    /// The one footnote under the grid — only while the license does not include icons.
    let footnote: Bool
    /// What tapping a coined tile opens; `nil` once the license includes icons.
    let sheet: Sheet?
    /// False while the license is still being read: unknown is neither
    /// licensed nor unlicensed, so no ask is drawn and a tap does nothing.
    var resolved = true
    /// The ask also offers Buy in the App Store (iOS, ADR-0009): Rust put it in
    /// the row actions, so the product loaded and nothing includes icons yet.
    var appStore = false

    /// The footnote's catalog key. Key-only builds keep "included with a license":
    /// "unlocks" is for link-out builds only (App Store 3.1.1, ADR-0006 D5).
    var footnoteKey: String {
        sheet == .keyOnly
            ? "settings.appIcon.license.footnoteKeyOnly" : "settings.appIcon.license.footnote"
    }

    /// Where a tap on `icon` goes: the ask sheet, or the icon change.
    func asks(_ icon: AppIcon) -> Bool { sheet != nil && coined.contains(icon) }
}

func appIconPickerShape(
    selected: AppIcon,
    includes: Set<LicenseInclusion>?,
    rowActions: [LicenseAction],
    available: Bool = true
) -> AppIconPickerShape {
    // An OS that cannot change icons shows only "unavailable": no ask to make.
    guard available else { return AppIconPickerShape(coined: [], footnote: false, sheet: nil) }
    guard let includes else {
        return AppIconPickerShape(coined: [], footnote: false, sheet: nil, resolved: false)
    }
    if includes.contains(.appIcon) {
        // D13: the coin stays on every icon but Standard, so the picker still
        // shows which ones came with the license.
        return AppIconPickerShape(
            coined: Set(AppIcon.allCases.filter { $0 != .lightStandard }),
            footnote: false, sheet: nil)
    }
    let primary = rowActions.first { $0 == .buy || $0 == .renew }
    return AppIconPickerShape(
        coined: Set(AppIcon.allCases.filter { $0 != selected }),
        footnote: true,
        sheet: primary.map { .linkOut(primary: $0) } ?? .keyOnly,
        appStore: rowActions.contains(.buyInAppStore))
}

struct AppIconPicker: View {
    let controller: AppIconController
    @ObservedObject var license: LicenseModel
    /// The storefront decision, shared with the License card.
    let linkOut: Bool
    /// The one-time header after an activation. Lives only for this presentation.
    let showsLanding: Bool
    /// The icon whose ask is up. Owned by the presenter: the picker's own view
    /// is re-created when the app returns to the foreground (it re-appears with
    /// fresh `@State`), which dropped the sheet from under the user.
    @Binding var asking: AppIcon?
    /// "I already paid": the presenter closes the picker and opens the key field.
    let onAlreadyPaid: () -> Void

    @EnvironmentObject private var store: NotesStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.localization) private var localization
    @Environment(\.scenePhase) private var scenePhase

    private var shape: AppIconPickerShape {
        appIconPickerShape(
            selected: controller.selected,
            includes: license.view == nil ? nil : license.includes,
            rowActions: license.rowActions(linkOut: linkOut),
            available: controller.available)
    }

    var body: some View {
        let shape = shape
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if showsLanding { landingHeader }
                    if !controller.available {
                        Text(localization.localizedText("settings.appIcon.unavailable"))
                    }
                    if controller.failed {
                        Text(localization.localizedText("settings.appIcon.failed"))
                            .foregroundStyle(.red)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16)
                    {
                        ForEach(AppIcon.allCases) { icon in
                            tile(
                                icon, coined: shape.coined.contains(icon), asks: shape.asks(icon),
                                resolved: shape.resolved)
                        }
                    }
                    if shape.footnote { footnote }
                }
                .padding()
            }
            .background(Theme.surface)
            .navigationTitle(localization.localizedText("settings.appIcon.heading"))
            .navigationBarTitleDisplayMode(.inline)
            .tint(Theme.primary)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(localization.localizedText("common.actions.done")) { dismiss() }
                }
            }
        }
        // The `license.activated` toast belongs to whatever is on top: a banner
        // on the Settings screen beneath this sheet would be hidden by it.
        .transientMessageBanner(store)
        .sheet(item: $asking) { icon in
            AppIconAskSheet(
                icon: icon, sheet: shape.sheet ?? .keyOnly, appStore: shape.appStore,
                appStoreBusy: license.appStoreBusy, buyURL: license.appIconLinks.buy,
                onBuyInAppStore: { Task { await license.buyInAppStore() } },
                onAlreadyPaid: onAlreadyPaid, onNotNow: { asking = nil })
        }
        // A license arriving while the ask is up (bought from its sheet, or a
        // key typed after "I already paid"): the sheet drops away and the grid
        // re-renders licensed. Only when the icon is now included — nothing
        // else about the shape may close it.
        .onChange(of: license.includes.contains(.appIcon)) { _, included in
            if included { asking = nil }
        }
        .onAppear { controller.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { controller.refresh() }
        }
    }

    private func tile(_ icon: AppIcon, coined: Bool, asks: Bool, resolved: Bool) -> some View {
        let name = localization.localizedText(icon.labelKey)
        return Button {
            if asks {
                asking = icon
            } else {
                Task { await controller.select(icon) }
            }
        } label: {
            VStack(spacing: 8) {
                Image(icon.previewName)
                    .resizable().scaledToFit()
                    .frame(width: 80, height: 80)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .overlay(alignment: .bottomTrailing) {
                        // Overhangs the corner (center on the rounded corner) so
                        // the coin never reads as part of the icon's artwork.
                        if coined { CoinBadge(diameter: 26).offset(x: 8, y: 8) }
                    }
                Text(name)
                    .multilineTextAlignment(.center)
                Image(systemName: "checkmark.circle.fill")
                    .opacity(controller.selected == icon ? 1 : 0)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(controller.changing || !controller.available || !resolved)
        .accessibilityLabel(
            coined
                ? localization.localizedText(
                    "settings.appIcon.license.a11yIncluded", arguments: ["iconName": name])
                : name
        )
        .accessibilityAddTraits(controller.selected == icon ? .isSelected : [])
        .accessibilityIdentifier("app-icon-" + icon.id)
    }

    private var footnote: some View {
        // The coin is part of the text run, so it follows "license." on the
        // last line instead of floating at the far edge.
        let text = localization.localizedText(shape.footnoteKey)
        // A no-break space keeps the coin with the last word, never orphaned.
        return Text("\(text)\u{00A0}\(Self.inlineCoin)")
            .multilineTextAlignment(.center)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.top, 8)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("app-icon-footnote")
    }

    /// The coin at footnote size, as an image `Text` can carry inline.
    private static let inlineCoin: Image = {
        let side: CGFloat = 13
        guard let coin = UIImage(named: "SupporterCoin") else { return Image(systemName: "circle") }
        let scaled = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            coin.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        return Image(uiImage: scaled)
    }()

    private var landingHeader: some View {
        HStack(alignment: .center, spacing: 12) {
            CoinBadge(diameter: 36, ring: false)
            VStack(alignment: .leading, spacing: 2) {
                Text(localization.localizedText("license.explanationLicensed"))
                    .font(.subheadline.bold())
                Text(
                    localization.localizedText(
                        license.plate == .appStore
                            ? "settings.appIcon.license.landingAppStore"
                            : "settings.appIcon.license.landing")
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(
            Theme.primary.opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("app-icon-landing")
    }
}

/// The supporter coin's flat artwork (the `SupporterCoin` asset, also the
/// fallback of the turning coin), small, with a ring in the surface color so
/// it reads against any icon. Flat on purpose: a spinning 3D coin at 16-36pt
/// reads as a dark disc, and six live RealityViews in a grid are not free.
/// Decorative: the tile's label carries the meaning, and the coin must not
/// swallow the tap meant for the tile.
struct CoinBadge: View {
    let diameter: CGFloat
    var ring = true

    var body: some View {
        Image(decorative: "SupporterCoin")
            .resizable().scaledToFit()
            .frame(width: diameter, height: diameter)
            .padding(ring ? 2 : 0)
            .background(ring ? Theme.surface : .clear, in: Circle())
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// The ask over the picker: what a license includes, and the one way forward
/// the store allows. The shape is decided by the caller (Rust's row actions).
private struct AppIconAskSheet: View {
    let icon: AppIcon
    let sheet: AppIconPickerShape.Sheet
    /// Offer Buy in the App Store: beside Buy with equal weight where the
    /// website is offered, under "I already paid" where the key leads.
    let appStore: Bool
    let appStoreBusy: Bool
    let buyURL: String
    let onBuyInAppStore: () -> Void
    let onAlreadyPaid: () -> Void
    let onNotNow: () -> Void

    @Environment(\.localization) private var localization
    @Environment(\.openURL) private var openURL

    /// The ask's own height, so a sheet with the App Store in it stops where
    /// its content does instead of opening onto empty space at the large
    /// detent.
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            content
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) {
                    contentHeight = $0
                }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .background(Theme.surface)
        .presentationDetents(detents)
        .presentationDragIndicator(.visible)
    }

    private var detents: Set<PresentationDetent> {
        guard appStore else { return [.medium] }
        return contentHeight > 0 ? [.height(contentHeight)] : [.large]
    }

    private var content: some View {
        VStack(spacing: 14) {
            Image(icon.previewName)
                .resizable().scaledToFit()
                .frame(width: 88, height: 88)
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .overlay(alignment: .bottomTrailing) {
                    // Same overhang as the grid tiles, scaled to the larger artwork.
                    CoinBadge(diameter: 34).offset(x: 11, y: 11)
                }
                .padding(.top, 20)
                .padding(.bottom, 4)
                .accessibilityHidden(true)

            Text(localization.localizedText("settings.appIcon.license.sheetTitle"))
                .font(.title3.bold())
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("app-icon-ask-title")
            Text(bodyText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("app-icon-ask-body")

            switch sheet {
            case .linkOut(let primary) where appStore:
                // The same pair as the License card: two ways to pay, each
                // saying what it buys.
                LicenseBuyPair(
                    web: LicenseBuyPair.Choice(
                        title: localization.localizedText(
                            primary == .renew ? "license.renew" : "license.buy"),
                        caption: localization.localizedText("license.buyCaption"),
                        leavesApp: true, id: "app-icon-ask-buy",
                        captionID: "app-icon-ask-buy-caption",
                        action: { if let url = URL(string: buyURL) { openURL(url) } }),
                    appStore: LicenseBuyPair.Choice(
                        title: localization.localizedText("license.appStore.buy"),
                        caption: localization.localizedText("license.appStore.caption"),
                        leavesApp: false, id: "app-icon-ask-buy-app-store",
                        captionID: "app-icon-ask-app-store-scope",
                        action: onBuyInAppStore),
                    appStoreBusy: appStoreBusy
                )
                .padding(.top, 10)
                secondary("settings.appIcon.license.notNow", id: "app-icon-ask-not-now", onNotNow)
                    .padding(.top, 4)
                link("license.enterKey", id: "app-icon-ask-already-paid", onAlreadyPaid)
            case .linkOut(let primary):
                filled(primary == .renew ? "license.renew" : "license.buy", id: "app-icon-ask-buy")
                {
                    if let url = URL(string: buyURL) { openURL(url) }
                }
                HStack(spacing: 32) {
                    link("license.enterKey", id: "app-icon-ask-already-paid", onAlreadyPaid)
                    link("settings.appIcon.license.notNow", id: "app-icon-ask-not-now", onNotNow)
                }
            case .keyOnly:
                filled("license.enterKey", id: "app-icon-ask-already-paid", onAlreadyPaid)
                if appStore {
                    outlined(
                        "license.appStore.buy", id: "app-icon-ask-buy-app-store", onBuyInAppStore
                    )
                    .disabled(appStoreBusy)
                    scope("license.appStore.scope")
                }
                link("settings.appIcon.license.notNow", id: "app-icon-ask-not-now", onNotNow)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private var bodyText: String {
        switch sheet {
        case .linkOut: localization.localizedText("settings.appIcon.license.sheetBody")
        case .keyOnly: localization.localizedText("license.keyOnlyExplanation")
        }
    }

    private func filled(_ path: String, id: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(localization.localizedText(path))
                .font(.headline)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Theme.primary, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }

    private func outlined(_ path: String, id: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(localization.localizedText(path))
                .font(.headline)
                .foregroundStyle(Theme.primary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .overlay(Capsule().stroke(Theme.primary, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }

    private func scope(_ path: String) -> some View {
        Text(localization.localizedText(path))
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("app-icon-ask-app-store-scope")
    }

    /// Not now beside the pair: quiet, and still a full-size target.
    private func secondary(_ path: String, id: String, _ action: @escaping () -> Void)
        -> some View
    {
        Button(action: action) {
            Text(localization.localizedText(path))
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Color.primary.opacity(0.06), in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }

    private func link(_ path: String, id: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(localization.localizedText(path))
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.primary)
                .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}
