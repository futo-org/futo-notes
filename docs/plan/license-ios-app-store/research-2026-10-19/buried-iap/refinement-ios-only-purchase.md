### Refinement: an iOS-only purchase, labeled "no license key" (2026-10-19)

**(a) Scope: it must be "this Apple Account", not one device.** Apple's In-App Purchase page
(fetched 2026-10-19): "If someone redownloads your app or switches to a new device, be sure to
immediately provide access to the content or functionality from their past Apple In-App
Purchases. Use the currentEntitlements property ... Your app must also include a restore mechanism
for any restorable Apple In-App Purchases, per App Review Guideline 3.1.1." A non-consumable is
restorable by definition. Limiting it to one device would mean refusing a purchase that StoreKit
reports as owned on a new device, which breaks that sentence. So the honest scope is **"FUTO Notes
on iPhone and iPad signed in to the same Apple Account."**

Two more facts:

- **Mac.** If the iOS app is also available on Apple silicon Macs ("Designed for iPad", an App
  Store Connect setting), the purchase works there too, because it is the same app and the same
  account. I could not tell from the public App Store lookup whether that setting is on. Check it
  in App Store Connect, and either word the copy as "Apple devices" or switch Mac availability off.
- **Family Sharing.** It is **off by default**; the developer turns it on per product ("Developers
  can choose to turn on Family Sharing", and once on "you can't turn it off"). Recommend off.
  The copy then needs no family clause.

**(c) Does an iOS-only IAP count as the "same item" under 3.1.3(b)?** Yes, as far as the text
goes. The rule is about what the app gives access to: users may "access content, subscriptions, or
features they have acquired ... on other platforms or your web site ... provided those items are
also available as in-app purchases within the app." Inside the iOS app, the IAP and the web
license give the same thing: what a license includes (icon choice, the card). I found no
guideline, Apple page or reported rejection that requires an IAP to carry to other platforms, and
3.1.3(b) runs in one direction only (web → app). Nothing requires the same price either (section
2 above). Risk: **low.** The one thing that would break parity is the IAP granting *less inside
the app* than the key does. Keep the Rust truth table so `app_store: true` includes exactly what a
Licensed key includes.

**(b) Disclosure copy.** The limitation is a fact about the product being sold, so stating it is
honest disclosure, not a call to action. The line is crossed only when the copy points to where
else to buy. Outside the US it may say "no license key" and "not on other platforms"; it may not
say "website", "FUTO's store", "buy a license to use it everywhere", or anything with a price. In
the US it may add the website alternative, because the injunction forbids Apple from limiting the
"language" of US calls to action, apart from general content standards (Ninth Circuit, item ii).
Keep the US website line no more prominent than the App Store button (section 1).

| Key (new) | Where | Text | Risk |
|---|---|---|---|
| `license.appStore.buy` | Button, all iOS storefronts | Buy in the App Store | Low |
| `license.appStore.scope` | Under the button, all iOS storefronts | Works in FUTO Notes on iPhone and iPad with your Apple Account. It doesn't come with a license key, so it can't be used on other devices or platforms. | Low. States the product's limits. Says nothing about where else to buy. |
| `license.appStore.scopeUS` | US storefront only, replaces `scope` | Works in FUTO Notes on iPhone and iPad with your Apple Account. It doesn't come with a license key. To use FUTO Notes on every platform, buy a license on FUTO's website instead. | Low in the US (allowed language). **Never shown outside the US.** Routing by the same storefront check as Buy. |
| `license.appStore.restore` | Button, all iOS storefronts | Restore Purchases | Low (required) |
| `license.appStore.purchasedTitle` | Licensed card, App Store purchase | Purchased in the App Store | Low |
| `license.appStore.purchasedBody` | Licensed card, App Store purchase | Works on iPhone and iPad with this Apple Account. There is no license key for this purchase. | Low |
| App Store Connect product description (shown in Apple's purchase sheet) | All storefronts | Included-with-a-license features in FUTO Notes for iPhone and iPad. Doesn't include a license key. | Low. Must not mention the website: it is metadata (3.1.1(a)). |

Notes on the copy:

- Use "Apple Account". That is Apple's current name for it, as in the Family Sharing docs.
- Avoid "only on iOS". iPad runs iPadOS, and the Mac question above is open.
- "Other devices or platforms" is accurate only if Mac availability is off. Otherwise write "can't
  be used in FUTO Notes for Android, Windows, macOS or Linux". That list names platforms, not a
  store, so it is still not steering. It is a little more inviting, so I'd still call it low risk.
- The vocabulary rules hold: no "free", "premium", "paywall" or "donate". The App Store button
  says "Buy", not "unlock". "Included with a license" stays the outside-US wording elsewhere.
- Remaining unknown: whether a reviewer reads "doesn't come with a license key" as a hint to buy
  elsewhere outside the US. No rule says so and I found no rejection for disclosure of a purchase's
  limits. If Justin wants zero exposure, the outside-US text can drop the key clause: "Works in
  FUTO Notes on iPhone and iPad with your Apple Account."
