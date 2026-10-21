## Routing changes, in code terms (not written)

Today the decision is a boolean: `futo_notes_license::license_link_out(platform,
storefront_country, build_allows) -> bool` in `crates/futo-notes-license/src/config.rs:222`,
projected by `crates/futo-notes-ffi/src/license/contract.rs:144`, and fed to
`license_row_actions(status, link_out)`. Android passes `BuildConfig.LICENSE_LINK_OUT` (`true` for
`direct`, `false` for `play`, `apps/android/app/build.gradle.kts:110,115`); iOS passes
`buildAllows: true` and the StoreKit country from `LicenseStorefront.swift`.

The proposal needs a third state, so the boolean becomes an enum owned by Rust:

- `enum PurchaseSurface { LinkOut, NameWebsite, KeyOnly }` and
  `license_purchase_surface(platform, storefront_country, distribution) -> PurchaseSurface`:
  - Desktop → `LinkOut`.
  - iOS: storefront `Some("USA")` → `LinkOut`; anything else, including `None` → `KeyOnly`
    (fail closed, unchanged).
  - Android: `direct` → `LinkOut`; `play` → `NameWebsite` (worldwide; no country input, because
    the consumption-only rule is the same everywhere).
- The Android build flag changes from a boolean to a distribution value (e.g.
  `LICENSE_DISTRIBUTION = "direct" | "play"`), so Rust, not Gradle, decides what that means.
- `license_row_actions(status, surface)`:
  - `LinkOut`: unchanged (Buy/Renew, EnterKey, LostKey).
  - `NameWebsite`: EnterKey, LostKey. No Buy/Renew.
  - `KeyOnly`: EnterKey only (LostKey only if Justin takes the medium-risk option).
- `license_links` gains a display address (the typeable `{url}`), from the same environment-split
  config as `buy`. Shells render it as plain text only.
- Shell copy selection keys off the surface instead of "has Buy": card explanation
  (`license.explanation` / `license.websiteExplanation` / `license.keyOnlyExplanation`), headline
  (shown for `LinkOut` and `NameWebsite`), icon footnote (`footnote` / `footnoteWebsite` /
  `footnoteKeyOnly`) and sheet body (`sheetBody` / `sheetBodyWebsite` / `sheetBodyKeyOnly`).
- Tests to move: the `license_link_out` assertions in `contract.rs` (~line 871), Android
  `LicenseSurfaceTest` / `DistributionFlavorTest`, iOS `LicenseSurfaceTests`; add one asserting the
  `play` address is not clickable.
- Docs: `docs/spec/license.md` (the "Checkout availability" line ~350, the key-only vocabulary
  bullets ~175–183, § Store posture), a new ADR or an amendment to ADR-0005 recording "Play names
  the website", and marking plan D17/D23/D24 and the ADR-0007 Gap as deferred per today's no-IAP
  decision.
