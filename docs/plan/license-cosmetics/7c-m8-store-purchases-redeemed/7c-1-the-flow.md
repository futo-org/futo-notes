### 7c.1 The flow

1. User taps Buy (iOS). `product.purchase()`; on `.success` the app holds
   `VerificationResult.jwsRepresentation` and does **not** call `transaction.finish()` yet.
2. The same tap continues into one `POST {pay2}/api/v1/redeem/apple/futo-notes` with the JWS.
   This is user-initiated, so the zero-background-network principle holds (license.md
   § Principles: "only on an explicit user action"); the spec line becomes "two explicit actions:
   a bare key's `GET`, and an Apple redemption `POST`", each one request, no retry.
3. The server verifies the JWS, maps `originalTransactionId` to a license (minting one on
   first sight), and answers `200 {"license_key": ..., "activation": ...}`.
4. The app feeds that pair to the **existing** `evaluate` exactly as a typed or deep-linked
   pair (the server's answer is untrusted until the baked org key verifies it, so a hostile or
   confused server cannot make anything Licensed). Stored in `LicenseStorage` like any pair;
   then `transaction.finish()`; then the M5 landing.
5. **Restore Purchases** = `AppStore.sync()`, read `Transaction.currentEntitlements`, redeem
   the license product's JWS the same way. Idempotent on `originalTransactionId`: same key
   back, no second mint. Works on any device signed into the buyer's Apple ID.
6. The card already has tap-to-reveal for the key, so an iOS buyer can type the key on Android or
   desktop (one `GET`, existing path) without sync; with M6 it just appears.

**Offline / failure at purchase time.** The StoreKit purchase itself needs the network, so the
window is "App Store reachable, FUTOpay not" (outage, captive portal, 5xx). The unfinished
transaction stays in StoreKit's queue, and the shell also keeps the JWS in a pending slot in
`LicenseStorage` (a string awaiting redemption, never evaluated, never shown as Licensed: D8
means the shell does not trust StoreKit's `.verified`). The License card shows a fourth state,
"Purchase received, not yet activated", with **Try again** and **Restore Purchases**, both
user-initiated. No launch-time or Settings-visit auto-retry (that would be a background network
call); whether the card may retry once when the user opens it is a question for @justin (§ 9).
Cost of this design versus ADR-0007: between a paid purchase and a successful redemption the
user is not Licensed, where the offline proof would be Licensed instantly. Apple keeps the
transaction, so nothing is lost, only delayed; support can point to Restore.
Server answers map as: 200 verified; transport error or 5xx = pending; 4xx (bad JWS, wrong
bundle/product/environment) = "couldn't verify this purchase, contact support" (new copy), nothing
stored.
