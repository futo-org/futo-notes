## States and copy

The License **card** has exactly three states. All strings are catalog entries
(`languages/en.json`, prefix `license.`); dates render in the user's locale
(localization.md) as a **full localized date, never a bare year**.

The card is the same object in every state: a status **badge**, the eyebrow
"Client license", the product name "FUTO Notes", a **well** that holds the FUTO
coin while Licensed, and the ledger rows, followed by the state's actions and
its explanation paragraph.

**The well, the letterhead and the ledger exist only when they have something in
them** (@justin 2026-09-17, extended 2026-09-18; desktop first, both native
shells 2026-09-18). There is no empty well: an empty circle read as something
that had failed to load rather than as "no license". The badge, the "Client
license" eyebrow and the uppercase product name belong to a **stored license** —
the letterhead belongs to a card, and Unlicensed has no card, only an ask, so it
leads with the headline instead. **Licensed since and Term are gone outright** —
nothing records a purchase date and nothing limits a license today, so both rows
only ever said blank or "Perpetual". That leaves **Key** as the whole ledger, and
with no key there is no ledger at all, because one blank row is the same void the
well was. The plate also sits on the **same surface as every other Settings card**
rather than on a slab of its own material — a gunmetal gradient on desktop and
iOS, the same gradient on Android — which read as a foreign object in Settings;
only the gold accent is still the plate's own, because no shell has a token for
it. `licenseCardModel` **keeps returning `since` and `term`**: it is shared law
across the three shells and did not change, and the shells stopped rendering
them.
→ `licenseCardModel` in
`src/features/license/licenseCopy.ts`,
`apps/ios/Sources/License/LicenseCopy.swift`,
`apps/android/app/src/main/java/com/futo/notes/license/LicenseCopy.kt` — one
drift-registered concept, `license-card-copy`

| State          | Badge     | Key                | Actions (checkout available)                        | Actions (key-only: iOS non-US or unknown storefront; the App Store controls are listed under Controls below) |
| -------------- | --------- | ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Unlicensed** | none      | absent             | **Buy a license** · I already paid · Lost your key? | I already paid                                       |
| **Licensed**   | none      | masked, revealable | Remove license                                      | Remove license                                       |
| **Expired**    | "Expired" | masked, revealable | **Renew** · I already paid · Lost your key?         | I already paid                                       |

The first Actions column is the full checkout surface. _(ios, non-US or unknown storefront)_
Unlicensed and Expired offer only **I already paid**; Licensed
still offers Remove. The key-only Unlicensed plate has no payment headline.
Unlicensed and Expired use `license.keyOnlyExplanation` ("Have a FUTO Notes
license? Enter your key to activate it on this device.") rather than the
payment explanation. The same `license_link_out` answer controls both copy and
actions. → `license_row_actions`, `LicenseSettingsSection.swift`

_(android, `play`)_ Unlicensed and Expired **name the website**: the payment
headline `license.unlicensedHeadline` and `license.explanation` as on `direct`,
then `license.websiteExplanation` ("Licenses are sold on FUTO's website at
{url}. Already bought one? Enter your key to activate it on this device."),
then **I already paid** · **Lost your key?**. No Buy or Renew, no filled
button, no price. `{url}` is `LicenseLinks.website`, environment-split like Buy
(M3): `pay.futo.org` in production (the same storefront as `pay2.futo.org`),
`staging-pay2.futo.org` on a `.dev` build. It is **plain text**: no link
annotation, no autolink, no click handler, no copy button, no QR code; tapping
it does nothing. Licensed shows the ordinary thank-you and Remove. →
`license_purchase_surface`, `license_surface_row_actions`,
`LicenseSettingsSection.kt` (`licenseWebsitePath`), `LicenseSurfaceTest`
"playNamesTheWebsiteAsTextThatCannotBeTapped"

Key is the whole ledger on every platform: the row is absent rather
than blank when Unlicensed, and the date rows (Licensed since, Term) do not exist anywhere.
**Unlicensed wears no badge either** — the section heading says "License", and on
desktop the sidebar already says "Unlicensed"; a third copy of the word was
chrome.

- [App Store purchase _(ios)_](states-and-copy/app-store-purchase.md)
