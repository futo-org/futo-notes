import SwiftUI
import UIKit

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
/// Nothing that works is gated on a license: a purchase changes this card and
/// adds only purely cosmetic choices (today the app icon — Rust's
/// `licenseIncludes`, docs/spec/license.md § What a license includes). The card
/// itself gains no sentence for them. Which controls each state offers is
/// Rust's answer (`licenseRowActions`), and how each state reads is the shared
/// card model (`licenseCardModel`), so iOS and Android render the same thing.
/// The storefront decision is shared by copy and actions.
struct LicenseSettingsSection: View {
    @ObservedObject var license: LicenseModel
    /// The observed storefront decision, shared by copy and actions.
    let linkOut: Bool
    /// Bumped by the App icon picker's "I already paid": open the key field.
    var keyEntryRequest = 0

    @Environment(\.localization) var localization
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var navigation: AppNavigation

    @State var entering = false
    @State var draft = ""
    /// Reveal lasts only while the card is on screen: leaving Settings, or a
    /// license arriving or being removed, re-masks it.
    @State var revealed = false
    @FocusState var fieldFocused: Bool

    /// The well and the coin, in points. Named because two of the three
    /// platforms quote the same numbers.
    static let wellDiameter: CGFloat = 184
    static let coinDiameter: CGFloat = 160

    /// What is actually submitted — the one definition of "the field has
    /// something in it", so the button's enabled state and the submit guard
    /// can never disagree.
    var submittableDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `nil` until the license has been read and evaluated off the main actor.
    /// The plate still renders its frame in that window — the shell never waits
    /// on I/O to paint (M1).
    var card: LicenseCardModel? {
        license.view.map { licenseCardModel($0, localization) }
    }

    var shape: LicensePlateShape {
        licensePlateShape(card, linkOut: linkOut, appStorePlate: license.plate == .appStore)
    }

    /// Rust's controls for this evidence and storefront; none while the key
    /// field is open.
    var actions: [LicenseAction] {
        entering ? [] : license.rowActions(linkOut: linkOut)
    }

    /// The list under a pair; empty everywhere else.
    var rowActions: [LicenseAction] {
        licenseControlGroups(actions).flatMap { group -> [LicenseAction] in
            if case .rows(let run) = group { run } else { [] }
        }
    }

    var body: some View {
        Section(localization.localizedText("license.sectionTitle")) {
            plate
                // A different license is a different key: re-mask rather than
                // reveal a key the user never asked to see. Leaving Settings
                // re-masks on its own — the sheet drops this view's @State.
                .onChange(of: license.view?.key) { revealed = false }
                .puppetVerbs { puppetVerbs }
                .onChange(of: keyEntryRequest) {
                    if let status = license.view?.status, status != .licensed {
                        perform(.enterKey)
                    }
                }
        }
        // The rows read as the card's continuation, not the next topic.
        .listSectionSpacing(rowActions.isEmpty ? .default : .custom(12))
        if !rowActions.isEmpty {
            Section {
                ForEach(rowActions, id: \.self) {
                    actionRow(for: $0)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            }
            // Secondary to the pair above: compact rows, not full list rows.
            .environment(\.defaultMinListRowHeight, 36)
        }
    }

    func perform(_ action: LicenseAction) {
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
        case .buyInAppStore:
            Task { await license.buyInAppStore() }
        case .restorePurchases:
            Task { await license.restorePurchases() }
        }
    }

    /// Each verb is offered exactly while its control is on the plate and no sheet covers it.
    private var puppetVerbs: [PuppetVerbs.Verb] {
        guard navigation.sheet == .settings else { return [] }
        if entering {
            return [
                PuppetVerbs.Verb(
                    "ActivateLicense", required: ["licenseKey"],
                    controls: [
                        "license.keyLabel", "license.keyPlaceholder", "license.activate",
                        "license.activating",
                    ]
                ) { arguments in
                    draft = (arguments["licenseKey"] as? String) ?? ""
                    if license.busy { throw PuppetVerbRefusal(409, "the license is busy") }
                    await submit()
                    return [:]
                },
                PuppetVerbs.Verb("CancelLicenseEntry", controls: ["license.cancelEntry"]) {
                    if license.busy { throw PuppetVerbRefusal(409, "the license is busy") }
                    cancelEntry()
                },
            ]
        }
        guard license.view != nil else { return [] }
        var verbs: [PuppetVerbs.Verb] = []
        if shape.keyRow, !revealed {
            verbs.append(PuppetVerbs.Verb("ShowLicenseKey") { revealed = true })
        }
        // The plate's buttons are labelled from their action (`copyPath`), so no verb can name
        // one by its catalog key; only the "I already paid" row's hint is a key of its own.
        for action in actions {
            let tap: () async throws -> Void = { perform(action) }
            switch action {
            case .buy, .renew: verbs.append(PuppetVerbs.Verb("BuyLicense", tap: tap))
            case .enterKey:
                verbs.append(
                    PuppetVerbs.Verb(
                        "StartLicenseEntry", controls: ["license.enterKeyHint"], tap: tap))
            case .lostKey: verbs.append(PuppetVerbs.Verb("OpenLostKeyHelp", tap: tap))
            case .remove: verbs.append(PuppetVerbs.Verb("RemoveLicense", tap: tap))
            case .buyInAppStore:
                verbs.append(
                    PuppetVerbs.Verb("BuyLicenseInAppStore") {
                        // The button is disabled while a purchase or a restore is running.
                        if license.appStoreBusy {
                            throw PuppetVerbRefusal(409, "an App Store purchase is running")
                        }
                        perform(action)
                    })
            case .restorePurchases: verbs.append(PuppetVerbs.Verb("RestorePurchases", tap: tap))
            }
        }
        return verbs
    }

    func submit() async {
        guard !submittableDraft.isEmpty else { return }
        if await license.enterKey(draft) {
            cancelEntry()
        }
    }

    func cancelEntry() {
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
