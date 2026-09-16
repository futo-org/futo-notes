import Foundation
import SwiftUI

/// The iOS shell's license state.
///
/// Read once at launch and updated from the result of each action — never
/// re-verified per render and never per keystroke (M5). Every rule behind it
/// lives in `futo-notes-license` and reaches here through the UniFFI
/// projection: this object owns only storage, the toast path, and the fact
/// that this build is iOS. Mirrors the desktop projection's
/// `src/features/license/license.svelte.ts`.
@MainActor
final class LicenseModel: ObservableObject {
    /// `nil` until [load] has read and evaluated the stored pair off the main
    /// actor. The shell renders immediately and fills this reactively (M1).
    @Published private(set) var view: LicenseView?
    /// The Buy / Renew and "Lost your key?" destinations, from Rust, so no
    /// shell hardcodes a URL and all three platforms agree.
    let links: LicenseLinks
    /// True only while the one activation request is in flight.
    @Published private(set) var busy = false

    /// How a message reaches the user. Assigned by the app so the license
    /// module never has to know which banner is on screen; the strings are
    /// catalog paths, because copy is `languages/en.json`'s (§5).
    ///
    /// A launch URL can be delivered before the app has wired this up, so a
    /// message produced in that window is *parked* and flushed the moment a
    /// destination exists — the desktop projection parks a cold-start outcome
    /// for the same reason. Draining is the only read, so one link is announced
    /// exactly once.
    var showMessage: ((LocalizedMessage) -> Void)? {
        didSet {
            guard let pending = parkedMessage, let destination = showMessage else { return }
            parkedMessage = nil
            destination(pending)
        }
    }

    private var parkedMessage: LocalizedMessage?

    private let storage: LicenseStorage
    private let bundleId: String
    private let enterLicenseKey: (String, String) async throws -> LicenseAcceptance
    private var stateRevision = 0

    init(
        storage: LicenseStorage = LicenseStorage(),
        bundleId: String = Bundle.main.bundleIdentifier ?? "",
        enterLicenseKey: @escaping (String, String) async throws -> LicenseAcceptance = {
            input, bundleId in
            try await licenseEnterKey(input: input, bundleId: bundleId)
        }
    ) {
        self.storage = storage
        self.bundleId = bundleId
        self.enterLicenseKey = enterLicenseKey
        self.view = nil
        self.links = licenseLinks(platform: .ios, bundleId: bundleId)
    }

    /// Reads preferences and performs RSA verification away from the actor that
    /// paints the shell. A newer action wins if it lands while this is running.
    func load() async {
        let startingRevision = stateRevision
        let storage = storage
        let bundleId = bundleId
        let evaluated = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(
                    returning: licenseEvaluate(stored: storage.read(), bundleId: bundleId))
            }
        }
        guard startingRevision == stateRevision else { return }
        view = evaluated
    }

    /// Recognise the input, activate it if it was a bare key, verify, and store
    /// — one Rust call. The shell never sequences activate-then-verify (§4.6).
    /// Answers whether a license was accepted, so the field can close itself.
    func enterKey(_ input: String) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        let startingRevision = stateRevision
        do {
            let acceptance = try await enterLicenseKey(input, bundleId)
            guard startingRevision == stateRevision else { return false }
            apply(acceptance)
            return true
        } catch let error as LicenseError {
            // One outcome, one message. A key the endpoint does not know and a
            // pair that does not verify share "isn't valid": the user is never
            // told which (docs/spec/license.md § Entering a key).
            switch error {
            case .Invalid:
                announce(LocalizedMessage("license.keyInvalid"))
            case .Offline:
                announce(LocalizedMessage("license.offline"))
            }
            return false
        } catch {
            // Not one of the two specified failures — a bug, not a bad key. The
            // user still gets the fail-safe message (nothing was stored), but it
            // must not vanish silently (M11).
            print("[license] unexpected failure entering a key: \(error)")
            announce(LocalizedMessage("license.keyInvalid"))
            return false
        }
    }

    /// One delivered `futonotes://` URL, from a cold start or a running app.
    ///
    /// A URL at any other host or path is ignored **silently** — that verdict
    /// is Rust's, so this method cannot accidentally toast for someone else's
    /// link.
    func handle(_ url: URL) {
        switch licenseHandleDeepLink(url: url.absoluteString, bundleId: bundleId) {
        case .ignored:
            return
        case .accepted(let acceptance):
            apply(acceptance)
        case .rejected:
            // A link that fails says so as a *link*: the user never typed a key.
            announce(LocalizedMessage("license.linkInvalid"))
        }
    }

    /// Returns the device to Unlicensed. No confirmation — it is reversible by
    /// re-entering the key — and idempotent.
    func remove() {
        storage.clear()
        stateRevision += 1
        view = licenseEvaluate(stored: nil, bundleId: bundleId)
    }

    /// Wiped by Full reset like every other preference (settings.md, Danger
    /// zone). Deliberately silent: the user is already looking at a reset.
    func clearForFullReset() {
        remove()
    }

    /// Deliver now, or park until there is somewhere to deliver to.
    ///
    /// Not private: the License card copies the key to the pasteboard and has
    /// to confirm it, and that confirmation belongs on the same banner path as
    /// every license outcome rather than on a second one of the view's own.
    func announce(_ message: LocalizedMessage) {
        guard let destination = showMessage else {
            parkedMessage = message
            return
        }
        destination(message)
    }

    private func apply(_ acceptance: LicenseAcceptance) {
        // Storing is the shell's half of the atomic workflow: what Rust
        // accepted is persisted verbatim, and the state it returned is what the
        // row renders — no re-read, no second verdict.
        storage.write(acceptance.pair)
        stateRevision += 1
        view = acceptance.view
        announce(LocalizedMessage("license.activated"))
    }
}
