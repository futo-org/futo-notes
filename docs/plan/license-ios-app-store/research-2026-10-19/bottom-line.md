## Bottom line

1. **Google Play can say a lot more than it does today, everywhere, with no program and no fee.**
   Google's consumption-only rule lets an app with no in-app purchase "provide additional
   information about purchasing options without direct links", and its own examples are
   imperatives such as "Head to our website to purchase more." So the `play` build can name the
   website, give a typeable address, and say "buy a license there", as long as nothing is tappable.
   This is the single big move, and it is low risk.
2. **No bucket should flip from key-only to a real link.** Every place that would allow a link
   without our own in-app purchase charges a fee and wants a program (Play US external content
   links, Play EEA/UK/Japan/Australia billing choice, Apple EU/Japan/Brazil), or demands an in-app
   payment option on the same screen (Apple EU, Japan, Brazil). Play US is the closest call and is
   still a no: the injunction stops Google from *banning* links, but Google's own program page says
   enrollment is required "prior to using external content links", and enrolling means fees
   (10–20% within 24 h) and the Play Billing Library.
3. **iOS outside the US is already at the edge.** Apple's 3.1.1(a) and 3.1.3 ban "buttons, external
   links, or other calls to action" toward non-IAP purchase in every non-US storefront, in the app
   *and its metadata*. Naming the website as a place to buy is a call to action. The current
   key-only copy is the most that is allowed; I only propose small wording changes that point to
   the key field, not to a seller.
4. **The real iOS risk is not steering, it is 3.1.1's license-key clause, and it applies in the US
   too.** Gating the icon picker on a key with no in-app purchase twin breaks the text of 3.1.1
   ("Apps may not use their own mechanisms to unlock content or functionality, such as license
   keys") in every storefront. The US exemption covers links and buttons only; it does not waive
   in-app purchase. No 3.1.3 exception fits a notes app. I rate it **high** outside the US and
   **medium-high** in the US. Recommended mitigation is below.
5. **Nothing has passed App Review yet.** The live App Store version is 1.8.1 (released
   2026-10-10), and `v1.8.1` contains no license code at all. `v1.9.0` (tagged 2026-10-15) is the
   first tag with the license card and the US gate. Whatever happens to 1.9.0 in review is the first
   real evidence.
