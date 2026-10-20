### 7c.5 Google Play redemption (added with D29, 2026-10-16)

The Apple scoping above generalizes to Play with a simpler verifier and one different identity.
Sources are the ones ADR-0007's Google section lists (read 2026-10-16); nothing here was run.

**Endpoint.** `POST /api/v1/redeem/google/{org_slug}`, body
`{"original_json": "<Purchase.getOriginalJson()>", "signature": "<Purchase.getSignature()>"}`,
in the same new module as the Apple route (or `api/public/google.py`), bound from
`bind_public_api`. Answer shape and status codes identical to Apple's.

**Verification.** Two options; **(a) is the v1 choice**, (b) the upgrade path.

- **(a) Signature only, no Google call.** Verify the Base64 `signature` over the exact UTF-8 bytes
  of `original_json` with RSASSA-PKCS1-v1_5 and the app's Play public key
  (`GOOGLE__PLAY_PUBLIC_KEY_BASE64`, the Base64 X.509 SubjectPublicKeyInfo from Play Console >
  Monetize > Monetization setup), using the RSA library lib-polar already signs org keys with.
  Hash: SHA-1 per Google's long-standing sample (`SHA1withRSA`); the fetched pages do not state it,
  so the **first task is to confirm hash and key format against a real license-tester purchase**
  (the real golden below). Only after the signature verifies, parse the JSON and check
  `packageName == GOOGLE__PACKAGE_NAME` (`com.futo.notes`), `productId` (or the single
  `productIds` entry) maps to a FUTOpay product, `purchaseState == 0` (PURCHASED; 1 canceled and
  2 pending are rejected with a 4xx), `quantity` absent or 1. Same posture as Apple with
  `enable_online_checks=False`: no outbound call, no new secret, no availability dependency on
  Google.
- **(b) Google Play Developer API** (`purchases.products.get` with a service account linked in Play
  Console): confirms the purchase against Google's records, exposes `purchaseType == 0` (a
  license-tester purchase, which the client JSON never marks), detects voided purchases, and
  would allow server-side acknowledgement. Costs a service-account secret, API enablement, a
  Google client dependency and an outbound call on the purchase path. Not built for v1; it is the
  containment to reach for if tester-minted production keys ever matter (the Google twin of Q12).

**Identity and idempotency.** The key is `purchaseToken` (unique per purchase, present on test
purchases; `orderId` is **absent** on license-tester purchases, so it cannot be the key). Table
`google_purchases`: `purchase_token` PRIMARY KEY, `license_key`, `org_slug`, `product_id`,
`play_product_id`, `package_name`, `order_id` (nullable), `purchase_time`, `t_created`,
`t_last_redeemed`, `redeem_count`; registered in `_PUBLIC_TABLES` like `apple_transactions`.
First sight mints through the same `create_key_func` (`customer_email="google:<sha256(purchaseToken), hex>"`,
the token itself is a bearer secret and is not stored in that column); replay returns the same
pair; two concurrent first redemptions yield one row (same lock or `ON CONFLICT` pattern as Apple).

**Acknowledgement stays client-side** (§ 7b M7.3): the server never acknowledges (that needs (b)),
and Google's three-day auto-refund of an unacknowledged purchase is the correct outcome for a
purchase that was never redeemed.

**Staging vs production.** There is no second Play app (D27), so **both** FUTOpay deployments
configure the same `com.futo.notes` public key and package name, and which server a tester
purchase reaches is decided by the build's `FUTO_LICENSE_ENV`. A license-tester purchase on the
internal track is signed like a real one and mints a key wherever it is redeemed; against
production that is a production key. Containment is the tester list in Play Console, plus (b)
later if wanted. Debug builds and automated tests use a fake `BillingClient` and a fake redeem;
they never reach the endpoint.

**Config.** Non-secret: `GOOGLE__PACKAGE_NAME`, `GOOGLE__PLAY_PUBLIC_KEY_BASE64`, and a per-product
map from the Play product id to the FUTOpay org/product slug in the same `.env` style as the Apple
map. No new secret for (a).

**Tests (lib-polar).** A minted test RSA key pair and a helper that signs JSON: valid mint; replay
returns the same key; concurrent first redemptions yield one row; wrong package; wrong product;
pending (2); canceled (1); tampered JSON; signature from another key; wrong key format; quantity 2;
missing `orderId` still mints. One real golden from a license-tester purchase on the internal
track (no expiry, so it never rots); it is what proves the hash and key-format claim.

#### lib-polar task list (Google half; continues the Apple L1-L6)

| # | Task | Size | Files |
|---|---|---|---|
| L7 | Config (`GOOGLE__*`, product map) + `GoogleVerifier` (RSA PKCS1 v1.5 over `original_json`, claim checks) | S | `common.py` (config), new `licensing/google.py`, `env.example` |
| L8 | `google_purchases` table + manager getter/insert, race-safe first-redeem | S | `database/dto.py`, `database/db_manager.py` |
| L9 | `POST /api/v1/redeem/google/{org}` route, same answer shape and codes as Apple | S-M | `api/public/google.py` (or shared `redeem.py`), `api/public/__init__.py` |
| L10 | Tests with a minted key (+ one real golden) | S-M | `tests/test_google_redeem.py` |

Whole lib-polar side, Apple + Google: **M** (L1-L10), **one MR** (D32); the Apple half is
the larger. Deploy ordering as § 7c.2: staging first (every end-to-end test needs it), production
before any store submission.

#### Client task list under D29 (replaces the pre-D29 M7.1 verifier work; § 7b has the detail)

| # | Task | Size | Files |
|---|---|---|---|
| A1 | Rust redeem workflow for both receipts + `redeem_url` + `post_json` transport + FFI exports + conformance cases | S-M | `crates/futo-notes-license/src/{enter,config,lib}.rs` (or new `redeem.rs`), `crates/futo-notes-ffi/src/license/{contract,transport,mod}.rs`, `tests/conformance/license.json`, `scripts/gen-license-fixture.mjs` |
| A2 | iOS StoreKit layer: Buy, Restore, pending slot, finish-after-pair | M | new `LicenseStoreKit.swift`, `LicenseStorage.swift`, `LicenseModel.swift` |
| A3 | Android `play` Billing layer: Buy, Restore, pending slot, acknowledge-after-pair, flavor split + Gradle check | M | `app/src/play/.../PlayLicenseStore.kt`, `app/src/direct/.../NoLicenseStore.kt`, `LicenseModel.kt`, `app/build.gradle.kts` |
| A4 | UI + copy on both shells: pending state, Try again, Restore, Buy in the picker sheet, catalog | S-M | `LicenseSettingsSection.swift`, `LicenseCopy.swift`, `AppIconPicker.swift`, the Android equivalents, `languages/en.json` |
| A5 | Tests: fake store + fake redeem on both shells, StoreKit config file, TestFlight / internal-track QA against staging | M | `apps/ios/Tests/...`, `apps/android/.../test`, `*.storekit` |
| A6 | Spec + ADR + plan edits; the `AGENTS.md` network rule; store checklist (§ 7b M7.5) | S | `docs/spec/license.md`, `crates/futo-notes-license/AGENTS.md`, this plan |
| A7 | M6 simplified to one proof kind (deferred, D28; own MR when picked up) | L | `crates/futo-notes-sync/...` |
