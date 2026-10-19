# iOS sells an App Store-only purchase alongside the license key

Decided by @justin on 2026-10-19. Plan: [`docs/plan/license-ios-app-store.md`](../plan/license-ios-app-store.md).
Research (rules, sources, dates): [`docs/plan/license-ios-app-store/research-2026-10-19.md`](../plan/license-ios-app-store/research-2026-10-19.md).

## Context

[ADR-0006](0006-a-license-may-include-cosmetics.md) made a license include choosing the app icon.
On iOS that means a license key, bought on the web, enables something inside the app. App Review
Guideline 3.1.1 forbids exactly that ("Apps may not use their own mechanisms to unlock content or
functionality, such as license keys"), in every storefront including the US. The only exception
that fits a notes app is 3.1.3(b), multiplatform services, and it holds only "provided those items
are also available as in-app purchases within the app".

The fallback recorded in [ADR-0005](0005-license-purchase-follows-store-rules.md) was a
non-consumable in-app purchase. [ADR-0007](0007-ios-sells-the-license-in-app.md) and
[ADR-0008](0008-store-purchases-are-redeemed-for-a-key.md) designed one that FUTOpay turns into an
ordinary key; on 2026-10-19 both were deferred together with every lib-polar change. Un-gating the
picker on iOS, shipping the gate as-is, and gating only in the US were all rejected.

## Decision

1. The iOS app sells **one non-consumable in-app purchase** that includes, inside the iOS app,
   exactly what a license includes. Nothing more, nothing less (3.1.3(b) parity).
2. It is **App Store-only**: StoreKit verifies it on the device. FUTOpay never sees it, no license
   key is minted, and nothing about it reaches desktop, Android or the sync server. The copy says
   so plainly: it works in FUTO Notes on iPhone and iPad with the buyer's Apple Account and does not
   come with a license key.
3. Its scope is the **Apple Account**, not the device: Apple requires immediate access after a
   reinstall or on a new device, and a Restore Purchases control (3.1.1). Family Sharing is **off**
   (it cannot be turned off once on).
4. It sits **out of the way**. Outside the US the key field stays the main control and "Buy in the
   App Store" is a labeled secondary button on the License card and in the icon sheet, never behind
   a gesture or an unlabeled control (2.5.19). In the US the website and App Store buttons have
   **equal weight**: the Ninth Circuit (2025-12-11) lets Apple forbid a web button more prominent
   than its own.
5. **Rust owns the rule.** "An App Store purchase is present" is an input to the Rust license
   rules, like the key status. Swift does StoreKit I/O only and never decides what a purchase
   includes.
6. Outside the US the copy may state the purchase's limits ("no license key", "not on other
   platforms") but never the website or a price. In the US it may also point to the website.
7. Android, desktop and lib-polar are unchanged by this decision.

## Consequences

- ADR-0003's "no IAP anywhere" and ADR-0005's "no IAP" no longer hold on iOS; both stand for
  Android and desktop.
- The spec rule that Buy is "the only filled button" on the License card changes for the iOS US
  storefront.
- A buyer who later wants desktop or Android pays again on the website. Accepted.
- If license sync (M6) or ADR-0008's redemption ever returns, an App Store purchase has no key to
  carry and needs its own path then.
- The account holder accepts the Paid Apps Agreement and sets up tax and banking in App Store
  Connect; Apple takes its commission on these sales.
