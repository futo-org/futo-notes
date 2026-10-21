### App Store purchase _(ios)_

ADR-0009. One StoreKit 2 non-consumable, `com.futo.notes.license`
(`APP_STORE_PRODUCT_ID`, read by the shell through
`license_app_store_product_id`), Family Sharing off. StoreKit verifies it on the
device; no server sees it, no key is minted, and nothing reaches desktop,
Android or sync.

- [The StoreKit purchase](app-store-purchase/storekit-purchase.md)
- [Key entry and the license card](app-store-purchase/key-entry-and-the-license-card.md)
- [The FUTO coin and the ambient label](app-store-purchase/coin-and-ambient-label.md)
