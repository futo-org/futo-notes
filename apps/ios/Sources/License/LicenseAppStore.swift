import Combine
import StoreKit

/// StoreKit I/O for the App Store-only purchase (ADR-0009), and nothing else.
///
/// What owning it includes, which card it shows and which controls the card
/// offers are Rust's answers (`licenseEvidenceIncludes`, `licensePlate`,
/// `licenseEvidenceRowActions`): this object only reports the two facts
/// StoreKit knows — whether the product loaded, and whether this Apple Account
/// owns it. StoreKit verifies the purchase on the device; no server sees it.
@MainActor final class LicenseAppStore: ObservableObject {
    /// The product loaded, so the card may offer Buy in the App Store and
    /// Restore Purchases. False until StoreKit answers and whenever it can't:
    /// the card never waits on this (M1).
    @Published private(set) var offered = false
    /// A verified, unrevoked transaction for the product exists for this
    /// Apple Account.
    @Published private(set) var owned = false

    let productID: String
    private var product: Product?

    init(productID: String = licenseAppStoreProductId()) {
        self.productID = productID
    }

    /// For the life of the app: listen for transactions first, so a purchase
    /// approved elsewhere (Ask to Buy, another device) or a refund is never
    /// missed, then read what the account already owns and load the product.
    func observe() async {
        let listener = Task { [weak self] in
            for await update in Transaction.updates {
                await self?.apply(update)
            }
        }
        await refreshOwned()
        await loadProduct()
        await withTaskCancellationHandler {
            await listener.value
        } onCancel: {
            listener.cancel()
        }
    }

    func loadProduct() async {
        #if FUTO_DEBUG_BUILD
            // QA and App Review screenshots: the controls as they look once the
            // product exists, before App Store Connect has it. Buy does nothing.
            if ProcessInfo.processInfo.arguments.contains("-FUTOAppStoreOffered") {
                offered = true
                return
            }
        #endif
        do {
            product = try await Product.products(for: [productID]).first
        } catch {
            print("[license] App Store product failed to load: \(error)")
            product = nil
        }
        offered = product != nil
    }

    /// Answers whether the account owns the product afterwards. Ask to Buy
    /// (`.pending`) and a cancel change nothing and show nothing: StoreKit's
    /// own sheet already said what happened.
    func buy() async -> Bool {
        guard let product else { return false }
        do {
            switch try await product.purchase() {
            case .success(let result):
                await apply(result)
            case .pending, .userCancelled:
                break
            @unknown default:
                break
            }
        } catch {
            print("[license] App Store purchase failed: \(error)")
        }
        return owned
    }

    /// Only from the Restore Purchases tap: `AppStore.sync()` can put up an
    /// Apple Account sign-in. Answers whether the account owns the product.
    func restore() async -> Bool {
        do {
            try await AppStore.sync()
        } catch {
            print("[license] App Store sync failed: \(error)")
        }
        await refreshOwned()
        return owned
    }

    func refreshOwned() async {
        var found = false
        // `currentEntitlements(for:)` is iOS 18.4; the app targets 18.0.
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result, transaction.productID == productID,
                transaction.revocationDate == nil
            {
                found = true
            }
        }
        owned = found
    }

    /// An unverified transaction is ignored outright: it never grants, and it
    /// never revokes either. A verified one is finished, and ownership is then
    /// re-read from the current entitlements rather than taken from this one
    /// transaction: updates do not arrive in purchase order, so an older,
    /// unfinished purchase delivered after a refund must not undo it.
    private func apply(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let transaction) = result, transaction.productID == productID
        else { return }
        await transaction.finish()
        await refreshOwned()
    }
}
