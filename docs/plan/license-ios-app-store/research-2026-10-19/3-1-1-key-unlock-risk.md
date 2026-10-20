## The 3.1.1 key-unlock risk on iOS

**What the rules say.** 3.1.1 requires IAP to "unlock features or functionality" and names license
keys as a forbidden mechanism. 3.1.3 lists the only exceptions:

- 3.1.3(a) Reader apps: limited to "magazines, newspapers, books, audio, music, and video". A notes
  app is not one.
- 3.1.3(b) Multiplatform services: allows access to things bought on the web "provided those items
  are also available as in-app purchases within the app". We have no IAP, so it does not apply.
- 3.1.3(f) Free stand-alone apps: companions to a paid web tool for "VoIP, Cloud Storage, Email
  Services, or Web Hosting", and only with "no purchasing inside the app, or calls to action for
  purchase outside of the app". The license is not a web tool, and the US build has a Buy button.
- The US exemption in 3.1.1(a) covers "buttons, external links, or other calls to action". It
  does not remove the IAP requirement or the license-key sentence.

**Does a cosmetic differ from a feature?** Not in the text. 3.1.1 says "features or functionality"
and gives no cosmetic carve-out; I found no Apple text that treats non-functional items
differently. Apple's examples for IAP include things like in-game items, and Play's policy lists
"avatars" as in-app items explicitly. Choosing an app icon is a setting the user operates, so a
reviewer can call it functionality. I found no precedent either way for an icon picker gated by a
key; the icon-related rejections I found were about icons that could not be changed in the app
(guideline 4.6-style, Apple forum thread 751251; Twitterrific 2020), not about gating.

**Comparable apps.** Immich's mobile app accepts a license key bought at buy.immich.app, but its
license unlocks nothing ("there will never be any paywalled features"); it is a supporter badge.
That is the shape ADR-0005's "option A" relied on: a key that changes only the card. ADR-0006 moved
us off that shape by making the key enable icon choice. I did not find a non-reader app that
gates an in-app feature on a web-bought key with no IAP and is live on the App Store; one Apple
forum thread reports 11 rejections for exactly the 3.1.1 vs 3.1.3(b) argument.

**How it gets caught.** A reviewer with no key opens the icon picker, sees coin badges and
"included with a license", and finds no way to buy in the app (non-US) or a Buy button that leaves
the app with no IAP beside it (US). That is the textbook 3.1.1 rejection.

**Risk.** Non-US storefronts: **high**. US storefront: **medium-high** (the link itself is fine;
the key-gated feature without IAP is the same 3.1.1 problem). A rejection does not strike the
account, but a stable tag goes to Apple review with auto-release, so it stalls the whole iOS
release, including unrelated fixes.

**Recommended mitigation (pick one):**

1. **Recommended: do not gate the icon picker on iOS until an IAP exists.** Rust
   `license_includes` gains the surface or platform as input and answers "nothing gated" for iOS,
   so the iOS license again changes only the card (ADR-0005's option A, which the rules tolerate
   best). Android `play` and `direct` keep the gate. This reverses D14 ("every country, every
   platform") for iOS only, so it is Justin's decision. Zero 3.1.1 exposure.
2. **Keep the gate, contain the blast radius.** Submit the iOS gate in a version that carries
   nothing else urgent; put a review note that the key is bought on the web and that the icons are
   cosmetic; and pre-build option 1 behind the Rust input so a rejection costs one rebuild, not a
   redesign. Expect rejection outside the US.
3. **Gate only on the US storefront.** Narrows exposure to the medium-high bucket, but makes the
   same build behave differently by country for a feature, which is hard to explain to users and
   still not compliant on paper.

The existing escape hatch, a non-consumable IAP at the license price (ADR-0005 option B,
ADR-0007/0008), is the only fully compliant answer for a gated feature on iOS. It is deferred by
today's decision.
