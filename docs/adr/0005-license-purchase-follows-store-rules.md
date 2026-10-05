# The license purchase follows each store's rules, gated by storefront on iOS

Supersedes [ADR-0003 "Every platform links out to buy"](0003-every-platform-links-out-to-buy.md)
on one point: that ADR, and the store-posture decision of 2026-09-09, shipped the Buy link
**worldwide** on every surface and accepted the review risk. On 2026-09-24 @justin reversed
that: we follow Apple's and Google's rules and do not ship something we expect to be rejected.
Everything else in ADR-0003 stands — no in-app checkout of our own, no IAP, the client never
displays a price, the buyer comes back through `futonotes://license/{key}/{activation}`.

His ranking was: link out (preferably in an in-app browser), then "you can buy this on our
website" text, then in-app purchase. The rules as read on 2026-09-24 decide which of those
each surface may have:

| Surface | What it gets | Why |
|---|---|---|
| iOS, **US** storefront | Buy/Renew in the **default browser**, key field, deep link | Guideline 3.1.1(a): no entitlement needed for US links. Default browser, not `SFSafariViewController`: US reviews reportedly reject embedded browsers, and nothing is gained by testing that. |
| iOS, **every other** storefront | Key field and deep link **only**. No Buy, Renew, Lost-your-key, and no copy that asks for payment | 3.1.1(a)/3.1.3 forbid links, buttons *and* other calls to action to non-IAP purchase outside the US, so the "buy on our website" text is banned exactly as firmly as the link. |
| Android `direct` (GitLab/Obtainium/F-Droid APK) | Buy/Renew in a **Custom Tab**, key field, deep link | This APK is distributed independently of Google Play, so Play's external-payment-link restriction does not govern its checkout. The Custom Tab is the browser experience @justin prefers. |
| Android `play` (Google Play AAB) | Key field and deep link **only**, worldwide | Play's Payments policy prohibits leading users to another payment method without an applicable program; Google permits a consumption-only app to accept access obtained elsewhere. The key-only shape needs no external-links enrollment. |
| Desktop | Unchanged | No store. |

## Consequences

- **One iOS binary, gated at runtime.** The gate is StoreKit's `Storefront.current` country
  code, not a build flag — ADR-0003 already noted a compile-time flag cannot express a
  per-storefront rule. An unknown storefront (no Apple account, lookup failure) is treated as
  not-US: the fail-closed direction is "no link", never "link". Android needs no new build:
  the two flavors that already exist carry the split.
- **Two Android distribution artifacts, one app identity.** Release CI builds a `direct`
  universal APK for GitLab/Obtainium/F-Droid and a `play` AAB for Google Play. The flavors
  differ only in whether the license card links to checkout. They keep the same application
  ID and signing key so switching distribution channels does not create a second notes vault.
  Play's rule follows the Play-distributed artifact, not the user's country; unlike iOS, no
  runtime regional gate is needed. The Play AAB currently goes to internal testing on a
  stable tag, with production publication a separate release decision.
- **The EU and Japan are "every other storefront".** Apple's External Purchase Link
  Entitlement would allow a link there, but costs 15% on sales within 7 days of a tap plus
  monthly transaction reports and self-remitted tax (EU), and in Japan requires IAP alongside
  it. Not worth it for a one-time license. Google's US External Content Links program (Play
  Billing Library, an information screen, 10% within 24 h, reporting from 2026-12-01) is
  deferred for the same reason.
- **The key field outside the US is a known, accepted risk.** Guideline 3.1.1 names "license
  keys" as a forbidden unlock mechanism worldwide; our argument is that this license unlocks
  nothing (the card is the only difference a purchase makes), stated in the review notes. This
  is "option A". If Apple rejects it, the answer is **option B**: a non-consumable IAP at the
  same price, which puts the key field under 3.1.3(b). That is a fallback, not a plan.
- **Hosted sync is not covered.** Its checkout opens in `ASWebAuthenticationSession` on iOS
  (`apps/ios/Sources/Sync/Hosted/AuthSheet.swift`) and is behind `FUTO_HOSTED_SYNC`, off for
  the store. It must get the same treatment before that flag reaches a store build.
- **The rules are a snapshot.** US link-out commission is 0% pending the *Epic v. Apple*
  district court's rate after the Ninth Circuit's December 2025 ruling; Google's US fees start
  October–December 2026. Re-read both before each store submission that touches this surface.

Implementation plan: [`docs/plan/license-store-compliance.md`](../plan/license-store-compliance.md).
Behavioral truth: `docs/spec/license.md` § Store posture.

Sources read 2026-09-24:
[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/),
[Apple: apps in the EU](https://developer.apple.com/support/apps-in-the-eu/),
[Apple: iOS changes in Japan](https://www.apple.com/newsroom/2025/12/apple-announces-changes-to-ios-in-japan/),
[Google Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en),
[Google Play consumption-only guidance](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en),
[Google: US external content links program](https://support.google.com/googleplay/android-developer/answer/16470497?hl=en),
[MacRumors on the Ninth Circuit ruling](https://www.macrumors.com/2025/12/11/apple-app-store-fees-external-payment-links/),
[Stora on US default-browser review practice](https://stora.sh/blog/2026-05-16-apple-app-store-external-purchase-links-implementation-guide)
(third-party, the only source for the embedded-browser claim).
