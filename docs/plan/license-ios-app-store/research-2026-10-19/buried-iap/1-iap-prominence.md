### 1. Must the IAP be equally prominent, on the same screen, or "alongside"?

| Storefront | Rule text | Applies to us? |
|---|---|---|
| All (3.1.3(b)) | "Apps that operate across multiple platforms may allow users to access content, subscriptions, or features they have acquired in your app on other platforms or your web site ... provided those items are also available as in-app purchases within the app." | Yes. It requires only that the IAP **exists** in the app. Nothing about prominence, placement or price. |
| All (whole guideline page) | A search of the full guidelines (fetched 2026-10-19, both halves of the page) found **no** sentence with "prominent" or "discoverable". The closest is 2.5.19: "Don't include any hidden, dormant, or undocumented features in your app; your app's functionality should be clear to end users and App Review." | An IAP behind a secondary button is not hidden. An IAP reachable only by a gesture or an unlabeled control could be read as hidden. |
| **US** | Ninth Circuit, *Epic v. Apple*, No. 25-2935, 2025-12-11, p. 34 and the conclusion: "where both Apple and a developer offer a purchase option, Apple may restrict the developer from placing its buttons, links, or other calls to action in more prominent fonts, larger sizes, larger quantities, and more prominent places than Apple uses for its own buttons, links, or other calls to action. But Apple must let developers place their buttons, links, or other calls to action in at least the same fonts, sizes, quantities, and places as Apple's own". | **Yes, once we add IAP.** Apple is *allowed* to require parity. The 2026-10-19 guidelines do not state such a rule, so it is not enforced in writing yet, but a reviewer could apply it. The parity limit is one-way: the IAP may be *more* prominent, the website may not. |
| **EU / Japan / Brazil** (entitlement rules) | "Apple In-App Purchase must be displayed at least as prominently as any other payment option shown" and must be offered "on every screen where your app merchandises a digital good" (Apple's EU, Japan and Brazil payment-options pages). | **No.** These attach to the link entitlement, which we do not take. Without it, these storefronts show no website path, so the IAP is the only purchase option on screen. |
| Rest of world | 3.1.1(a) and 3.1.3 ban calls to action toward non-IAP purchase. | Unchanged. No website mention. The IAP is the only purchase option. |

**How far we can bury it:**

- **Outside the US:** the furthest safe spot is the **License card**: the key field stays the
  primary control, and a secondary, labeled **"Buy in the App Store"** button sits next to
  "I already paid", plus "Restore Purchases". The icon sheet can carry the same secondary button.
  Do not hide it further (no long-press, no buried sub-screen, no unlabeled control). The real risk
  is not a rule. It is the reviewer failing to find the purchase and sending an "Information
  Needed" request under 2.1. Developer-forum threads show this exact pattern: Apple asks for
  "steps for locating the in-app purchases", and one game was rejected for making the reviewer play
  before the purchase screen appeared (Apple forums [728321](https://developer.apple.com/forums/thread/728321),
  [817493](https://developer.apple.com/forums/thread/817493); secondary, developer reports). The fix
  is the App Review notes: "Settings › License › Buy in the App Store".
- **US:** "Buy on website" as a filled main button with IAP as a plain secondary row is exactly the
  layout the Ninth Circuit lets Apple forbid. Ship **two equal buttons** in the same style and
  size, side by side or stacked: "Buy on FUTO's website" and "Buy in the App Store". Equal weight is
  allowed with certainty. The repo spec rule that Buy is "the only filled button" (license.md
  ~line 616) has to change for the US card.
