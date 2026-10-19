# iOS App Store-only purchase — implementation plan

Status: written 2026-10-19 for an agent on a Mac. Decision: [ADR-0009](../adr/0009-ios-sells-an-app-store-only-purchase.md).
The rules research behind every claim here, with sources and dates, is
[`license-ios-app-store/research-2026-10-19.md`](license-ios-app-store/research-2026-10-19.md)
(its "Buried IAP" section and the refinement after it). Master plan row: W10 in
[`license-master-plan.md`](license-master-plan.md).

Read first: root `AGENTS.md`, `apps/ios/AGENTS.md`, `crates/futo-notes-license/AGENTS.md`,
`crates/futo-notes-ffi/AGENTS.md`, `docs/spec/license.md`, and
[`license-cosmetics.md`](license-cosmetics.md) § 0-5 (what a license includes, D1-D14).

## 1. What we are building

One StoreKit 2 **non-consumable** in the iOS app. Owning it includes, inside the iOS app, exactly
what a Licensed key includes (today: choosing the app icon). StoreKit verifies it on the device.
There is no server call, no FUTOpay key, and nothing reaches desktop, Android or sync. The License
card says so: it works on iPhone and iPad with the buyer's Apple Account and does not come with a
license key.

Why: Apple 3.1.1 forbids a license key that enables anything in the app unless the same thing is
"also available as in-app purchases within the app" (3.1.3(b)). This purchase is that "also".

Not in scope: Android, desktop, lib-polar, the sync server, license sync (M6), refunds beyond what
StoreKit does on its own, a price shown by our own copy.

## 2. Before you start: what @justin does in App Store Connect

These block real-purchase testing only. Everything else runs against a local StoreKit
configuration file, so start without them.

