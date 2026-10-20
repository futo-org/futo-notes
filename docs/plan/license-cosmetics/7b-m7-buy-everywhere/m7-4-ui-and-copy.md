### M7.4 UI and copy (size S, both shells plus Tauri strings)

- **The License card.** Unlicensed/Expired: `[Buy]`, "I already paid", and either "Lost your key?"
  (Website) or "Restore purchase" (StoreIap). Buy on StoreIap opens the store sheet directly (the
  sheet shows the price; copy never states one). **Pending** (new fourth state, native only):
  "Purchase received, not yet activated", `[Try again]`, `[Restore purchase]`, and the support line.
  Licensed: unchanged, the normal key card (D29 supersedes D26: a store purchase is a key like any
  other, tap-to-reveal and all).
- **The app-icon sheet** (D4, D11): under this design, Buy everywhere, with one sheet showing Buy
  and "I already paid". Deferred: the key-only sheet (`license.keyOnlyExplanation` plus "I already
  paid") stays as it ships today.
- **D5 vocabulary.** "Unlocks" is allowed on every surface: where a store forbids a link the license
  is sold through the store's own purchase, which 3.1.1 requires for unlocking, and Play Billing is
  Google's own path. Deferred: the link-out-only restriction on "unlocks" and the key-only variants
  stay.
  "free" and "donate" stay banned; "paywall" and "premium" stay banned.
- **Catalog strings.** Deferred, so none of this is done: `license.keyOnlyExplanation` and
  `settings.appIcon.license.footnoteKeyOnly` stay, and `license.unlicensedHeadline` and
  `license.explanation` stay suppressed on key-only surfaces. The design would have retired the
  first two and returned the last two everywhere.
  `settings.appIcon.license.footnote` and `sheetBody` ("Purchasing a FUTO Notes license unlocks...")
  now apply on every surface. Add: `license.restore` ("Restore purchase"), `license.restoreNothing`,
  `license.purchasePending` ("Purchase received, not yet activated"), `license.tryAgain`,
  `license.purchaseRejected` ("We couldn't verify this purchase", with the support line),
  `license.storeUnavailable`. `license.buy`, `license.renew`, `license.enterKey` are reused.
  Cancel shows nothing.
  Run `pnpm run check:languages`; drop the key-only assertions in `LicenseSurfaceTests`,
  `LicenseSurfaceTest` and `licenseCopy.test.ts`.
- ADR-0006's D6 line ("key-only builds get...") and ADR-0005's key-only rows would have been
  superseded by ADR-0007; with it deferred they stand.
