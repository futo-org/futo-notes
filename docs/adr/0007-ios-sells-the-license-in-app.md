# Buy everywhere: the website where allowed, the store's purchase where not

> **Status: Deferred 2026-10-19.** @justin dropped in-app purchase for now: no StoreKit or Play
> Billing purchase flow, no lib-polar change. Deferred, not cancelled. In force instead is the
> posture of [ADR-0010](0010-every-platform-links-out-to-buy.md) and
> [ADR-0005](0005-license-purchase-follows-store-rules.md): where store rules allow a link, Buy
> opens the FUTOpay website (desktop, iOS US storefront, Android `direct`); iOS outside the US and
> Android `play` stay key-only, and how far their copy may steer a buyer is under review. The body
> below is the record of the reasoning, kept whole.

> **Offline verification superseded 2026-10-16** by [ADR-0008](0008-store-purchases-are-redeemed-for-a-key.md):
> a store purchase is redeemed on FUTOpay for an ordinary license key, so items 4, 5, 7 and 8 below
> and both "what offline verification is, and is not" sections no longer describe the design. The
> routing (items 1-2), refunds out of scope (3), the deferred M6 carrier (6) and the store surfaces
> (9) stand. Kept whole as the record of what was weighed.

Decided by @justin on 2026-10-16 (file name kept from the iOS-only first version, so links hold).
Supersedes [ADR-0005](0005-license-purchase-follows-store-rules.md)'s key-only surfaces
(option A on iOS outside the US, Android `play` key-only) and, where a store forces an in-app
purchase, two clauses of [ADR-0010](0010-every-platform-links-out-to-buy.md): "no in-app purchase"
and "the client never displays a price". Not implemented; this records the decision and the design.
Plan: `docs/plan/license-cosmetics.md` § 7b (routing table, build list, sizing).

ADR-0006 made a license include a cosmetic (the app icon) for everyone in every country, so a
bare key field that unlocks something conflicts with Apple's 3.1.1, and "buy on our website" text is
banned outside the US storefront. ADR-0005 kept a non-consumable IAP as a fallback; this adopts it,
and gives Google Play the same shape.

## Decision

1. **Every device gets a functional Buy button.** Buy opens our website (the FUTOpay checkout)
   wherever the platform allows a link without a paid program we chose not to join; where it does
   not, Buy runs the store's in-app purchase.
2. **Routing**, owned by one Rust function (plan D8, `license_buy_route`), table in plan § 7b M7.0:
   iOS US, Android `direct` and desktop go to the website; iOS everywhere else and Android `play`
   everywhere run the store purchase. EU/Japan link-outs and Google's US/EEA/UK programs are paid
   programs; the recommendation (not yet decided, plan § 9 D-A, D-B) is the store purchase there.
3. **Refunds are out of scope.** No revocation handling, no revocation or OCSP check, no
   tombstone-for-refund. A stored proof keeps verifying.
4. **No server work.** FUTOpay/lib-polar is unchanged. A store purchase is not converted into a
   FUTOpay key and is never sent to FUTO. Plan § 7c (receipts become FUTOpay keys) was the considered
   alternative and is rejected on this ground.
5. **A license has three possible proofs**: the FUTOpay key + activation pair, an **App Store signed
   transaction** (the JWS StoreKit 2 exposes as `jwsRepresentation`), or a **Google Play signed
   purchase** (`Purchase.getOriginalJson()` + `getSignature()`). Rust `evaluate` (D8) accepts any
   and answers Licensed; shells only ask. Both store proofs are verified **offline in Rust**. No
   call to Apple, Google or FUTO.
6. **License sync (plan M6) is deferred (plan D28, 2026-10-16); it is not required before any IAP ships.** Without M6 a license is per device, as today. A store purchase reaches the user's other devices **on the same store** through that store's Restore (Apple ID across iPhone and iPad; Google account across Android Play installs). It does **not** reach other platforms: an App Store purchase does not license Android or desktop, and a Play purchase does not license iOS or desktop. A website/FUTOpay key still works anywhere it is entered. Once M6 exists the proofs would travel inside the E2EE
   vault so a purchase on one device covers the user's other synced devices. Carrier, decided
   2026-10-16: the hidden slot in the sync engine (reserved path in engine state, never a file in the
   notes folder). Any valid proof counts, duplicates keep one, and a Remove tombstone wins over an
   offline device.
7. **Sandbox**: Sandbox Apple proofs are accepted when the app is not an App Store install (the iOS
   shell reports `AppTransaction.environment`); a production store install never accepts one.
8. **Apple roots**: all three (Apple Root CA, G2, G3), pinned in the binary, with the Apple library's
   chain rules. Tests inject the Xcode StoreKit anchor in test code only; a test asserts the
   release set is exactly Apple's roots.
9. iOS gets Buy, **Restore Purchases** and the key field in every storefront; Android `play` gets
   Buy (Play Billing), Restore (`queryPurchasesAsync`) and the key field. Android `direct` links out
   and carries no Play Billing dependency.

