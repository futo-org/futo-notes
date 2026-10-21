## What a license includes

- **Today a license includes choosing the app icon**, and nothing else cosmetic:
  the four choices beyond the two every install has, as the picker labels them:
  "Dark", "Dark, Reversed", "FUTO" and "Scanlines". "Standard" (the default)
  and "Reversed" come with every install, licensed or not; they are not a
  "free tier". There is no seventh, licensee-only icon. → `license_includes`,
  `app_icons_every_install_has`
- **Rust owns the answer.** Licensed includes everything on the list; Unlicensed
  and Expired include nothing. Which icons need no license is Rust's list too. Shells and the desktop webview only ask; no
  Swift, Kotlin, or TypeScript copy of the rule. Desktop projects the answer but
  renders nothing from it (no picker). → `license_includes`,
  `LicenseInclusion`
- _(ios)_ **The App Store purchase includes exactly what a Licensed key
  includes** (ADR-0009, App Review 3.1.3(b) parity), whatever the stored key
  says. The shell reports two facts, the key's status and whether this Apple
  Account owns the purchase; Rust answers what they include and which plate
  shows. A Licensed key wins the plate. A unit test holds the App Store row equal
  to the Licensed row. → `evidence_includes`, `license_plate`,
  `LicenseEvidence`, `tests/conformance/license.json` `appStoreEvidence`
- **The gate is on choosing, never on keeping.** Removing a license, or one
  expiring, leaves whatever icon is set. Nothing in the app ever changes the
  icon on its own except Full reset, which restores Standard.
- **Expired does not include the icons.** Expired is Unlicensed with a story:
  the picker shows the same ask with Renew where Buy would be.
- **Where the ask may appear:** only where the user walked in: the icon picker,
  its footnote and sheet, and the App icon row's hint in Settings. Never on
  launch, never a popup, never in the editor or the note list. The License card
  does not change for this.
- **Vocabulary:** "included with a license", "comes with a license", and
  "unlock(s)" for what a license includes (cosmetics; allowed on link-out builds
  only, @justin 2026-10-16: the footnote says a license "unlocks additional app
  icon choices", the sheet that it "unlocks this icon and the others marked
  with a coin"). Builds without a link never say "unlock":
  key-only builds' footnote is `settings.appIcon.license.footnoteKeyOnly`,
  "…included with a FUTO Notes license"; Android `play`'s is
  `settings.appIcon.license.footnoteWebsite`, "…, sold on FUTO's website". Never "paywall", "premium", "free" or "donate".
- **Key-only builds** (iOS outside the US) get the key-only ask:
  `license.keyOnlyExplanation` and "I already paid", no Buy, no "Lost your
  key?", no website (ADR-0005). The row hint still shows there: it states a
  fact, not a sale.
- _(ios)_ When the App Store product loaded, the ask also offers **Buy in App
  Store**: in the US as the card's captioned pair (§ App Store purchase), with
  a full-width quiet "Not now" under it and "I already paid" as a text
  button below that;
  elsewhere outlined under "I already paid" with the `license.appStore.scope`
  caption. A completed purchase drops the sheet and lands on the picker
  like a key activation, with `settings.appIcon.license.landingAppStore`. →
  `AppIconPicker.swift`, `AppStorePurchaseTests`
  "testBuyingFromTheIconSheetLandsInThePicker"
- _(android, `play`)_ The ask **names the website** in plain text:
  `settings.appIcon.license.sheetBodyWebsite` with the address from
  `LicenseLinks.website`, a filled **I already paid**, and **Not now**. No Buy,
  no link, no price (ADR-0005, 2026-10-19 amendment). → `AppIconSheet.kt`,
  `AppIconSheetTest` "playNamesTheWebsiteInTheAskAsTextThatCannotBeTapped"
- _(ios, android)_ Implemented: the picker, sheet, row hint and landing, see
  settings.md § Native app icons. Android `direct` is the link-out build and
  `play` the name-the-website one, by `license_purchase_surface`.

> **Gap:** _(desktop)_ The behaviors above are specified but only the native
> shells render them; the desktop webview has no picker and needs no UI.
