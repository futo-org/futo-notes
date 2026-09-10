# Every platform links out to buy — no in-app purchase anywhere

We planned to buy in-app on mobile, copying FUTO Music, which uses the FUTOpay Android client's
slide-up sheet. Reading that client showed its payment step is a WebView on Polar's hosted
checkout (`create-checkout` → `checkout_url` → watch for `success_url`), not a native card form
— the native part is chrome. Two constraints then removed the option. Apple requires an
external purchase link to open in the user's **default browser**; `SFSafariViewController` and
`WKWebView` are both rejections, so the Android shape is not portable to iOS. And Google Play
billing bars in-app card payment for digital goods, so the `play` flavor could never have it
either. That left an in-app sheet shipping on exactly one of four surfaces — the Android
`direct` flavor — in exchange for a dependency carrying its own v1 `LicenseValidator` (a second
license rule we would import and then carefully not use), a WebView payment surface to
maintain, and a second checkout code path. We decided all four surfaces link out to the
environment's generated FUTOpay checkout in the system browser and return via
`futonotes://license/{key}/{activation}`.

## Consequences

- **The three platforms differ on purpose.** iOS is not "missing" the Android sheet, and
  Android's sheet was not dropped for lack of time. Anyone re-proposing an in-app sheet must
  first say which of the two platform rules above has changed.
- **The client never displays a price**, because it never hosts a checkout. This is what keeps
  "the price lives only in Polar" literally true rather than approximately true.
- **On iOS the buy affordance is gated on the runtime App Store storefront** — Apple's
  commission-free link-out is US-only, and one binary ships worldwide, so a compile-time flag
  cannot express it. `LICENSE_LINK_OUT` remains a manual global kill switch on top.
- **The commission position is a snapshot, not a settled rule.** It rests on the *Epic v.
  Apple* injunction: the Ninth Circuit affirmed Apple's contempt in December 2025 but held a
  total commission ban overbroad, the Supreme Court denied Apple's stay in May 2026 and took
  the contempt question for the October 2026 term, and a district court is setting a permissible
  rate meanwhile. If that lands badly the fallback is the consumption-only shape already built
  — key field and deep link, no buy affordance — not an IAP port.
- **The rejected alternative is StoreKit IAP**, which costs 15–30% and, more importantly, binds
  the entitlement to an Apple account rather than a portable key — breaking the "one license,
  all platforms" promise this product is built around.

Origin: grilling session, 2026-09-10, after reading `client/android-lib` and the current App
Review Guidelines. Tickets: #158 and #159 closed with this reasoning; #157 implements the
per-environment link-out. Vocabulary in CONTEXT.md (license pair, activation, link out).