## Google Play: what offline verification is, and is not (sources read 2026-10-16)

- **Possible.** Google's `Purchase` reference says `getSignature()` is the signature of the purchase
  data "signed with the private key of the developer", using RSASSA-PKCS1-v1_5, over
  `getOriginalJson()`. Rust verifies that with the app's Base64 RSA public key from Play Console, then
  checks `packageName`, `productId` and `purchaseState == PURCHASED` (pending and canceled are not
  entitlements). The hash (SHA-1 in Google's long-standing sample) and the key format are **not stated
  by the pages read**; confirm with a real signed purchase before relying on them.
- **Not what Google recommends.** Google's security page says purchase verification and
  acknowledgement "should be handled in the backend": call the Developer API to confirm the purchase
  with Google, keep every `purchaseToken` and reject duplicates, check `obfuscatedAccountId`. Without a
  server we give up: confirmation against Google's records, voided/refunded purchase detection (D3
  makes this acceptable), duplicate-token rejection (a proof is a bearer string, matching ADR-0004),
  real-time notifications.
- **Acknowledgement can be client-side.** Google: acknowledging "on the client side through your app"
  is allowed, server-side is "preferred"; an unacknowledged purchase is **refunded automatically after
  three days**. We acknowledge immediately after Rust says Licensed, retrying at every connect and
  resume. A purchase that fails our check is never acknowledged.
- **Restore** is `queryPurchasesAsync(INAPP)` (Google recommends it on connect and resume: network
  loss, multiple devices, PENDING becoming PURCHASED).
- **Test purchases are signed like real ones.** License testers' purchases carry the same signature
  and nothing in the client JSON marks them, so a release build cannot tell them from real ones. The
  public key is per Play app: `com.futo.notes` has one; `.dev` has none unless it is also created as a
  Play app (recommended).