1. Accept the Paid Apps Agreement; tax and banking.
2. Create the non-consumable: product id `com.futo.notes.license`, $14.99 USD, Family Sharing
   **off** (§ 9). Display name and
   description: the description is metadata and must not mention the website or a key price
   (recommended: "Included-with-a-license features in FUTO Notes for iPhone and iPad. Doesn't
   include a license key.").
3. Turn off availability on Apple silicon Macs ("Designed for iPad"), so "iPhone and iPad" in
   the copy stays true (§ 9.3).
4. A review screenshot of the purchase, and review notes: "Settings › License › Buy in the App
   Store. A license key bought on the web is accepted under 3.1.3(b); the same items are sold here
   as an in-app purchase."
5. Sandbox tester account(s) for a TestFlight check.

## 3. Order relative to the other branches

The stack is `main` ← !426 (`feat/license-cosmetics-ios`, iOS icon gating) ← W2
(`feat/license-cosmetics-android`, Android parity) ← W9 (Android `play` names `pay.futo.org`).
W9 turns the boolean `license_link_out` into a three-way purchase surface in Rust (link out, name
the website, key only). Base this work on the **newest pushed branch in that stack** and expect to
rebase once more; the Rust conflicts will be in `crates/futo-notes-license/src/config.rs`,
`state.rs` and `crates/futo-notes-ffi/src/license/contract.rs`. Do not reimplement W9's surface
enum; extend whatever it landed.

## 4. Rust: the rule takes the App Store fact as an input

Today (`crates/futo-notes-license/src/state.rs`): `license_includes(status) -> Vec<LicenseInclusion>`
with Licensed → `[AppIcon]`, else nothing. `crates/futo-notes-ffi/src/license/contract.rs` projects
it plus `license_row_actions(status, link_out)` and `LicenseAction { Buy, Renew, EnterKey, LostKey, Remove }`.

Recommended shape (adjust names to what W9 landed):

- `LicenseEvidence { key: LicenseStatus, app_store: bool }`, the two facts a device can hold.
- `license_includes(evidence)`: key Licensed → everything; `app_store` true → **the same
  everything** (with an Unlicensed or Expired key too); otherwise nothing. One table; a unit test
  asserts the App Store row equals the Licensed row so the two can never drift (3.1.3(b) parity).
- The card's plate is a Rust answer, so Swift does not choose it: `Licensed` (key), `AppStore`
  (purchase owned, no Licensed key), `Expired`, `Unlicensed`. A Licensed key wins over the App
  Store plate (it carries more: a key, Remove, other platforms).
- Row actions take the surface plus "an App Store product is offered on this build" (iOS only;
  false on Android and desktop). New actions `BuyInAppStore` and `RestorePurchases`:

| Plate | iOS US (link out) | iOS elsewhere (key only) |
|---|---|---|
| Unlicensed | Buy (website), BuyInAppStore, EnterKey, RestorePurchases, LostKey | EnterKey, BuyInAppStore, RestorePurchases |
| Expired | Renew (website), BuyInAppStore, EnterKey, RestorePurchases, LostKey | EnterKey, BuyInAppStore, RestorePurchases |
| AppStore | EnterKey | EnterKey |
| Licensed (key) | Remove | Remove |

  Order in the table is display order. Outside the US the key field stays first and the App Store
  button is secondary. In the US, Buy and BuyInAppStore are **equal weight** (§ 5). AppStore has no
  Remove: a purchase cannot be removed from an Apple Account. EnterKey there lets someone who later
  buys a key store it.
- FFI: additive. The shipped shells switch over `LicenseAction` exhaustively, so either extend it
  and update both shells in the same MR (Android only needs to compile and never receives the new
  cases), or add a new enum and keep the old function as an adapter. Prefer the first if W9 already
  moved Android to a new shape.
- The product id is a crate constant beside `pay2_base_url` in `config.rs`, read by the shell, so
  Swift does not hardcode it.
- Conformance: add the new rows to `tests/conformance/license.json` via
  `scripts/gen-license-fixture.mjs`; the Swift and Kotlin tests count rows there, so update their
  expected counts deliberately.

## 5. iOS shell

- New `apps/ios/Sources/License/LicenseAppStore.swift`, StoreKit I/O only, `@MainActor`
  `ObservableObject` like `LicenseStorefront.swift`:
  - load the product with `Product.products(for: [id])` (no product → `offered = false`, the
    buttons disappear; never block the card on it, M1);
  - `owned`: read `Transaction.currentEntitlements` for the id at launch, counting only `.verified`
    results without a `revocationDate`;
  - listen to `Transaction.updates` from launch for the life of the app, update `owned`, and call
    `finish()` on every verified transaction;
  - `buy()`: `product.purchase()`; on `.success(.verified)` set `owned`, `finish()`; `.pending`
    (Ask to Buy) and `.userCancelled` change nothing and show nothing;
  - `restore()`: `AppStore.sync()`, **only from the Restore Purchases tap** (it can show an Apple
    sign-in prompt), then re-read entitlements; announce "nothing to restore" if still not owned.
- `LicenseModel` passes `LicenseEvidence(key:, appStore: owned)` to Rust and renders the returned
  plate, actions and includes. The icon picker, its sheet and the Settings row hint read the same
  includes they read today; they need no StoreKit knowledge.
- The gate is on choosing, never keeping (D2): a refund removes `owned`, the set icon stays.
- After a successful App Store purchase started from the icon sheet, land in the picker the same
  way a key activation does (M5).
- US buttons: "Buy on FUTO's website" and "Buy in the App Store" in the **same style and size**.
  This changes the spec rule that Buy is "the only filled button" (`docs/spec/license.md` ~616) for
  the US card; update that line and `LicensePlateTests`.
- Debug and tests use a StoreKit configuration file (`apps/ios/.../FutoNotes.storekit`, product
  id from § 4, Family Sharing off) attached to the Debug scheme, so the simulator can buy, restore
  and refund with no App Store account. Keep the existing `-FUTOLicenseStorefront USA|FRA|none`
  override for the storefront.

## 6. Copy (all new strings go in `languages/en.json`, read through `localizedText`)

| Key | Where | Text |
|---|---|---|
| `license.appStore.buy` | button, every iOS storefront | Buy in the App Store |
| `license.appStore.scope` | under the button, outside the US | Works in FUTO Notes on iPhone and iPad with your Apple Account. It doesn't come with a license key, so it can't be used on other platforms. |
| `license.appStore.scopeUS` | under the buttons, US only | Works in FUTO Notes on iPhone and iPad with your Apple Account. It doesn't come with a license key. To use FUTO Notes on every platform, buy a license on FUTO's website instead. |
| `license.appStore.restore` | button | Restore Purchases |
| `license.appStore.nothingToRestore` | toast | No App Store purchase to restore for this Apple Account. |
| `license.appStore.purchasedTitle` | AppStore plate | Purchased in the App Store |
| `license.appStore.purchasedBody` | AppStore plate | Works on iPhone and iPad with this Apple Account. There is no license key for this purchase. |

Rules: outside the US, never the website, FUTO's store, a price, or "buy a license to use it
everywhere" (3.1.1(a), 3.1.3). `scopeUS` is chosen by the same storefront answer as Buy. Never
"paywall", "premium", "free", "donate"; keep "included with a license" outside the US; the button
says "Buy", not "unlock". The US website button keeps its existing key and wording. No "unlock" on
iOS (§ 9.5).

## 7. Tests and verification (the bar: AGENTS.md §7.3, §7.6)

- Rust: the evidence → includes table, the App Store row equals the Licensed row, plate choice, the
  action table above per surface; FFI contract tests; regenerated goldens; `just test-rust`.
- Swift unit (runs in CI's MR tier): `LicenseAppStore` against `SKTestSession` (StoreKitTest) with
  the configuration file: buy, restore, refund (`refundTransaction`) clears `owned`, unverified
  transaction ignored, `.pending` changes nothing, no product → not offered. `LicenseModel`: the
  evidence it sends and the plate it shows for each combination.
- UI tests (run on `main` pushes, and on a Mac with `just test-ios-native`): unlicensed US and FRA
  cards show the right buttons in the right order and weight; buying from the icon sheet lands in
  the picker with the icon choosable; Restore on a fresh install restores; refund leaves the icon
  set but the picker asks again.
- Real app on the simulator with the StoreKit configuration (screenshots light and dark, US and
  FRA), then one TestFlight Sandbox purchase once § 2 is done.
- `just build-rust-ios` before native testing (M9); `just check` before pushing; Android must
  still compile (`just test-android-native`).
- Spec: update `docs/spec/license.md` (What a license includes, Store posture, States and copy,
  the US filled-button line, Checkout availability) and `docs/spec/settings.md` § Native app icons
  with what you verified; use `/spec-sync`.

## 8. Landing

Small per-concern commits (`feat(license):` Rust, `feat(ios):` shell, `docs(spec):`), each with a
`Verified:` line. Push to this branch, `feat/license-ios-appstore`, and mark its MR ready only after
the Mac verification above. Do not merge, and do not tag: a stable tag goes straight to App Review.
Update W10 in the master plan and § 9 there.

## 9. Decisions (@justin, 2026-10-19)

1. Product id: **`com.futo.notes.license`**. One product; a `.dev` product only if the dev bundle
   id turns out to need its own.
2. Price: **$14.99 USD**, the same as the web license. Apple's standard 30% applies (no Small
   Business Program). Our copy never shows a price; StoreKit's sheet does.
3. The iOS app is **not** offered on Apple silicon Macs, so the copy says "iPhone and iPad".
4. Outside the US, `license.appStore.scope` **keeps** "It doesn't come with a license key".
5. "Unlock" stays **off** every iOS storefront for now (the existing US website button keeps its
   wording).
6. manifest-inventory !5 (FUTO Notes listed on pay.futo.org) merges before the release.
7. The release **waits for this work**: the iOS icon gate does not go to App Review without the
   in-app purchase.

@justin is setting up App Store Connect (§ 2) on 2026-10-19, minus the Small Business Program.
