### 5. Smallest viable design, risk, and code shape

**Surfaces:**

| Surface | License card (Unlicensed) | Icon sheet | Risk |
|---|---|---|---|
| iOS US | Two equal buttons: "Buy on FUTO's website" (default browser) and "Buy in the App Store"; then "I already paid", "Restore Purchases", "Lost your key?" | Same two equal buttons + "I already paid" | **Low-medium.** Equal weight follows the Ninth Circuit's parity rule. Ranking the website first is fine. |
| iOS everywhere else | Key-only copy, then secondary "Buy in the App Store", "I already paid", "Restore Purchases" | Secondary "Buy in the App Store" + "I already paid" | **Low.** 3.1.3(b) satisfied. Only risk: the reviewer can't find it (mitigate with review notes). |
| iOS, App Store entitlement owned, no key | "Purchased in the App Store" plate: where it works, no key, no Remove (an App Store purchase can't be removed from the device) | n/a (licensed) | Low |
| Android `play` / `direct`, desktop | Unchanged from the main proposal | Unchanged | Unchanged |

With an IAP in every iOS storefront, the vocabulary rule ("unlock(s)" only where a purchase is
offered) would allow "unlocks" on iOS everywhere. Whether to relax it is Justin's call; the safe
default is to keep "included with a license" outside the US.

**Code shape in this repo:**

- **Rust (`crates/futo-notes-license`, projected by `crates/futo-notes-ffi`):** `license_includes`
  takes the store fact as an input instead of reading only the key status, e.g.
  `license_includes(status: LicenseStatus, store_entitlement: bool) -> Vec<LicenseInclusion>`, or
  better a small `LicenseEvidence { key: LicenseStatus, app_store: bool }`.
  - Truth table owned in Rust:
    - key Licensed → everything;
    - app_store true → everything, including with an Expired or Unlicensed key;
    - otherwise → nothing.
  - `license_row_actions` gains `BuyInAppStore` and `RestorePurchases` and takes the purchase
    surface plus `store_purchase_available` / `app_store` as inputs.
  - The card state becomes a Rust answer too, so Swift does not decide which plate to show. One
    option is a `LicenseCard` variant for "App Store purchase".
  - The product id (e.g. `com.futo.notes.license`) is a Rust config constant beside
    `pay2_base_url`, environment-split if a `.dev` product is created.
  - Tests: the truth table and row actions per surface in Rust unit tests and the FFI contract
    tests.
- **iOS shell (`apps/ios/Sources/License/`):** a new `LicenseAppStore.swift`, StoreKit I/O only:
  - `Product.products(for:)` and `product.purchase()`;
  - read `Transaction.currentEntitlements` for the product id, counting only `.verified` results
    with no `revocationDate`;
  - listen to `Transaction.updates` from launch and call `transaction.finish()`;
  - `AppStore.sync()` only on the Restore tap;
  - publish `appStore: Bool`.
  - The shell passes that boolean into Rust and renders what Rust returns. StoreKit's
    verification is platform I/O, like reading the keychain, not a copy of the rule. Swift never
    decides what a purchase includes.
  - Tests: a `.storekit` configuration file with `SKTestSession` covering buy, restore, refund
    (`refundTransaction`) and an unverified transaction.
- **Android, desktop:** no change for the IAP. Android carries only the main proposal's
  `NameWebsite` surface.
- **Store setup (human, Justin):**
  - Paid Apps Agreement;
  - a non-consumable product with Family Sharing **off** and a review screenshot;
  - review notes giving the path to the purchase and explaining the key field under 3.1.3(b).
- **Docs:**
  - ADR-0003's "no IAP" clause is reversed for iOS.
  - ADR-0007's routing is revived for iOS, without its offline-proof design and without
    ADR-0008's redemption: StoreKit verifies on the device and no key is minted.
  - `docs/spec/license.md`: the US "only filled button" rule (~616), the key-only lines (~175–183,
    ~350), § Store posture.
  - Plan D24/D25/D29 status.

**Residual risks:**

1. A reviewer can't find a secondary IAP: low; review notes fix it.
2. Apple starts enforcing the parity rule: low if the US buttons are equal from day one.
3. Buyers expect the App Store purchase on Android or desktop: product risk, not review risk;
   the card copy carries it.
4. If license sync (M6) or a store purchase that becomes a key ever returns, an App Store purchase
   has no key to carry, so it would need its own path then.

**Unknowns (follow-up):**

- Whether Apple has applied the Ninth Circuit's parity permission in any rejection since
  2025-12-11. Nothing appears in the guidelines as of 2026-10-19.
- The current Small Business Program rate and whether a privacy-label change is needed (not
  re-read).
- Whether a reviewer accepts an Unlicensed card where the key field comes first and the IAP comes
  second. No rule forbids it and I found no rejection for it, but there is no positive precedent
  either.

Sources (fetched 2026-10-19):
[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) (both halves of
the page searched);
[Ninth Circuit opinion 25-2935, 2025-12-11](https://cdn.ca9.uscourts.gov/datastore/opinions/2025/12/11/25-2935.pdf)
(pp. 34-35, 41, 53-54);
[AppStore.sync()](https://developer.apple.com/documentation/storekit/appstore/sync());
[Transaction.currentEntitlements](https://developer.apple.com/documentation/storekit/transaction/currententitlements);
[Supporting Family Sharing](https://developer.apple.com/documentation/storekit/supporting-family-sharing-in-your-app);
Apple EU/Japan/Brazil payment-options pages (linked in the rules table above);
[Play consumption-only](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en);
[mjtsai on Cameron v. Apple (secondary)](https://mjtsai.com/blog/2021/08/27/cameron-v-apple-settlement/);
Apple developer forums [728321](https://developer.apple.com/forums/thread/728321) and
[817493](https://developer.apple.com/forums/thread/817493) (developer reports).
