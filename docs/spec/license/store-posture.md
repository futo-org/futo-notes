## Store posture (deliberate, recorded 2026-09-09, revised 2026-09-24)

Research summary as of 2026-09-09, re-read 2026-09-24; this area changes monthly
and the decision, not the rules, is what this section records.

- **Apple.** Guideline 3.1.1 names license keys as a forbidden unlock mechanism
  worldwide; 3.1.3(b) permits recognising a web-bought license only if the same
  thing is also sold as IAP. Linking out is legal in the US (no entitlement, 0%
  today, rate pending in court), in the EU and Japan at 15% with Apple's
  disclosure sheet and an IAP twin, in Brazil, and banned elsewhere. Immich
  ships a free iOS app with a key field and no IAP twin today. Re-read
  2026-09-24: outside the US, 3.1.1(a) bans "buttons, external links, or other
  calls to action" to non-IAP purchase, so text naming our website is banned as
  firmly as a link; the EU entitlement no longer requires an IAP twin (15% on
  sales within 7 days of a tap, monthly reports), Japan's still does; a US
  link reportedly must open in the default browser, not an embedded one.
- **Google.** A Play build that only accepts a pasted key with no clickable
  path to checkout is explicitly permitted (consumption-only, 0%, no
  enrollment). Any link requires the External Content Links / billing choice
  programs, which cover the US, EEA, UK and Japan today, with fees from October
  2026 and worldwide coverage not before September 2027. Google enforces after
  publication (removals, strikes) and has enforced against external payment
  links in 2026.
- **Decision 2026-09-24 — follow each store's rules** (@justin; ADR-0005,
  plan `docs/plan/license-store-compliance.md`):
  - _(ios)_ One binary reads `Storefront.current` and `Storefront.updates`. The **US** storefront offers the full surface, with Buy in the default browser. Every other or unknown storefront has the key field and deep link only; it has no Buy, Renew, Lost-your-key, payment headline, or payment explanation. The initial answer is key-only until StoreKit responds. EU and Japan are not special-cased. → `license_link_out`, `LicenseStorefront.swift`
  - _(android)_ `direct` offers the full surface worldwide and opens Buy in a Custom Tab; `play` names the website in plain text and accepts keys and deep links, worldwide (revised 2026-10-19, below). Both flavors keep the same app identity and signing, so installing one over the other preserves notes. The flavor reports only its distribution; Rust decides the surface. → `BuildConfig.LICENSE_DISTRIBUTION`, `license_purchase_surface`, `LicenseModel.kt`, `browser/CustomTabs.kt`
  - _(desktop)_ Unchanged.
  - _(ios)_ **An App Store-only purchase sits beside the key field on every storefront (ADR-0009, 2026-10-19).** A license key enables the icon picker in the app, which 3.1.1 allows only under 3.1.3(b), "provided those items are also available as in-app purchases within the app". The non-consumable in § App Store purchase is that in-app purchase. It mints no key and FUTOpay never sees it; Android, desktop and lib-polar are unchanged. Outside the US the copy may state its limits ("no license key", "can't be used on other platforms") but never the website or a price.
  - **Store purchases redeemed for a key stay deferred (2026-10-19, @justin).** No Play Billing flow and no change to FUTOpay (lib-polar) is planned; the 2026-10-16 design (a store purchase redeemed on FUTOpay for an ordinary key) is kept as the record in ADR-0007 and ADR-0008.
  - **Android `play` names the website (2026-10-19, @justin; ADR-0005 amendment).** Google's consumption-only rule lets an app say where to buy as long as nothing leads there (Play Console Help 10281818), so `play` shows the payment headline, the reason, and the storefront address as plain, non-tappable text, plus "Lost your key?". No Buy, no link, no copy button, no QR code, no price. Not flipped to link-out in the US: that needs the External Content Links program. → `license_purchase_surface` (`NameWebsite`)
  - _(Android, F-Droid)_ Offline verification adds no anti-feature; the single activation request to pay2 may earn a Tethered/NonFreeNet label. Accepted.
- **Verification 2026-09-24.** _(ios)_ Debug UI tests drove USA (Buy opened Safari), FRA and `none` (key-only copy and deep-link activation). A Release UI test compared the unforced surface with `Storefront.current`; Release contained no `-FUTOLicenseStorefront` string. On the claimed simulator, StoreKit reported a US storefront without a signed-in App Store account, so the US purchase surface appeared. An absent account is not proof of `nil`; only `nil` itself fails closed. _(android)_ The pooled emulator showed direct checkout in Chrome's Custom Tab, a deep link returning to one existing `MainActivity`, Back returning to Settings, and Play's key-only surface activating both a pasted pair and a cold-start deep link. → `LicenseSurfaceTests`, `LicensePlateTests`, `LicenseSurfaceTest`, `LicenseLinkActivity.kt`
- **Never** frame the purchase as a donation in the app or the store listing
  (see Principles).
