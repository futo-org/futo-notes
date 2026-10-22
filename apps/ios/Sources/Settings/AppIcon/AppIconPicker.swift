import SwiftUI

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
        // The picker's verbs while its ask is not up over it; the ask has its own.
        .puppetVerbs(modal: true) {
            guard asking == nil else { return [] }
            return [
                // A tap on a tile: the ask for an icon a license includes, otherwise the change.
                PuppetVerbs.Verb("SelectAppIcon", required: ["icon"]) { arguments in
                    let id = arguments["icon"] as? String ?? ""
                    guard let icon = AppIcon(rawValue: id) else {
                        let ids = AppIcon.allCases.map(\.id).joined(separator: ", ")
                        throw PuppetVerbRefusal(400, "no icon \(id): one of \(ids)")
                    }
                    guard controller.available, !controller.changing else {
                        throw PuppetVerbRefusal(409, "the icons are disabled while one is changing")
                    }
                    let shape = shape
                    guard shape.resolved else {
                        throw PuppetVerbRefusal(
                            503, "the icons are disabled until the license is read")
                    }
                    if shape.asks(icon) {
                        asking = icon
                    } else {
                        await controller.select(icon)
                    }
                    return [:]
                },
                PuppetVerbs.Verb("CloseAppIcons", controls: ["common.actions.done"]) { dismiss() },
            ]
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
        .puppetVerbs(modal: true) {
            var verbs: [PuppetVerbs.Verb] = []
            if case .linkOut = sheet {
                verbs.append(PuppetVerbs.Verb("BuyLicense") { buy() })
            }
            if appStore {
                verbs.append(
                    PuppetVerbs.Verb("BuyLicenseInAppStore") {
                        if appStoreBusy {
                            throw PuppetVerbRefusal(409, "an App Store purchase is running")
                        }
                        onBuyInAppStore()
                    })
            }
            verbs.append(PuppetVerbs.Verb("StartLicenseEntry") { onAlreadyPaid() })
            verbs.append(PuppetVerbs.Verb("DismissDialog") { onNotNow() })
            return verbs
        }
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
                        action: buy),
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
                filled(primary == .renew ? "license.renew" : "license.buy", id: "app-icon-ask-buy", buy)
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

    /// Buy leaves the app for the system browser, as the License card's does.
    private func buy() {
        guard let url = URL(string: buyURL) else { return }
        openURL(url)
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
