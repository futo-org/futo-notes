#### The StoreKit purchase

- **Offered only when the product loads.** No product (or StoreKit failing)
  means no App Store controls; the card never waits on it (M1).
- **Controls**, in display order — Rust's `license_evidence_row_actions`:

  | Plate | US (link out) | Elsewhere (key only) |
  |---|---|---|
  | Unlicensed | **Buy a license** · **Buy in App Store** · I already paid · Restore Purchases · Lost your key? | I already paid · Buy in App Store · Restore Purchases |
  | Expired | **Renew** · **Buy in App Store** · I already paid · Restore Purchases · Lost your key? | I already paid · Buy in App Store · Restore Purchases |
  | App Store | I already paid | I already paid |
  | Licensed (key) | Remove license | Remove license |

  In the US, Buy/Renew and Buy in App Store are **one pair, side by side,
  both filled, same style and size** (the Ninth Circuit lets Apple forbid a
  web button more prominent than its own), website first, stacked only when a
  label would not fit. Each has its own one-line caption under it:
  `license.buyCaption` ("Every platform, with a license key") and
  `license.appStore.caption` ("iPhone and iPad, no license key"). The card
  holds only the headline, the supporter coin and the pair; I already paid
  (with `license.enterKeyHint` trailing on the same line), Restore Purchases
  and Lost your key? are compact list rows in their own group under it
  (@justin 2026-10-19). Elsewhere the key
  leads and Buy in App Store is an **outlined**, labeled secondary button with
  `license.appStore.scope` directly under it (never the website, a price, or
  "everywhere"). → `licenseControlGroups`, `LicenseBuyPair`,
  `AppStorePurchaseTests` "testUSCardOffersBothBuysWithEqualWeight",
  "testNonUSCardKeepsTheKeyFirst"
- **The App Store plate**: "Purchased in the App Store"
  (`license.appStore.purchasedTitle`) and `license.appStore.purchasedBody`; no
  well, letterhead or key row — not even for an expired key stored beside it —
  and **no Remove**: a purchase cannot be removed from an Apple Account. I
  already paid stays so a key bought later has somewhere to go. Removing a
  Licensed key falls back to this plate when the purchase is owned.
- **Buy** runs `Product.purchase()`. Success lands on the picker (M5). Ask to
  Buy (pending) and a cancel change nothing and say nothing.
- **Restore Purchases** runs `AppStore.sync()` only from its tap (it can show an
  Apple Account sign-in), then re-reads entitlements; nothing owned toasts
  `license.appStore.nothingToRestore`. A purchase already on the account is
  owned at launch with no tap (`Transaction.currentEntitlements`).
- **Refunds and revocations** arrive on `Transaction.updates`, listened to for
  the life of the app: ownership clears live, the icon already set stays (the
  gate is on choosing), and the picker asks again. Only verified transactions
  without a `revocationDate` count. → `LicenseAppStore.swift`,
  `LicenseAppStoreTests`, `AppStorePurchaseTests` "testRefundReturnsTheAsk"
- Debug and tests use `apps/ios/StoreKit/FutoNotes.storekit`, the scheme's
  StoreKit configuration for both Run and Test (`scripts/ios-scheme-test-storekit.mjs`
  adds the Test one after `xcodegen`; without it `xcodebuild` starts no local
  StoreKit server). Tests open their own `SKTestSession`; the unit-test host
  skips the app's launch-time StoreKit observer so the session is in place
  before the first product lookup. _(Debug only)_ `-FUTOAppStoreOffered` shows
  the App Store controls with no product loaded (screenshots; Buy does nothing).
- **Verification 2026-10-19.** Xcode 27.1, `futo-appstore-ios27` (iPhone Duo,
  iOS 27.1): `LicenseAppStoreTests` 10/10 and the whole unit bundle 268/268;
  `AppStorePurchaseTests` 5/5 (US and FRA cards, icon-sheet purchase landing,
  Restore, refund), `LicensePlateTests` 3/3. `SKTestSession` cannot configure an
  iOS 26.5 simulator from Xcode 27.1 (`SKInternalErrorDomain` 3: "Fetching the
  Octane server port is no longer supported"), so local StoreKit testing needs a
  runtime matching Xcode; a freshly erased matching simulator also loads no product
  on its first run. Without a working environment `AppStore.sync()` waits forever
  on an Apple Account sign-in, so both StoreKit suites probe once and fail fast
  with that reason, or skip with it under `FUTO_STOREKIT_TESTS_OPTIONAL=1`
  (`just test-ios-native` sets it; CI does not). A real TestFlight purchase is
  still to do.
