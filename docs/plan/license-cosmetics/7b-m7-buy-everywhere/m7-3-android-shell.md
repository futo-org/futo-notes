### M7.3 Android shell, `play` flavor only (size M)

- **The `direct` APK must not depend on Play services.** The flavor already carries this audience
  (ZXing instead of ML Kit for the same reason, `app/build.gradle.kts`). Add
  `"playImplementation"("com.android.billingclient:billing-ktx:<current>")` (the integration page
  shows 9.1.0; new apps and updates need 8+ from 2026-08-31) and **only** there. Code split: an
  interface `LicenseStore` in main, `PlayLicenseStore` in `app/src/play`, a `NoLicenseStore` in
  `app/src/direct`; the build comment's "flavor source set is the third choice" applies and both
  flavors still compile. A Gradle check fails `direct` if its runtime classpath, its merged manifest
  (`com.android.vending.BILLING`) or its dex contains `com.android.billingclient`.
- **Flow.** `BillingClient` with `enablePendingPurchases(...enableOneTimeProducts())` and
  `enableAutoServiceReconnection()`; `queryProductDetailsAsync` (INAPP, do not cache `ProductDetails`);
  `launchBillingFlow`; in `onPurchasesUpdated` hand `getOriginalJson()` + `getSignature()` for each
  `PURCHASED` purchase to `license_redeem_google_play` (one POST, § 7c.5), on the same tap. Licensed
  -> store the pair, **then `acknowledgePurchase` immediately**, M5 landing. Unavailable -> keep the
  receipt in the pending slot, do not acknowledge, show the pending card with Try again and Restore.
  Rejected -> store nothing, do not acknowledge. PENDING (`purchaseState` 2) shows a "waiting for
  payment" line and grants nothing; Play delivers it as PURCHASED later through `queryPurchasesAsync`.
- **Restore.** `queryPurchasesAsync(INAPP)` after connect, on `onResume` and on the Restore tap
  (Google recommends it for network loss, multiple devices and PENDING-to-PURCHASED). A purchase
  found this way is **delivered into the pending slot**; redemption is a tap (Restore, Try again),
  never automatic (zero background network, as on iOS). The server is idempotent on `purchaseToken`,
  so a reinstall's Restore gets the same key back.
- **Acknowledgement is client-side, after the key verifies.** Google's page: acknowledge "on the
  client side through your app" is allowed, server-side is preferred; an unacknowledged purchase is
  **refunded automatically after three days**. Under D29 that is the right outcome: a purchase that
  was never redeemed (server down for three days, user never tapped Try again) refunds itself and
  nothing was granted. The residual failure is a crash between "pair stored" and "acknowledged";
  the acknowledge retry on every connect and `onResume` (no network of ours, it is a Play call)
  closes it within the three days. Server-side acknowledgement needs the Developer API and is not
  built (§ 7c.5).
- Region: only needed if D-A flips to enrolling (`getBillingConfigAsync` gives the Play country).
- Tests: a `BillingClient` fake behind `LicenseStore` plus a fake redeem (purchase ok; cancel;
  pending then purchased; already-owned; service disconnected; transport failure keeps the pending
  slot and does not acknowledge; Try again succeeds; acknowledge failure retried; Restore returns the
  same key). Play Billing has no replacement for the removed static test SKUs, so end-to-end runs use
  license testers on the internal track against staging FUTOpay (M8 on staging first).