- **Policy basis**, read 2026-10-16: Play's Payments policy section 4 bars leading users to another
  payment method outside a program; consumption-only apps may honor access bought elsewhere and say
  where to buy without a link; links are possible through the US External Content Links program, the
  EEA/UK billing choice program (since 2026-06-30) or External Offers, each with enrollment, API
  integration, transaction reporting and a fee (listed 10-20% for one-time purchases), and the billing
  choice program requires Play Billing alongside. Google's US page says it will not prohibit US
  developers from linking out (since 2025-10-29); whether an un-enrolled link is enforcement-safe is
  unsettled. Fee figures differ between Google's pages and summaries. Sources:
  [Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en),
  [consumption-only](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en),
  [US policy update](https://support.google.com/googleplay/android-developer/answer/15582165?hl=en),
  [external content links](https://support.google.com/googleplay/android-developer/answer/16470497?hl=en),
  [billing choice](https://support.google.com/googleplay/android-developer/answer/17161464?hl=en),
  [service fees](https://support.google.com/googleplay/android-developer/answer/112622?hl=en),
  [Purchase](https://developer.android.com/reference/com/android/billingclient/api/Purchase),
  [security](https://developer.android.com/google/play/billing/security),
  [integrate](https://developer.android.com/google/play/billing/integrate).

## Apple: current link-out rules (read 2026-10-16)

US storefront needs no entitlement (3.1.1(a)); commission 0% today, Apple's proposed 5-15% is
before the district court and Apple's Supreme Court merits brief was filed 2026-09-14 (9to5Mac
2026-10-12, AppleInsider 2026-08-13). EU: unified terms effective 2026-10-01, 15% (10% Small Business)
on sales within 7 days of a tap, 5% Core Technology Commission, monthly reports. Japan: link allowed
since 2025-12-17, always alongside IAP, 15%. Elsewhere: banned. Sources:
[Apple EU](https://developer.apple.com/support/apps-in-the-eu/),
[Apple Japan](https://www.apple.com/newsroom/2025/12/apple-announces-changes-to-ios-in-japan/).

## What offline verification is, and is not (sources read 2026-10-16)

Apple states that the App Store signs transaction information in JWS format, that
`VerificationResult.jwsRepresentation` "is the same as the JWSTransaction that the App Store Server
API returns", that "you can validate them on your server in the same way", and that an app may
"perform your own validation on the device" from the JWS string; it recommends the App Store
Server Library's `SignedDataVerifier` (Apple, StoreKit `Transaction` docs). The `x5c` header
carries the certificate chain, so no fetch is needed for the chain itself. Apple's own engineer
says to "use all Apple Root CAs" rather than only G3, and to enable revocation checking
"unless you are re-verifying data that was received a long time ago" (Apple Developer Forums
thread 742525, Dec 2023). Apple's library requires `bundleId` to match, `environment` to match
its configured environment, and `appAppleId` for Production (library source, read 2026-10-16).

Consequences the design accepts (Apple half; the Google half is below):

- **The cheap checks are not the whole check.** Chain-to-root plus an ES256 signature is not
  enough on its own: the library's `ChainVerifier` also constrains the certificate roles. We
  have **not** read that source, so the Rust implementation must be written against it and
  review must confirm what extensions it requires of the leaf and intermediate. A chain that ends
  at Apple's root but whose leaf was issued for something else (any Apple-issued ECC certificate)
  must not pass.
- **Offline means no revocation check.** The library's online flag is what turns on revocation
  and current-date expiry. Offline, a stored JWS keeps verifying forever, even after a refund:
  `revocationDate` is present only in a JWS signed after the refund. Refunds are out of scope (item 3), so a stored proof keeps verifying and no removal syncs for a refund. Without M6 (deferred, D28) the license is per device; Restore is the same-store cross-device path.
  Certificate validity is checked at the signed time (`signedDate`, which is itself signed), not
  today, or every proof would expire with Apple's leaf certificate. Whether the library does the
  same offline is unconfirmed.
- **A transaction is a bearer proof.** Nothing in it ties it to a device, and it is one more
  string a person can hand to a friend, exactly like a key. That matches ADR-0004 (license reuse
  is never rejected). `inAppOwnershipType` may be `FAMILY_SHARED`; the product is set up without
  Family Sharing, and `evaluate` rejects a family-shared transaction rather than extend a
  license to people outside the buyer's vault.
- **Environment split.** `Production` proofs verify for bundle id `com.futo.notes`; Sandbox proofs are accepted when the running app is not an App Store install (decision 7); `.dev` uses the staging config.
- **StoreKit testing is not Apple's root.** Xcode StoreKit testing signs transactions with a local
  certificate that is itself a root, with no chain (Apple, "Setting up StoreKit Testing in Xcode").
  Tests therefore inject their trust anchor; the release anchor set is exactly Apple's three roots and the
  test certificate exists only in test code.

## Consequences

- **Reversed.** ADR-0010's "no IAP" and "the client never displays a price" no longer hold where a store
  forces the purchase (iOS outside the US, Android `play`): the StoreKit or Play sheet shows the price. The price still lives in App Store Connect
  and Polar, never in our strings; "the price lives in the store" replaces "only in Polar", and
  the two prices can drift. Copy never states a price.
- **Cost.** Apple takes a commission on IAP; the Small Business Program rate is the plan, to be
  confirmed in App Store Connect (not re-read for this ADR). ADR-0010 rejected IAP for cost and for
  binding the entitlement to an Apple account. The second cost is bounded by this design: the key
  still works, and the proof is portable inside the vault. It is not portable to a person with no
  iOS purchase and no key.
- **"One license, all platforms" does not hold until M6 exists (D28).** Today a store purchase covers the same store only (via Restore); a FUTOpay key works anywhere it is entered. Once M6 exists: an Apple proof synced to Android or
  desktop verifies there too (Rust, offline). A Google proof verifies on iOS and desktop the same way. A FUTOpay key or Apple proof on Android `play` is honored as access bought elsewhere (Google allows consumption-only apps). On self-hosted sync the carrier is an
  opaque encrypted object, so the server needs no change. A person who never syncs sees nothing
  on their other devices.
- **App Review.** Review notes explain the key field (bought elsewhere, and available as IAP,
  3.1.3(b)), the sandbox purchase path, and Restore Purchases. A restore mechanism is required for
  restorable purchases (guideline 3.1.1).
- **Storefront gating stays** for the website Buy (iOS US only); IAP, Restore and the key field need no gate. Fail closed: an unknown storefront gets the store purchase, never the link.
- **Android `direct` stays free of Play services**: Play Billing lives in the `play` flavor only.
- **Cost on Google**: service fee plus 5% billing fee as listed on Google's fee page (figures conflict between pages; confirm in Play Console).
- **Hosted sync** (`FUTO_HOSTED_SYNC`) is untouched and still off for the store.
- **Rules are a snapshot** (read 2026-10-16): [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/),
  [StoreKit Transaction](https://developer.apple.com/documentation/storekit/transaction),
  [Setting up StoreKit Testing](https://developer.apple.com/documentation/xcode/setting-up-storekit-testing-in-xcode),
  [forum thread 742525](https://developer.apple.com/forums/thread/742525),
  [app-store-server-library-swift](https://github.com/apple/app-store-server-library-swift),
  [Apple PKI](https://www.apple.com/certificateauthority/),
  [Google Play consumption-only](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en).
  The fetch tool could not read Apple's JWSTransaction reference page itself, so the claims
  about `alg: ES256`, the `x5c` layout and the payload fields (`bundleId`, `productId`,
  `environment`, `revocationDate`, `signedDate`) are from the model's general knowledge plus the
  pages above, and the first implementation task is to confirm them against a real fixture.

Plan: [`docs/plan/license-cosmetics.md`](../plan/license-cosmetics.md) (D14-D22, D28-D29, M7, M6).
Behavioral truth: `docs/spec/license.md` § Store posture (a Gap until built).
