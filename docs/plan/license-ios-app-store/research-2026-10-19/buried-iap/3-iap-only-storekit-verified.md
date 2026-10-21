### 3. What an IAP-only, StoreKit-verified entitlement implies

- **Restore is required.** 3.1.1: "you should make sure you have a restore mechanism for any
  restorable in-app purchases." Apple's `AppStore.sync()` docs: "Include some mechanism in your
  app, such as a Restore Purchases button". The same page says reinstalls and new devices get
  transactions automatically through `Transaction.currentEntitlements`. So we need a
  **Restore Purchases** button that calls `AppStore.sync()` only on tap (it shows an Apple ID
  prompt), while the gate itself reads `currentEntitlements`.
- **Family Sharing is off unless we turn it on**, and it cannot be turned off afterwards ("After
  you enable Family Sharing for an Apple In-App Purchase, you can't turn it off",
  [Apple: Supporting Family Sharing](https://developer.apple.com/documentation/storekit/supporting-family-sharing-in-your-app)).
  Recommend leaving it off. That matches ADR-0007 and how the website key works, which is
  per-buyer.
- **Refunds handle themselves.** "Products that the App Store has refunded or revoked don't appear
  in the current entitlements" ([currentEntitlements](https://developer.apple.com/documentation/storekit/transaction/currententitlements)).
  A refund removes the entitlement on the next check. Because the gate is on choosing, never on
  keeping (D2), the icon already set stays. Listen to `Transaction.updates` so a refund mid-session
  is picked up. "Refunds out of scope" (D18) needs no work.
- **Cross-platform: nothing forces it.** 3.1.3(b) lets web purchases work in the iOS app if an IAP
  exists. It says nothing about IAP purchases working on other platforms, and I found no rule that
  does. The obligations are on our copy instead:
  - The card must say where the purchase works, e.g. "Purchased in the App Store. Works on
    iPhone and iPad with this Apple Account."
  - No key is shown, because none exists.
  - No copy may promise desktop or Android. D28 already bans "your license is on all your
    devices".
  - A buyer who later wants Android or desktop pays again on the website. That is a product cost
    for Justin to accept, not a rule.
- **Other costs:**
  - The Account Holder must accept the Paid Apps Agreement and set up tax and banking in App Store
    Connect.
  - Apple takes 15% under the Small Business Program (from earlier research, not re-read today).
  - The product needs a review screenshot and goes into review with the binary.
  - StoreKit's on-device check (`VerificationResult.verified`) can be defeated on a jailbroken
    device. That is acceptable for a cosmetic.
  - I did not check whether the privacy label changes. We send nothing to our servers, so it
    probably does not.
