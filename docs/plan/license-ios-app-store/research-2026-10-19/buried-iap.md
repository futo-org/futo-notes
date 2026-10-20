## Buried IAP (follow-up 2026-10-19)

Question from Justin: add an iOS in-app purchase (IAP) but keep it out of the way. Constraints:
no FUTOpay/lib-polar change (so the purchase is never turned into a key), no license sync.
The design is therefore a StoreKit 2 non-consumable that StoreKit verifies on the device and that
grants what a license includes on that Apple ID's iPhones and iPads only.

**Short answer: it works, and it is the cleanest way out of the 3.1.1 problem.** With an IAP in
the app, the key field becomes legal under 3.1.3(b) in every storefront. Outside the US, no rule
requires the IAP to be prominent, because the key field is not a purchase option and we show no
other way to buy. In the US there is one new limit. The Ninth Circuit (2025-12-11) let Apple stop
a developer's web button from being *more* prominent than Apple's IAP button. Apple's guideline
text does not use that power yet, so the US website button and the IAP button should be equal
weight. "Website filled, IAP as a grey row" is the one layout I would not ship. Overall risk:
**low outside the US, low-medium in the US.**

- [1. Must the IAP be equally prominent, on the same screen, or "alongside"?](buried-iap/1-iap-prominence.md)
- [2. Rejections for a hard-to-find IAP, or for a higher in-app price](buried-iap/2-hard-to-find-rejections.md)
- [3. What an IAP-only, StoreKit-verified entitlement implies](buried-iap/3-iap-only-storekit-verified.md)
- [4. Does adding an IAP change the steering picture?](buried-iap/4-iap-and-the-steering-picture.md)
- [5. Smallest viable design, risk, and code shape](buried-iap/5-smallest-viable-design.md)
- [Refinement: an iOS-only purchase, labeled "no license key" (2026-10-19)](buried-iap/refinement-ios-only-purchase.md)
