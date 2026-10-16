# iOS sells the license in-app, and the license follows the vault

Decided by @justin on 2026-10-16. Supersedes [ADR-0005](0005-license-purchase-follows-store-rules.md)
**option A** (the key field outside the US with no IAP) and, for iOS only, two clauses of
[ADR-0003](0003-every-platform-links-out-to-buy.md): "no in-app purchase" and "the client never
displays a price". Not implemented; this records the decision and the design.

ADR-0006 made a license include a cosmetic (the app icon), and @justin ruled that the restriction
applies to everyone in every country (plan D1; no per-country rule). Outside the US, ADR-0005
forbids even "buy on our website" text, and a bare key field that unlocks a feature conflicts
with guideline 3.1.1, which names license keys. The ADR-0005 argument "this license unlocks
nothing" is no longer true. ADR-0005 kept option B (a non-consumable IAP) as a fallback; this
adopts it now rather than after a rejection.

## Decision

- **iOS sells the license as a non-consumable in-app purchase at the license price.** That makes
  the key field legitimate under 3.1.3(b): a license bought elsewhere may be honored if the same
  thing is also available as IAP.
- **No server work.** FUTOpay/lib-polar does not change. An IAP purchase is **not** converted
  into a FUTOpay key and is never sent to FUTO.
- **A license has two possible proofs**: today's FUTOpay key + activation pair, or an **App Store
  signed transaction** (the JWS StoreKit 2 exposes as `jwsRepresentation`). Rust `evaluate` (D8,
  one rule) accepts either and answers Licensed from either; shells only ask. The Apple proof is
  verified **offline in Rust** against a pinned Apple root. No call to Apple or FUTO.
- **License sync (plan M6) is required before the IAP ships.** The proof, of either kind, travels
  inside the E2EE vault so a purchase on one device covers the user's other synced devices.
  The carrier is the one recommended in `docs/plan/license-cosmetics.md` § 7 Feasibility (a
  dedicated engine slot at a reserved non-note path); confirming it is still @justin's call
  (plan § 9, Q3).
- iOS gets Buy (StoreKit purchase), **Restore Purchases**, and the key field, in every storefront.
  The shell observes `Transaction.updates` and `currentEntitlements`; a revocation removes the
  local and the synced proof. What the US build shows beyond that (website link-out too, or IAP
  only) is open: plan § 9, Q6. ADR-0005 recorded his order of preference as link out, then text,
  then IAP.

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

Consequences the design accepts:

- **The cheap checks are not the whole check.** Chain-to-root plus an ES256 signature is not
  enough on its own: the library's `ChainVerifier` also constrains the certificate roles. We
  have **not** read that source, so the Rust implementation must be written against it and
  review must confirm what extensions it requires of the leaf and intermediate. A chain that ends
  at Apple's root but whose leaf was issued for something else (any Apple-issued ECC certificate)
  must not pass.
- **Offline means no revocation check.** The library's online flag is what turns on revocation
  and current-date expiry. Offline, a stored JWS keeps verifying forever, even after a refund:
  `revocationDate` is present only in a JWS signed after the refund. So refunds reach a device only
  when an iOS device re-reads StoreKit (`Transaction.updates`, `currentEntitlements`) and the
  removal syncs. Users without sync get the license only on the device that bought or entered it.
  Certificate validity is checked at the signed time (`signedDate`, which is itself signed), not
  today, or every proof would expire with Apple's leaf certificate. Whether the library does the
  same offline is unconfirmed.
- **A transaction is a bearer proof.** Nothing in it ties it to a device, and it is one more
  string a person can hand to a friend, exactly like a key. That matches ADR-0004 (license reuse
  is never rejected). `inAppOwnershipType` may be `FAMILY_SHARED`; the product is set up without
  Family Sharing, and `evaluate` rejects a family-shared transaction rather than extend a
  license to people outside the buyer's vault.
- **Environment split.** `Production` verifies only in a build whose bundle id is `com.futo.notes`;
  `Sandbox` only in `.dev`/staging (config carries the environment, as it carries the org key
  today). **Risk:** TestFlight and App Review purchases are Sandbox transactions made in the
  release-id binary, so a strict rule would make the reviewer's own purchase not unlock. Plan § 9,
  Q7 records the options; until it is decided, nothing here claims the release build accepts Sandbox.
- **StoreKit testing is not Apple's root.** Xcode StoreKit testing signs transactions with a local
  certificate that is itself a root, with no chain (Apple, "Setting up StoreKit Testing in Xcode").
  Tests therefore inject their trust anchor; the production constant is Apple's root and the
  test certificate is never compiled into a release.

## Consequences

- **Reversed.** ADR-0003's "no IAP" and "the client never displays a price" no longer hold on
  iOS: the StoreKit sheet shows the App Store price. The price still lives in App Store Connect
  and Polar, never in our strings; "the price lives in the store" replaces "only in Polar", and
  the two prices can drift. Copy never states a price.
- **Cost.** Apple takes a commission on IAP; the Small Business Program rate is the plan, to be
  confirmed in App Store Connect (not re-read for this ADR). ADR-0003 rejected IAP for cost and for
  binding the entitlement to an Apple account. The second cost is bounded by this design: the key
  still works, and the proof is portable inside the vault. It is not portable to a person with no
  iOS purchase and no key.
- **"One license, all platforms" survives, on conditions.** An Apple proof synced to Android or
  desktop verifies there too (Rust, offline). On Android `play`, Google allows "any app to be
  consumption-only" and honoring access bought elsewhere, though the app cannot sell it (Google
  Play Help, read 2026-10-16); no Play enrollment needed. On self-hosted sync the carrier is an
  opaque encrypted object, so the server needs no change. A person who never syncs sees nothing
  on their other devices.
- **App Review.** Review notes explain the key field (bought elsewhere, and available as IAP,
  3.1.3(b)), the sandbox purchase path, and Restore Purchases. A restore mechanism is required for
  restorable purchases (guideline 3.1.1).
- **Storefront gating stays** for any link-out text; the IAP and key field need no gate.
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

Plan: [`docs/plan/license-cosmetics.md`](../plan/license-cosmetics.md) (D14-D16, M7, M6).
Behavioral truth: `docs/spec/license.md` § Store posture (a Gap until built).
