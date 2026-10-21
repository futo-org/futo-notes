## Getting a license

- **Buy** opens the **system browser** (never an in-app WebView) at this
  build's **generated checkout**:
  `{pay2}/checkout/polar/futo-notes/futo-notes-license/checkout-ready?platform=<desktop|ios|android>&success=redirect-to-organization-page`.
  There is no product landing page — no `pay.futo.tech/futo-notes` — and there
  will not be one (decision 2026-09-10); the app names the checkout FUTOpay's
  own landing route would have redirected to. → `futo_notes_license::buy_url`
- **The checkout's product segment is `futo-notes-license`, which is not the
  product name inside an activation.** The storefront sells `futo-notes-license`
  ("FUTO Notes License", non-recurring, verified on `staging-pay2.futo.org`
  2026-09-10; the price stays Polar's and is written nowhere here), while a v2
  activation's `payload.product` is matched against `futo-notes`. The two are
  separate constants and must stay separate: the URL segment briefly reused the
  payload's value, and that checkout served a page with no product in it (its
  `/price` answered `Product not found: futo-notes`), so Buy led nowhere on
  every client. → `CHECKOUT_PRODUCT_SLUG` and `PRODUCT_SLUG`,
  `the_checkout_slug_is_not_the_activation_payloads_product`
- **Checkout availability follows the distribution and storefront.** Desktop links out as before. _(ios)_ Only the US StoreKit storefront offers Buy or Renew, opened by `openURL` in the default browser; another or unknown storefront has the key field and deep link, with no checkout link. _(android)_ `direct` offers Buy or Renew worldwide in a Custom Tab (falling back to `ACTION_VIEW` when no provider exists); `play` has no Buy or Renew and names the website as plain text instead (§ States and copy), with the key field and deep link. No shell renders checkout in a WebView. The return path is the `futonotes://license/{key}/{activation}` deep link. Which of the three surfaces (link out, name the website, key only) a build gets is Rust's answer from its distribution and storefront. → `license_purchase_surface`, `license_link_out` (iOS), `license_surface_row_actions`, `license_row_actions` (iOS), `LicenseStorefront.swift`, `browser/CustomTabs.kt`, `license/LicenseLinkActivity.kt`
- The Buy destination is **per environment**, like the verification key and the
  activation host (AGENTS.md M3): `{pay2}` is `https://pay2.futo.org` for
  `com.futo.notes` and `https://staging-pay2.futo.org` for `com.futo.notes.dev`,
  so a dev build buys in the same org it verifies against and can never open
  production checkout. It was a single constant, which meant the opposite. →
  `Environment::for_bundle_id`, `tests/conformance/license.json` `buyUrls`,
  `a_dev_build_buys_on_staging`
- `platform` is attribution only: it never changes price, product, or
  entitlement, and FUTOpay drops a value it does not recognize. `success` is
  `redirect-to-organization-page`, the storefront's own marker (observed
  2026-09-10): the buyer pays in the system browser, and FUTOpay answers that
  marker with the **license key page** — the key as HTML plus an Activate
  button that fires the `futonotes://license/{key}/{activation}` deep link. An
  empty `success` is the client-driven marker, which FUTOpay answers with the
  raw activation JSON — the contract of the in-app-WebView clients this app
  never runs — and a buyer who had just paid was shown that JSON on staging
  (observed 2026-09-11), which is why the marker is sent. Both URLs in this
  spec are built by the Rust crate from
  the selected environment, so no shell hardcodes one and all three agree.
  _(desktop)_ The URL is read from the crate through `license_links` and opened
  with the opener plugin, never in a webview. → `license::license_links`,
  `src/lib/platform/openExternalUrl.ts`, `LicenseSettingsSection.svelte`
  _(ios)_ The URL comes from the same crate constants through
  `licenseLinks(platform: .ios, bundleId:)` and opens with SwiftUI's `openURL`, which hands
  an `https` URL to the default browser, only for a US StoreKit storefront. →
  `apps/ios/Sources/License/LicenseStorefront.swift`, `LicenseSettingsSection.swift`
  _(android, direct)_ The same crate call opens in a Custom Tab, or a plain browser
  when no Custom Tabs provider exists. The activate link returns to the existing
  `MainActivity` through `LicenseLinkActivity`. →
  `apps/android/app/src/main/java/com/futo/notes/browser/CustomTabs.kt`,
  `license/LicenseLinkActivity.kt`
- After checkout, FUTOpay's activate-redirect page opens
  `futonotes://license/{key}/{activation}`; the app handles it per
  [Deep link](deep-link.md#deep-link). The page also shows the key and activation as text,
  so paste is always possible.
- **Lost key**: the License card offers "Lost your key?" which opens
  `mailto:support@futo.tech`. There is no in-app restore flow (see Gaps). →
  _(desktop)_ `license::license_links`, `LicenseSettingsSection.svelte`;
  _(ios)_ `licenseLinks(platform:bundleId:).support`, opened with `openURL`;
  _(android)_ the same `support` constant, opened with the same `ACTION_VIEW`
  intent as Buy — the OS hands a `mailto:` to the mail client
- No Play Billing, no in-app price in our own copy, and no in-app checkout of
  the license key on any platform. _(ios)_ The one exception is the App
  Store-only purchase (ADR-0009, § App Store purchase): StoreKit's own sheet
  shows its price; it mints no key.
