# License — Spec

FUTO Notes asks the user to pay for it, and nothing in the app enforces that.
A user may **buy a license** for the client. The license unlocks nothing
functional: it removes the ambient **Unlicensed** label and fills the License
card's empty well with the FUTO coin, above a **Licensed since {date}** row.
Unpaid is a fully working app, but the product never calls itself "free to use"
— see § States and copy. This is the Grayjay / FUTO Keyboard / Immich model
("unregistered HyperCam 2"), sold through FUTOpay (Polar underneath). The server
product is a separate, later product with no shared semantics; see
[Out of scope](#out-of-scope).

Design decisions recorded 2026-09-09 (spec-first). All three clients implement
the whole surface as of 2026-09-09, each driven on its own dev build against a
staging-signed fixture license: all three states, all three input shapes (the
bare key only as far as its 404 — see the Gaps), the deep link, Buy, Remove and
Full reset. _(android)_ Both distribution flavors were driven, and the
consumption-only shape was driven too, by building `play` with
`LICENSE_LINK_OUT=false`.

Re-verified end to end by the #156 release gate on 2026-09-09, all three clients
driven again on one commit rather than one per landing: desktop through the dev
build's webview bridge, iOS on a pooled simulator, Android on a pooled emulator
across both flavors. Every row state, every input shape, the OS deep link and its
two rejection paths, Remove, Renew and persistence were observed on screen and
checked against `languages/en.json` verbatim; storage claims were confirmed in
UserDefaults / `futo_prefs` / the desktop app data dir rather than from the UI
alone. Two things stayed unproven and are recorded in the Gaps below, not here:
the bare key's 200 branch (no key minted yet — #155) and, on macOS only, the
LaunchServices hop into an unbundled dev binary.

Re-run again by the #160 release gate on 2026-09-10, on the commit that merges
`origin/main` into the license branch — so the merged full-reset path (main's
writer-admission + throwing-reset rewrite) was exercised for real on every
client rather than reasoned about. Desktop through the dev build's webview
bridge, iOS on a pooled simulator, Android on a pooled emulator across **both**
flavors plus a fourth build made by flipping `LICENSE_LINK_OUT=false`, which
confirmed the Play-compliant consumption-only shape is one gradle line away and
still fully usable by key field and deep link. New this round: the v1 activation
end to end on all three clients (row reads the single word "Licensed", desktop's
ambient label removes its element rather than blanking it), Expired driven for
real on Android by moving the device clock against the v2 fixture, and the
cold-start deep link measured frame by frame instead of screenshotted. Two
purchases were carried through the real staging checkout; both succeeded at
Polar and neither produced a key — see the bare-key Gap, which now records the
cause. Still unproven, and recorded in the Gaps rather than here: the bare key's
200 branch, and the macOS LaunchServices hop.

2026-09-11 closed the bare key's 200 branch and re-pointed the staging key. The
baked `STAGING_PUBLIC_KEY_BASE64` had been the 1Password pair, which **no
deployment has ever held** — FUTOpay generates an org's key itself at org
creation and never reads the `POLAR__ORGS__*__PRIVATE_KEY` the manifest injects
(lib-polar issue #1) — so every license staging could mint would have verified
as Invalid. The constant is now the key staging actually signs with, proven by
re-signing a server-minted license key with the deployed private half and
reproducing the server's activation byte for byte, and every staging-signed
fixture was re-minted against it. A real staging-minted license was then driven
on iOS through both entry paths: the bare key over the network (200, "Licensed")
and the OS deep link, plus Remove back to Unlicensed. What still does not work is
**buying** one — see the purchase-delivery Gap.

2026-09-16 replaced the one-line License row with the **License card** on all
three clients (`docs/plan/license-ship.md`), each driven on the commit that
shipped it. _(desktop)_ Unlicensed, Licensed and the reveal/copy path through
the dev build's webview bridge: the coin measured 160×160 inside the 184×184
well, Copy put the exact 42-character normalized key on the pasteboard, and
leaving Settings re-masked it. The celebrate spin is **measured**, not assumed —
354 sampled frames, the canvas visible on all 355 samples, mean per-frame pixel
delta decaying 8.9× from the opening half-second to rest, which is what
`CELEBRATION_SPIN` decaying toward `BASE_SPIN` predicts. _(ios)_ Unlicensed and
Licensed in both themes on a pooled simulator, the reveal (`xcrun simctl
pbpaste` returned that same normalized key, nothing else), and a v1 license
showing "Licensed since" present and blank with the term "Perpetual".
_(android)_ All three states × light and dark × both distribution flavors on a
pooled emulator, with Android's own clipboard chip showing the exact key after
Copy.

**Expired was reached from a stored license only on Android**, by moving the
emulator clock forward against the v2 staging fixture. _(ios)_ It has never been
rendered on an iPhone: the only staging-signed fixture expires 2029 and a
simulator's clock cannot be moved (`xcrun simctl` has no time subcommand), so
the Expired card is covered there by `LicenseCopyTests` and the
`licenseRowActions` golden alone. _(desktop)_ Its Expired card was rendered from
an **injected** `license.view`, not from a real activation — no staging-signed
activation with a past expiry exists and the private key is not in this repo.
Rust's expiry verdict has its own tests either way; what is unproven is the two
shells' rendering of it. Minting one expired staging activation into the shared
fixture would close that on all three platforms at once.

## Principles

- **Nothing is gated.** Every feature works identically licensed or not. The
  only differences are the ambient label and what the License card shows. Never
  add a licensed-only feature, theme, icon, or limit; a requested "cosmetic"
  feature that non-payers would want is a gate by another name.
- **It is a purchase, never a donation.** Copy says "license", "buy", "renew".
  The word "donate" never appears in the product or the store listing. (Stores
  treat donations differently and enforce against donation links; FUTO is not a
  nonprofit, so the word would also be inaccurate.) The rule scopes to shipped
  copy, not to this spec: naming the forbidden word in order to forbid it is
  what makes the rule checkable.
- **Price lives only in Polar and on the web.** The client never displays,
  fetches, or hardcodes a price. The Buy action opens the web checkout; the
  price is seen there.
- **Rust owns the rule.** Parsing, verification, expiry, deep-link parsing, and
  the single activation network call live in one Rust crate,
  `futo-notes-license`, projected through Tauri and UniFFI. Shells own only UI,
  URL-scheme registration, and preference storage (AGENTS.md §4.1, §4.6). No
  Swift, Kotlin, or TypeScript copy of any license rule.
- **Zero background network.** The license module contacts the network only on
  an explicit user action (entering a bare key). It never validates on launch,
  never polls, never phones home. Offline-first and privacy win over revocation.
- **Typing is sacred (M5).** License state is read once into reactive state; no
  per-keystroke or per-render verification.

## The license

- A license is a **license key** plus an **activation**.
  - **License key**: the FUTOpay format — eight groups of four characters from
    the FUTOpay alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ123456789`), hyphen-separated,
    optionally preceded by an org prefix and a hyphen (e.g.
    `FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78`). Matching is case-insensitive
    and ignores surrounding whitespace.
  - **Two activation formats are accepted, v1 and v2.** Which one arrives is
    the server's choice; the client answers to both, so FUTOpay can move to v2
    with **no client release**. → `futo_notes_license::activation`
  - **Activation (v1)**: a bare base64url (no padding) RSA-SHA256 PKCS#1 v1.5
    signature over the **license-key string alone** — no envelope, no product,
    no dates. It is what `pay2.futo.org` issues today, and what Grayjay and the
    other FUTO apps use. → lib-polar
    `pylib/futopay_server/licensing/key.py` `verify_key_pair`
  - **Activation (v2)**: `v2.<payload>.<signature>` where `<payload>` is
    base64url (no padding) of canonical JSON and `<signature>` is base64url (no
    padding) of an RSA-SHA256 PKCS#1 v1.5 signature over the exact payload
    bytes. Payload fields:
    - `key` — the license key, uppercase, exactly as signed;
    - `product` — the FUTOpay product slug; for this app `futo-notes`;
    - `issued_at` — RFC 3339 UTC purchase time; the source of "Licensed since";
    - `expires_at` — RFC 3339 UTC, or `null` for perpetual products. For
      `futo-notes` the server sets it to `issued_at` + 3 years. The client
      never knows or assumes a duration; it only compares `expires_at`.
  - Server side: lib-polar (separate repo); both contracts are defined here and
    pinned by fixtures (below).
- **Licensed (v1)** means: the activation is a single base64url segment whose
  signature verifies, against the baked-in FUTOpay public key for this app's
  org, over the normalized stored license key. Nothing else — the key _is_ the
  signed message, so there is no separate key comparison to make. It is
  **perpetual**: `issued_at` and `expires_at` are absent, so the card leaves the
  rows that need them blank, and no clock ever moves it out of Licensed.
- **Licensed (v2)** means all of: the activation parses as `v2.…`, the signature
  verifies against that same org public key, `payload.key` equals the stored
  license key, `payload.product` is `futo-notes`, and the current time is before
  `expires_at` (or `expires_at` is null). Nothing else.
  Verification is fully offline in both formats.
- **Expired** means everything above holds for a **v2** activation except the
  time check. An expired license is kept on the device and still shows its
  "Licensed since" date and its key. A v1 license never reaches Expired — the format cannot
  express an expiry — so Expired and its Renew action are reachable only for a
  v2 activation carrying an `expires_at`.
- **Invalid** is any other outcome. Invalid input is never stored.
- **Keys and org** (read the [one-product tripwire](#decision-2026-09-10--accept-v1-alongside-v2)
  before adding a second product to this org): FUTO Notes has its own FUTOpay org and RSA key pair. The
  release build embeds the production public key and talks to
  `https://pay2.futo.org`; dev builds (the `.dev` bundle/package IDs, M3) embed
  the staging public key and talk to `https://staging-pay2.futo.org`. Selection
  follows the existing dev/prod split — a dev build can never verify or fetch a
  production license, and vice versa. Fetching a public key at runtime is not
  allowed.
- **Fixtures**: `tests/conformance/license.json` holds a **test-only** RSA key
  pair, plus golden vectors for: valid; expired; wrong product; tampered
  payload; wrong key; malformed base64; each accepted input shape from
  [Entering a key](#entering-a-key); and, for v1, a valid activation, one signed
  by the wrong org key, one minted for a different license key, and one that is
  not base64url at all. The Rust crate's tests read the goldens, so both
  verifiers are provable before the server ships v2. The fixture private key is
  never used outside tests. The staging-signed activations the native and FFI
  fixtures carry (both formats, minted by
  `scripts/gen-license-fixture.mjs --staging`) are a separate, real key pair.
- **Clock**: the client trusts the device clock. A user who sets their clock
  back to appear licensed has spent effort to see a badge; no countermeasure.
- **Revocation and refunds**: with no background network, a refunded or revoked
  key keeps working on every device that already activated. This is a deliberate
  trade for offline-first and privacy; the stakes are a badge. (See Gaps.)
- **Storage**: license key and activation are stored as two plain strings in
  the platform's app-private preferences (UserDefaults / SharedPreferences /
  the desktop app data dir), never in the vault, never in the OS keyring, and
  inside the dev/prod-split data location (M3). They survive app updates and
  are wiped by **Full reset** like every other preference (see settings.md,
  Danger zone). _(ios)_ `UserDefaults.standard` is scoped to the bundle id, so
  the dev/prod split is the app sandbox itself. →
  `apps/ios/Sources/License/LicenseStorage.swift` (`futo.license.key`,
  `futo.license.activation`), `FullReset.swift`, `LicenseModel.clearForFullReset`
  _(android)_ `SharedPreferences` in the app-private `futo_prefs` file, whose
  package is `.dev`-suffixed on debug builds, so the split is the Android
  sandbox itself. Full reset removes both keys with the vault. →
  `apps/android/app/src/main/java/com/futo/notes/license/LicenseStorage.kt`
  (`Prefs.LICENSE_KEY`, `Prefs.LICENSE_ACTIVATION`),
  `SettingsScreen.kt` (the Danger-zone confirm calls
  `LicenseModel.clearForFullReset`), `LicenseModelTest`
  "fullResetWipesTheStoredLicenseSilently"
- _(native shells)_ Full reset invalidates any activation already in flight. A
  delayed success is discarded without restoring preference storage, changing
  the Unlicensed state, or announcing activation. → iOS and Android
  `LicenseModel` operation revisions; `fullResetInvalidatesPendingActivation`,
  `fullResetInvalidatesAnActivationAlreadyInFlight`

### Decision 2026-09-10 — accept v1 alongside v2

This **reverses specified intent**, recorded as a decision by @justin rather
than as a closed Gap: until 2026-09-10 this spec said the v1 activation "is
**not** accepted by FUTO Notes". It is now accepted, and v2 is kept. Issue #161.

Why the original reasoning did not survive contact with the deployed product:

- **Product binding never came from the payload.** FUTO Notes has its own
  FUTOpay org RSA key pair, so a Grayjay or Immich activation cannot verify
  against this app's public key whatever format it is in. `payload.product` is
  belt-and-braces, not the binding.
- **The deployed product is perpetual.** `GET
/checkout/polar/futo-notes/futo-notes-license/info` reports
  `license_term: null` and `/price` reports a one-time, non-recurring price
  (observed 2026-09-10), so `expires_at` would be `null` even under v2 — Expired
  and Renew are unreachable _from anything the server mints today_, either way,
  until someone sets a term. That is a **product** condition, not a missing code
  path: the client's Expired branch works and was driven on the emulator
  2026-09-10 (#160) by holding the v2 fixture (which carries
  `expires_at` 2029-01-15) and moving the device clock to 2030. The row read
  "License expired Jan 15, 2029 · Supporter since 2026" and offered Renew /
  Enter license key / Lost your key?, with Renew opening the same generated
  checkout as Buy. The same run confirmed the complement: a v1 license held
  under the same future clock stayed simply "Licensed", since no clock can move
  a v1 activation out of Licensed.
- That left `issued_at` — then rendered as the bare year in "Supporter since",
  and since 2026-09-16 as the full date in "Licensed since" (D3) — as the only
  thing v2 buys today. `staging-pay2.futo.org` runs the pre-v2 code, so shipping against
  v1 needs no lib-polar change at all.

**v2 is not removed, and must not be.** Dual acceptance is what lets the server
switch to v2 later with **zero client release** — the shipped mobile apps cannot
be hot-fixed, so deleting the v2 path would turn that migration into two store
submissions. v2 semantics are unchanged whenever a v2 activation arrives.

> **TRIPWIRE — one product per org.** A v1 signature covers the license-key
> string alone, so **any** v1 activation minted by the `futo-notes` FUTOpay org
> verifies for this product. That is safe only while that org mints license keys
> for exactly one product. A subscription product is coming under the same org;
> it issues no license keys, so it does not trip this.
> **If any second product in the `futo-notes` org ever mints a license key, v1
> acceptance must be dropped and v2 becomes mandatory** — a `payload.product`
> check is the only thing that separates two products under one key pair. That
> is the second reason the v2 path stays: dropping v1 must remain a client change
> that is already written, not one that has to be written under pressure.
> Mirrored in `crates/futo-notes-license/AGENTS.md`, which is what a change to
> the verifier makes someone read.

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
- **Every surface links out; no client renders checkout itself.** Desktop, iOS
  and Android — both flavors, wherever `LICENSE_LINK_OUT` permits a link at all
  — hand that same generated checkout to the OS browser, and the buyer comes
  back through the `futonotes://license/{key}/{activation}` deep link. There is
  no in-app purchase sheet on any platform and none is planned (decision
  2026-09-10): a WKWebView checkout is an App Store rejection, because Apple
  requires an external purchase link to open in the default browser, and a
  bespoke Android-only sheet was declined rather than let the platforms
  diverge. This is what keeps "price lives only in Polar" literally true — no
  client ever has a price to display.
- The Buy destination is **per environment**, like the verification key and the
  activation host (AGENTS.md M3): `{pay2}` is `https://pay2.futo.org` for
  `com.futo.notes` and `https://staging-pay2.futo.org` for `com.futo.notes.dev`,
  so a dev build buys in the same org it verifies against and can never open
  production checkout. It was a single constant, which meant the opposite. →
  `Environment::for_bundle_id`, `tests/conformance/license.json` `buyUrls`,
  `a_dev_build_buys_on_staging`
- `platform` is attribution only: it never changes price, product, or
  entitlement, and FUTOpay drops a value it does not recognise. `success` is
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
  an `https` URL to the system browser. →
  `apps/ios/Sources/License/LicenseSettingsSection.swift`, `LicenseSurfaceTests`
  _(android)_ The same crate call, `licenseLinks(LicensePlatform.ANDROID, bundleId)`,
  opened with an `ACTION_VIEW` intent, which the OS routes to the browser — never
  a WebView. →
  `apps/android/app/src/main/java/com/futo/notes/ui/LicenseSettingsSection.kt`,
  `LicenseSurfaceTest` "theBuyLinkIsThisPlatforms"
- After checkout, FUTOpay's activate-redirect page opens
  `futonotes://license/{key}/{activation}`; the app handles it per
  [Deep link](#deep-link). The page also shows the key and activation as text,
  so paste is always possible.
- **Lost key**: the License card offers "Lost your key?" which opens
  `mailto:support@futo.tech`. There is no in-app restore flow (see Gaps). →
  _(desktop)_ `license::license_links`, `LicenseSettingsSection.svelte`;
  _(ios)_ `licenseLinks(platform:bundleId:).support`, opened with `openURL`;
  _(android)_ the same `support` constant, opened with the same `ACTION_VIEW`
  intent as Buy — the OS hands a `mailto:` to the mail client
- No IAP, no Play Billing, no in-app price, no in-app checkout on any platform.

## Entering a key

- One text field, labelled "License key". It accepts, after trimming
  whitespace, any of:
  1. a bare license key;
  2. `{key}/{activation}`;
  3. the full `futonotes://license/{key}/{activation}` URL.
     Recognition of the three shapes is one Rust function shared with the deep-link
     handler.
- Shapes 2 and 3 verify **fully offline** and never touch the network.
- **Paste and the deep link are the supported ways to put an activation in the
  field; hand-typing one is not.** _(ios)_ The system keyboard's smart-dash
  substitution turns the `--` inside a v2 activation into an en dash, and the
  app then correctly answers a corrupted signature with "This license key isn't
  valid". `.autocorrectionDisabled()` does not disable smart dashes and SwiftUI
  exposes no modifier that does. Both supported paths — a paste and the
  `futonotes://` link — activated the same pair on the simulator 2026-09-16, so
  this is a property of the input method rather than a gap in the surface.
- Shape 1 requires **one** request: `GET
{pay2}/api/v1/activate/{url-encoded key}` returns the v2 activation as plain
  text on 200, or 404 (`not found`, `not valid`, `revoked`). The app then
  verifies the pair exactly as for shape 2. Failures:
  - no connectivity / transport error → "Connect to the internet to activate
    this key" (the key is not stored);
  - 404 → "This license key isn't valid";
  - 200 but the pair fails verification → "This license key isn't valid".
    The request carries no identifiers beyond the key; there is no retry loop and
    no background re-attempt.
    The 200 branch was first seen from the real server on 2026-09-11, once a key
    existed to ask about (minted without a purchase through
    `/admin/createkey/futo-notes/futo-notes-license` — buying one still does not
    deliver a key, see the Gaps). _(ios)_ On a dev build, key field → the bare key
    alone → **Activate**: one `GET /api/v1/activate/{key}`, **200**, a **v1**
    activation, and the row flipped to the single word "Licensed" with **Remove
    license** as its only action; the stored activation is byte-for-byte the 342
    chars the endpoint returned, and Remove put the device back to Unlicensed with
    both preference keys gone. A server-minted key carries **no org prefix** — the
    `futo-notes` org's `prefix` column is empty — and is eight groups of four from
    the restricted alphabet, so the shipped grammar takes it unchanged.
- The key field is reachable only in the **Unlicensed** and **Expired** states:
  the Licensed card's only action is **Remove license**
  (`license_row_actions`), so there is no "Enter license key" while a license is
  stored. Replacing a license therefore happens through the **deep link**, which
  replaces without confirmation, or by removing the old one first — not by
  re-entering into the field. Verified on all three clients 2026-09-10 (#160);
  recorded because the absent field is easy to misread as a missing affordance.
  → `crates/futo-notes-ffi/src/license/contract.rs` `license_row_actions`
- On success the pair replaces any stored license, state flips to Licensed (or
  Expired, if the key is already past `expires_at` — still stored, with the
  Expired copy shown), and a toast confirms "License activated". Entry is
  atomic: verify-then-store happens in Rust as one call (§4.6). _(desktop)_ That
  call is `license_enter_key`; the shell hands over the raw text and receives the
  new state with its outcome, so it never sequences activate-then-verify and
  never re-reads the status afterwards. →
  `license::license_enter_key`, `src/lib/platform/license.ts`,
  `src/features/license/license.svelte.ts`
  _(ios)_ The same one call is `licenseEnterKey(input:bundleId:)`, async because
  the bare-key path makes the one request; the shell persists the returned pair
  and renders the returned state, and never asks again. →
  `crates/futo-notes-ffi/src/license/contract.rs`,
  `apps/ios/Sources/License/LicenseModel.swift`
  _(android)_ The same one call is `licenseEnterKey(input, bundleId)`, from a
  coroutine so the bare-key request never touches the main thread; the shell
  persists the returned pair and renders the returned state. →
  `apps/android/app/src/main/java/com/futo/notes/license/LicenseModel.kt`,
  `LicenseModelTest` "aPastedPairActivatesOffline", "aPastedLinkActivatesOffline",
  "anUnrecognisablePasteStoresNothing"

## Deep link

- The scheme is **`futonotes`** on all three platforms: iOS `CFBundleURLTypes`,
  Android an exported `VIEW`/`BROWSABLE` intent filter on the main activity,
  desktop the Tauri deep-link plugin on Linux, macOS and Windows (the Tauri
  shell is desktop-only). → _(desktop)_ `tauri-plugin-deep-link` with
  `plugins.deep-link.desktop.schemes` in `tauri.conf.json`, `license::install`;
  a second launch carrying the link arrives through the single-instance plugin's
  argv (`license::handle_single_instance_arguments`). _(ios)_ `CFBundleURLTypes`
  in `apps/ios/Info.plist`, delivered by `.onOpenURL` on the root view. →
  `LicenseSurfaceTests` "the app registers the crate's URL scheme" (asserts the
  shipped plist against the crate's `licenseDeepLinkScheme()`),
  `LicenseModel.handle`. Dev
  builds register the same scheme; whichever build the OS routes to will verify
  against its own key, so a production link opened by a dev build fails cleanly
  as Invalid.
- Only the path `license/{key}/{activation}` is defined. Any other host or path
  is ignored silently. That verdict is the crate's on every platform, never a
  shell's. → `license::parse_deep_link`, _(ios)_ the `Ignored` arm of
  `licenseHandleDeepLink`, `LicenseModelTests` "an undefined link is ignored
  silently"; _(android)_ the same `Ignored` arm in `LicenseModel.handle`,
  `LicenseModelTest` "anUndefinedLinkIsIgnoredSilently" — driven on the emulator
  as `am start -d futonotes://settings/open`, which left the screen
  byte-identical
- A valid link **replaces** an existing license without confirmation and shows
  the "License activated" toast. An invalid link shows one toast, "This license
  link isn't valid", and changes nothing. No dialog, no navigation; if Settings
  is open its License card updates in place.
- A link arriving while the app is cold-starting is handled after the shell is
  interactive (M1): the shell renders first, then applies the link. _(ios)_
  SwiftUI hands a launch URL to `.onOpenURL` only once the root view exists, and
  the toast rides the transient banner the note list already mounts, so a
  cold-start link is applied and announced on a painted screen. →
  `apps/ios/Sources/App/FutoNotesApp.swift`, `LicenseModel.handle`; a message
  produced before the app has wired up its banner is parked and flushed the
  moment it has one, so the toast survives even the earliest launch URL. →
  `LicenseModelTests` "a cold-start link is announced once the banner exists".
  The stored pair is read and RSA-verified away from the main actor after the
  shell renders; a link or other newer action prevents that startup result from
  replacing it. → `LicenseModel.load`, `stateRevision`
  _(android)_ The launch intent's URL is parked in Compose state during
  `onCreate` and applied by a `LaunchedEffect` after the first composition, so
  the note list _shell_ is painted before the link lands and the toast appears on
  it. Measured frame by frame on the emulator 2026-09-10 (#160, 20 fps
  screenrecord): splash to 3.90s, the shell — top bar, icons, FAB — paints at
  3.95s, the toast begins fading in at 4.05s **after** it, and the note **rows**
  arrive at 4.95s, so the toast rides an empty list for ~0.9s while the vault
  scan finishes. That is M1's intended shape (a scan may delay content, never the
  shell) and is the same empty window a plain launch shows; the toast never lands
  on the splash or a blank window;
  the same state carries a link from `onNewIntent`, so both deliveries take one
  path, and a launch intent is consumed once — a recreation that re-delivers it
  does not re-announce a license the user already has. The stored pair is read
  _and verified_ off the main thread (M1), and that answer is not allowed to
  overwrite a license the link applied while it was in flight. →
  `apps/android/app/src/main/java/com/futo/notes/MainActivity.kt`
  (`pendingLicenseLink`), `LicenseModel.load`/`applyEvaluated`, `LicenseModelTest`
  "aLinkAppliedBeforeTheStoredPairLandsSurvivesIt"
  _(desktop)_ Rust applies and _parks_ the outcome — storing blocks no render — and the shell
  drains it once it has painted, so the toast is delivered exactly once whether
  the link arrived before or after the webview existed. The asynchronous startup
  snapshot is revision-guarded, so it cannot overwrite the drained outcome. →
  `license::LicenseLinkInbox`, `license_take_pending_link`,
  `license::tests::a_parked_link_outcome_is_delivered_exactly_once`,
  `license.svelte.test.ts` "does not let the startup snapshot overwrite a license"

## States and copy

The License **card** has exactly three states. All strings are catalog entries
(`languages/en.json`, prefix `license.`); dates render in the user's locale
(localization.md) as a **full localized date, never a bare year**.

The card is the same object in every state: a status **badge**, the eyebrow
"Client license", the product name "FUTO Notes", a **well** that holds the FUTO
coin while Licensed, and the ledger rows, followed by the state's actions and
its explanation paragraph.

_(native shells)_ The well is present in every state and empty when there is no
coin, and there are three ledger rows — **Key**, **Licensed since**, **Term** —
each present in every state and blank when the license carries no value for it;
a blank row is what "nothing is invented" looks like.

_(desktop)_ **The well, the letterhead and the ledger exist only when they have
something in them** (@justin 2026-09-17, extended 2026-09-18). There is no empty
well: an empty circle read as something that had failed to load rather than as
"no license". The badge, the "Client license" eyebrow and the uppercase product
name now belong to a **stored license** — the letterhead belongs to a card, and
Unlicensed has no card, only an ask, so it leads with the headline instead.
**Licensed since and Term are gone outright** — nothing records a purchase date and nothing
limits a license today, so both rows only ever said blank or "Perpetual". That
leaves **Key** as the whole ledger, and with no key there is no ledger at all,
because one blank row is the same void the well was. The plate also sits on the
**same surface as every other Settings card** rather than on a gunmetal gradient
of its own, which read as a foreign object in the sheet; only the gold accent is
still the plate's own, because the app has no token for it.
→ `licenseCardModel` in
`src/features/license/licenseCopy.ts`,
`apps/ios/Sources/License/LicenseCopy.swift`,
`apps/android/app/src/main/java/com/futo/notes/license/LicenseCopy.kt` — one
drift-registered concept, `license-card-copy`

| State          | Badge        | Key                | Licensed since                      | Term                                | Actions                                             |
| -------------- | ------------ | ------------------ | ----------------------------------- | ----------------------------------- | --------------------------------------------------- |
| **Unlicensed** | "Unlicensed" | blank              | blank                               | blank                               | **Buy a license** · I already paid · Lost your key? |
| **Licensed**   | none         | masked, revealable | "{date}", blank with no `issued_at` | "Perpetual" or "Valid until {date}" | Remove license                                      |
| **Expired**    | "Expired"    | masked, revealable | "{date}"                            | "Expired {date}"                    | **Renew** · I already paid · Lost your key?         |

_(desktop)_ The Key column is the whole table: the row is absent rather than
blank when Unlicensed, and the two date columns do not exist. **Unlicensed wears
no badge on desktop either** — the section heading says "License" and the sidebar
already says "Unlicensed"; a third copy of the word was chrome.

The key-entry action is **"I already paid"** on every platform, which is what
Grayjay (`i_already_paid`) and FUTO Keyboard (`payment_screen_already_paid_button`)
both call it: it names the person's situation rather than the mechanism. It is
one catalog entry, `license.enterKey`, so all three shells moved together
(@justin 2026-09-18).

> **Gap:** the desktop plate dropped the empty well, the Licensed-since and Term
> rows, the Copy key button and the gunmetal palette on 2026-09-17, and gained
> the Unlicensed ask, click-to-turn and the activation coin burst. On 2026-09-18
> it also dropped the badge, eyebrow and product name from the Unlicensed state
> and moved the mission paragraph above the Buy button. iOS and
> Android still render all of it the old way. The copy itself is still shared (`license-card-copy`); it is what
> each shell chooses to _show_ that has diverged, and the native shells have not
> been brought across. → `tests/license-card.spec.ts`

- Bold is the one action the state leads with, and on every platform it is the
  **only filled button on the card**: Buy/Renew. Enter license key, Lost your
  key? and Remove license are text links beside it — two filled slabs of equal
  weight read as two equally likely choices, and they are not. Availability is
  unchanged; this is emphasis, not gating. _(native shells)_ Which controls
  exist at all is Rust's answer, `license_row_actions`, which also owns what
  `LICENSE_LINK_OUT` hides; _(desktop)_ the plate still derives its two buttons
  inline, because desktop has no `LICENSE_LINK_OUT` to obey (drift concept
  `license-row-actions`).
- **The Licensed state wears no badge on any platform.** The coin in the well is
  the statement; the word placed over the gold "Client license" eyebrow reads as
  a duplicated eyebrow, which is why iOS removed it after seeing it on a device
  (2026-09-16). The state stays machine-readable: _(ios)_ `license-well` carries
  the accessibility value `Licensed` / `Unlicensed` / `Expired`, with its label
  being the coin's or "No license". **A QA playbook that reads `license-status`
  on iOS must fall back to `license-well`'s value in the Licensed state**, where
  no `license-status` element exists — otherwise it reports a false failure. →
  `apps/ios/Sources/License/LicenseSettingsSection.swift`
- **Term** is blank with no license: "Perpetual" there would be a claim the app
  cannot make. It is "Perpetual" when `expires_at` is null **and** for a v1
  activation, which is perpetual by format rather than by guess; "Valid until
  {date}" while a v2 expiry is still in the future; "Expired {date}" once it has
  passed. → `licenseCopy.test.ts` "reads a license with no expiry as Perpetual",
  _(ios)_ `LicenseCopyTests`, _(android)_ `LicenseCopyTest`
- **With no `issued_at` — a v1 activation — the "Licensed since" row is present
  and blank.** There is no dateless variant of the line, no placeholder date,
  and the activation-fetch time is never used as a stand-in. Production mints v1
  today, so a blank "Licensed since" row is what a real buyer sees: the coin,
  the key and the "Perpetual" term carry the state on their own. Observed on the
  simulator 2026-09-16. → `licenseCopy.test.ts` "leaves the since row blank for
  a v1 license and calls the term perpetual"; _(ios)_ `LicenseCopyTests`;
  _(android)_ `LicenseCopyTest`
- **The card shows the stored key masked to its last group** — seven groups of
  four middle dots, then the key's real last four characters
  (`···· ···· ···· ···· ···· ···· ···· RS78`) — and clicking or tapping it
  reveals the whole normalized key. _(native shells)_ The revealed key is
  accompanied by **Copy key**, which puts exactly that key on the system
  clipboard and confirms with the "License key copied" toast. _(desktop)_ There
  is no copy affordance at all: the revealed key is plain selectable text, and
  copying it is a deliberate select-and-copy, because a license key should not
  be one click from the clipboard (@justin 2026-09-17).
  **Revealing and copying is local UI, not a rule**: nothing is verified,
  fetched or stored, the reveal lasts only while the card is mounted, and
  leaving Settings re-masks it. The key reaches every shell already normalized,
  on the license view itself, so no shell reads it back out of its own storage
  to display it. → `licenseCopy.test.ts` "masks every group of the key but the
  last", `tests/license-card.spec.ts` "the masked key reveals the full key, with
  no copy button"; _(ios)_ `LicenseSurfaceTests` "the card shows the masked key and
  reveals on tap"; _(android)_ `LicenseSurfaceTest`
  "theCardMasksTheStoredKeyAndRevealsItOnTap"
- Each row pairs a **label with a value**; the arrangement is the platform's.
  _(native shells)_ Every row stacks its label above its value, and _(desktop)_
  the Key row does too — a 39-character monospace key does not fit beside a
  label at phone width, and beside a 184px well it does not fit on a narrow
  desktop pane either. The well itself sits beside the fields on desktop and
  above them on the native shells and on a narrow desktop pane.
- Under the rows, in FUTO's house voice — the app **never** describes itself as
  "free to use", because it is asking to be paid and only declines to force the
  issue. The wording follows Grayjay's `buy_text` and FUTO Keyboard's
  `payment_screen_sales_point_development_body`, which share the mission
  sentence verbatim and neither of which calls its app free:
  - Unlicensed and Expired (`license.explanation`): "FUTO's mission is for
    open-source software and non-malicious software business practices to become
    a sustainable income source for projects and their developers. That is why
    FUTO Notes asks you to pay for it, rather than serving you ads or selling
    your data."
  - _(desktop)_ Unlicensed **leads with the ask** and puts the reason **above**
    the Buy button, not under it: the headline `license.unlicensedHeadline`
    ("Pay for FUTO Notes"), then the mission paragraph, then the one filled
    button. That is the shape all three sibling FUTO-model apps use — Grayjay's
    Buy screen, FUTO Keyboard's Payment screen and Immich's purchase panel are
    each a heading, the reason, one pay button and a way in for someone who has
    already paid — and an argument printed under the button it argues for is a
    footnote (@justin 2026-09-18). **The mission paragraph is the only
    paragraph.** A second one in the plate's own voice ("Nothing here is locked,
    and a license unlocks nothing — we would rather ask than force the issue.",
    `license.unlicensedPitch`) lived here for one day and went out 2026-09-18
    (@justin): the state now says what it needs in a heading and a paragraph.
    Unlicensed and Expired therefore read identically below the headline — only
    the button's word differs. The app still never calls itself free to use; it
    asks to be paid and declines to force the issue. →
    `tests/license-card.spec.ts` "unlicensed: the ask, no card chrome, Buy as
    the only filled button"
  - Licensed (`license.explanationLicensed`), verbatim after FUTO Keyboard's
    `payment_screen_aftersales_paragraph_1`: "Thank you for purchasing FUTO
    Notes." ("paying for" until 2026-09-18, @justin.) One sentence: the second, about continued development, was dropped
    2026-09-16 (plan D7) when the card replaced the row.
    → all three shells select the key off the state: `LicenseSettingsSection`
    in `src/features/license/`, `apps/ios/Sources/License/`, and
    `apps/android/app/src/main/java/com/futo/notes/ui/`
- **Renew** is the Buy action; a new key simply replaces the old one.
- **Remove license** asks for no confirmation (it is reversible by re-entering
  the key) and returns the device to Unlicensed. It exists for testing and
  device hand-off.
- No state ever shows a price, a countdown, a nag, or a banner. There is no
  pre-expiry notice outside the card's own "Valid until" term.
- **The FUTO coin** is the one thing a purchase _adds_, on all three platforms:
  a gold coin with the FUTO diamond punched through it, sized 160 inside the
  184 well (CSS px on desktop, pt on iOS, dp on Android) while the state is
  Licensed, and absent — leaving the well empty — in every other state. The well
  is **unpainted space**, not a drawn recess: it reserves the 184 box and carries
  the accessibility label, and nothing is stroked or filled in it on any
  platform. It was a machined recess with an inset-shadow edge until 2026-09-16,
  when @justin asked for the circle border gone on all three; on Android that
  edge had been the entire well. On desktop the well is also **vertically
  centred** against the field column rather than pinned to its top — the coin is
  the only thing on that side, and a circle at the top of a taller column reads
  as having slipped. Its dimensions are the storefront's, ported from lib-polar
  `pylib/futopay_server/static/js/coin-bounce.js` without that file's physics
  world.
  Since 2026-09-16 the coin is **one 3D model, modelled in Blender** by
  `assets/coin/build-coin.py` and rendered by all three shells: a bevelled disc
  with the FUTO diamond punched clean through it, gold face over a darker rim.
  The script exports `futo-coin.glb` (desktop, Android), `futo-coin.usdz` (iOS)
  and `studio-env.hdr`, the small studio every shell reflects off it. **The
  environment is not decoration.** Gold is a metal and a metal renders black with
  nothing to reflect, which is why the coin's materials carry no emissive term
  and why the environment ships as an asset. Android cannot read the `.hdr`
  directly — Filament wants it prefiltered — so `scripts/build-coin-ibl.mjs`
  derives `studio-env-ibl.ktx` from it with a pinned `cmgen`. iOS reads the
  `.hdr` itself, because ImageIO decodes `public.radiance`. →
  `just coin` / `just coin-check`
  Nothing in TypeScript, Swift or Kotlin restates the coin's shape or materials.
  CI has no Blender, so `just coin-check` (in `just check`) proves the cheap
  half: the exports came from the `build-coin.py` on disk, no export was
  hand-edited (M8), and the Android cubemap was prefiltered from the `.hdr`
  currently on disk. That last pairing is the one step a person can silently
  skip — a stale cubemap loads fine and just reflects last week's room on one
  platform. → `scripts/check-coin-assets.mjs`
  The flat glyph survives on all three platforms as a **fallback only**, shown
  when the 3D renderer cannot start: desktop's inline SVG, an iOS vector
  imageset, an Android vector drawable (drift concept `supporter-coin-glyph`).
  That glyph is the FUTO diamond — a rounded square on its point, half-diagonal
  0.45 of the disc radius, the same four constants the Blender model uses. Until
  2026-09-16 all three copies carried a hand-drawn path that was a pinched
  figure-eight instead, roughly a quarter of the right width; desktop hid it
  behind its 3D coin, so it was only ever visible on the two native shells. The
  path is now DERIVED rather than drawn, and
  `scripts/check-supporter-coin-glyph.mjs` (in `check:arch-gate`) fails if any of
  the three stops matching it. Being a fallback makes a wrong glyph EASIER to
  ship unnoticed, not harder. →
  `just check` / `node scripts/check-supporter-coin-glyph.mjs --print`
  The coin is not a claim about a date and renders for a v1 activation
  regardless.
  - _(desktop)_ **Activating a license throws a burst of coins across the
    plate** — around 120 little tumbling gold coins that bounce off the plate's
    four walls, heap along its bottom edge and fade out after about three
    seconds. FUTOpay's checkout page does the same on a purchase
    (`coin-bounce.js` in lib-polar) and @justin asked for it here, with one
    deliberate difference: **it is confined to the plate**, structurally — the
    canvas is the plate's own child, clipped by its rounded corners — rather
    than raining over the notes behind the Settings sheet. It is a plain 2D
    canvas running ballistic motion and a coefficient of restitution: no physics
    engine (nothing at this size can show the difference, and a rigid-body
    dependency would land in the bundle of an app whose editor budget is per
    keystroke) and no second WebGL context (the document has a small fixed pool
    and the coin in the well already holds one). It fires on the moment a license
    is **newly stored** — a key pasted in, or a `futonotes://` link the OS handed
    us — and never on a license the plate merely finds already there. That is a
    **debt the plate collects and spends**, `license.activationToCelebrate` /
    `celebrated()`, not a state it reads: an activation that lands while Settings
    is closed still gets its coins the first time the plate is opened, and gets
    them exactly once. Counting activations alone was not enough — removing a
    license left the count at 1, so clicking the sidebar's "Unlicensed" label
    threw a celebration over nothing (@justin 2026-09-18).
    **`prefers-reduced-motion: reduce` skips it entirely**, unlike the coin,
    which still has to render. It removes itself when it is done (M5). →
    `coinShower.ts`, `tests/license-card.spec.ts` "activating a license throws a
    burst of coins inside the plate" + "no coins are thrown for a license that
    was already stored" + "the burst is spent: reopening Settings does not throw
    it again" + "removing the license and reopening Settings throws no coins" +
    "no coin burst is thrown at all"
  - _(desktop)_ **Clicking the coin turns it once around**, fast, on top of
    whatever it was already doing (@justin 2026-09-17). A click is a press that
    moved 5px or less and lasted 400ms or less, so it is a drag that went
    nowhere and never steals a real drag or a flick. **Clicks queue: ten clicks
    are ten turns.** What a click adds is an ANGLE the coin owes — paid back
    fastest when the most is owed, floored so the tail is a coast rather than an
    asymptote, and capped so a burst cannot become a strobe — so nothing is ever
    dropped. The first version held a phase into one half-second turn and set it
    back to zero on each click, which swallowed every click but the last
    (@justin 2026-09-18). Distinct from the activation celebration, which is a
    spin-up the decay bleeds off and which lands wherever it lands. →
    `supporterCoin.test.ts` "turns ten times for ten clicks",
    `tests/license-card.spec.ts` "licensed: clicking the coin spins it a full
    turn" + "licensed: eight fast clicks on the coin queue eight turns"
  - _(all platforms)_ The coin can be **dragged**: a horizontal drag turns it
    under the pointer or thumb, and releasing while still moving throws it, the
    spin bleeding back to its resting speed. A vertical swipe is left to the
    scrolling surface underneath, so a drag on a phone never traps the sheet.
    The resting speed, decay, drag ratio, flick clamp, tilt and camera framing
    are the same numbers on all three (drift concept `supporter-coin-motion`),
    as is the orientation law: **tilt first, then spin**, so the coin turns on a
    fixed tilted spindle. Composing those the other way swings the spindle and
    the coin wobbles like a dropped hubcap — it renders either way, which is why
    both native shells lock the order in a test. →
    `SupporterCoinTest.kt`, `SupporterCoinTests.swift`
  - _(desktop)_ The coin **turns**: three.js, loaded on demand along with the
    model and the environment, so it costs a non-supporter nothing at startup.
    It spins up once on the moment of activation and settles again, holds still
    under `prefers-reduced-motion: reduce`, stops entirely when scrolled out of
    view or the window is hidden (M5), and falls back to the flat SVG coin where
    WebGL is unavailable or either asset fails to load. Tone mapping is Khronos
    PBR Neutral rather than ACES, which pushes a bright saturated highlight
    toward white and turns the gold sheen grey exactly where it should be most
    golden. The
    spin-up was measured on the real app 2026-09-16, not inferred: per-frame
    pixel motion decays 8.9× from the opening half-second to rest.
    **It is deliberately NOT in the sidebar footer**: that corner sits one
    keystroke from the editor, and a permanent animation beside it is exactly
    the background cost M5 exists to stop. Settings is a surface the user opened
    on purpose and can leave. → `SupporterCoin.svelte`, `supporterCoin.ts`,
    `license.svelte.ts` (`activations`) + `license.svelte.test.ts` "marking the
    moment of activation"
  - _(native shells)_ Both render the same model, at the same one-turn-per-5s
    resting speed. Android uses **Filament** (`gltfio` for the model,
    `KTX1Loader` for the prefiltered studio) in a `TextureView`; iOS uses
    **RealityKit** (`RealityView`, `ImageBasedLightComponent`). Until 2026-09-16
    neither carried a 3D engine: both **projected** the flat glyph twice to fake
    an extruded disc. That was cheap and correct in silhouette, but it could not
    light metal — a shape with a gradient painted on it reads as a sticker
    however accurately it is squeezed.
    Two numbers are deliberately NOT shared, because each renderer scales an
    image-based light differently and the same studio arrives at a different
    brightness in each: Filament's IBL intensity is 4.5 where three.js uses 1.0,
    and RealityKit's intensity exponent is -1.5. Both are **measured**, not
    guessed — each is where the mean colour of the coin's gold pixels lands
    within a few points per channel of the other shells. Filament's tone mapper
    is also set to PBR Neutral for the reason desktop's is; at its ACES default
    the coin read as brushed aluminium.
    Each holds still — as a whole, correct coin — under `prefers-reduced-motion`
    (iOS) and a zero animator scale (Android), falls back to the flat glyph if
    the renderer cannot start, and appears only in Settings, never beside the
    editor (M5). There is no celebrate spin on mobile: activation there does not
    pass through a moment the card is already on screen for. Filament costs
    **18.0 MB of the 55.1 MB release APK** across the three shipped ABIs, of
    which `gltfio` is 8.4 MB; RealityKit is a system framework and costs the iOS
    app nothing. → `apps/ios/Sources/License/SupporterCoin.swift`,
    `apps/android/.../ui/SupporterCoin.kt`
- **Ambient label** (the thing a purchase removes): the text "Unlicensed" when
  Unlicensed or Expired; "Licensed since {date}" when Licensed with an
  `issued_at`; and **nothing at all** for a v1 license — the element is removed
  rather than blanked, because there is no dateless variant of that line and
  dropping the "Unlicensed" label is the whole visible reward there. It is
  informational, never interrupts, never appears inside the editor, never on
  exported or shared content, and never on user data (M2).
  - _(desktop)_ The bottom-left corner of the sidebar, and the only thing in
    it — the app version used to share that line and no longer appears there
    at all, because Settings → Updates already reads "Currently running
    v{version}". Clicking it opens Settings at the License card. **The License
    section is the first section of Settings**, above Storage — it used to sit
    near the bottom, after Updates (@justin 2026-09-17), which now puts all
    three platforms in the same place. →
    `src/features/license/SidebarLicenseFooter.svelte`,
    `DrawerSidebar.svelte`, `SettingsScreen.svelte` (`initialSection`),
    `licenseCopy.ts` (`licenseAmbientLabel`) + `licenseCopy.test.ts`
  - _(native shells)_ Mobile has no ambient label outside Settings; the License
    card is the **first thing at the top of Settings**, and in the Licensed
    state nothing on screen names the state at all — the coin in the well says
    it, and the word is available only to assistive technology. → _(ios)_
    `LicenseSettingsSection` as the first `Section` of `SettingsView`,
    `LicenseCopyTests`; _(android)_ `LicenseSettingsSection` as the first group
    of `SettingsScreen`,
    `apps/android/app/src/main/java/com/futo/notes/ui/LicenseSettingsSection.kt`,
    `LicenseCopyTest`

## Store posture (deliberate, recorded 2026-09-09)

Research summary as of 2026-09-09; this area changes monthly and the decision,
not the rules, is what this section records.

- **Apple.** Guideline 3.1.1 names license keys as a forbidden unlock mechanism
  worldwide; 3.1.3(b) permits recognising a web-bought license only if the same
  thing is also sold as IAP. Linking out is legal in the US (no entitlement, 0%
  today, rate pending in court), in the EU and Japan at 15% with Apple's
  disclosure sheet and an IAP twin, in Brazil, and banned elsewhere. Immich
  ships a free iOS app with a key field and no IAP twin today.
- **Google.** A Play build that only accepts a pasted key with no clickable
  path to checkout is explicitly permitted (consumption-only, 0%, no
  enrollment). Any link requires the External Content Links / billing choice
  programs, which cover the US, EEA, UK and Japan today, with fees from October
  2026 and worldwide coverage not before September 2027. Google enforces after
  publication (removals, strikes) and has enforced against external payment
  links in 2026.
- **Decision.** All three platforms ship the full surface — key field, deep
  link, and the Buy link to the system browser — **worldwide**, with no region
  gating and no IAP or Play Billing twin. FUTO accepts the review risk and will
  respond if a store objects. If it does, the answer is a flag flip, not a
  redesign:
  - one build-time constant, `LICENSE_LINK_OUT`, exists on iOS and Android and
    is `true` at launch. `false` hides Buy, Renew and Lost-your-key and keeps
    the key field and deep link (the consumption-only shape). Which controls
    each value produces is decided once in Rust, so the two shells cannot drift
    on what the flag means. → `license_row_actions`,
    `crates/futo-notes-ffi/src/license/contract.rs` "link_out false hides every
    way out of the app and nothing else"; _(ios)_
    `apps/ios/Sources/License/LicenseLinkOut.swift`, flipped by the
    `LICENSE_LINK_OUT_DISABLED` compile condition (`apps/ios/project.yml` names
    it where the build is configured); _(android)_ a `buildConfigField` on each
    product flavor in `apps/android/app/build.gradle.kts`, read once as
    `BuildConfig.LICENSE_LINK_OUT` and passed to `licenseRowActions`, so `play`
    alone can be flipped. `LicenseLinkOutTest` runs under both flavors and
    fails the one whose constant is false — the lock that makes "true at
    launch" a fact rather than an intention. Building `play` with `false` was
    driven on the emulator: Buy, Renew and Lost-your-key disappeared while the
    key field and the deep link kept working. The iOS fallback
    beyond that is a non-renewing-subscription IAP twin at the same price to
    fit 3.1.3(b); a 3-year expiring license cannot be a non-consumable IAP.
  - _(Android)_ the app gains **`play` and `direct` product flavors now**, same
    `applicationId` (`com.futo.notes`, `.dev` suffix unchanged) and same signing,
    so a user can move between Play and a direct APK. At launch the flavors
    differ in nothing license-related — `LICENSE_LINK_OUT` is `true` on both —
    and it can be flipped for `play` alone. Other Play-only behavior (e.g. in-app review prompts) also
    belongs in the `play` flavor. F-Droid builds `direct`.
  - _(Android, F-Droid)_ offline verification adds no anti-feature; the single
    activation request to pay2 may earn a Tethered/NonFreeNet label. Accepted.
- **Never** frame the purchase as a donation in the app or the store listing
  (see Principles).

## Out of scope

- The **server product** is independent: its own Polar product, its own key
  semantics, no shared entitlement with this license. The same customer e-mail
  may exist in Polar for both; nothing in the client relies on that.
- Per-region pricing, currencies, and tax are the storefront's business.

> **Gap:** License sync — the license is entered per device. Carrying it in the
> E2EE sync payload so one entry licenses every synced device is intended but
> not designed; it touches the sync payload (AGENTS.md §11.6) and must be its own
> change.

> **Gap:** The `platform` attribution the Buy URL carries is not yet recorded by
> the server. The client sends it and FUTOpay's newer branch puts it on the
> checkout, but the deployed `staging-pay2.futo.org` predates that: its
> `checkout-ready` page renders no `platform` field for `?platform=desktop`
> (observed 2026-09-10). Nothing about the purchase depends on it, so this
> closes when lib-polar deploys, with no client change.

> **Gap:** No in-Play purchase path — Play users must reach FUTOpay checkout via
> the Buy link or on their own. A Play Billing SKU or companion app (the FUTO
> Keyboard pattern) is deliberately not built.

> **Gap:** No region gating — the Buy link shows worldwide on iOS and Android
> regardless of storefront country; StoreKit `Storefront`-based gating is the
> fallback if Apple objects, alongside the `LICENSE_LINK_OUT` flag. Confirmed at
> runtime on the simulator 2026-09-10 (#160): the installed iOS binary links no
> StoreKit framework at all, and Buy appears in the Unlicensed row with no App
> Store account signed in. The only input to the row's actions besides status is
> `link_out`, which is a **build-time** constant on both native shells
> (`LicenseLinkOut.swift`'s `#if LICENSE_LINK_OUT_DISABLED`, Android's
> `BuildConfig.LICENSE_LINK_OUT` per flavor) — so a single worldwide binary
> cannot show Buy in the US and hide it elsewhere; the flag is all-or-nothing.
> ADR-0003 listed storefront gating as a shipped consequence until 2026-09-10;
> it was never implemented, and the ADR now points here instead. →
> `crates/futo-notes-ffi/src/license/contract.rs` `license_row_actions`

> **Gap:** No in-app restore by e-mail — lost keys go to support@futo.tech; the
> newer futopay Android library's restore page is not adopted.

A **real purchase delivers a license key end to end**, verified 2026-09-15 on
the native Android app against `staging-pay2.futo.org`: system-browser checkout
with a real email domain, Stripe test card `4242 4242 4242 4242`, payment
succeeded, key delivered (`7QTY-X1FG-2CQ5-1KW1-5GWR-DVA7-976D-6UJV`), the
`futonotes://license/{key}/{activation}` link activated the app, and
`android-drive state` plus the Settings UI confirmed `LICENSED`. → screenshot
ledger in `test-screenshots/`

The same real-purchase path was independently re-verified on the native iOS
app 2026-09-15 against `staging-pay2.futo.org`, on commit `0e986457` (the
`success=redirect-to-organization-page` fix): Buy opened
`.../checkout-ready?platform=ios&success=redirect-to-organization-page`
(confirmed from the Safari address bar) and a real Stripe test-card purchase
(`justin+e2e-ios-<id>@futo.tech`) landed on
`https://staging-pay2.futo.org/checkout-success?license_key=...&state=granted`
— the HTML key page with an Activate button — not the raw
`/api/checkout-status/...` JSON a pre-fix build on this same worktree had
shown for the identical flow one run earlier. Tapping Activate fired the
`futonotes://license/{key}/{activation}` deep link, Safari's "Open in FUTO
Notes Dev?" prompt handed off to the app, and Settings showed a "License
activated" toast with the row reading `Licensed`; force-quitting and
relaunching confirmed the state persisted. → 49-shot ledger in
`test-screenshots/ios-retest-*.png`

> This closes a Gap open since 2026-09-10/11, when two server-side faults —
> neither a client bug — blocked every purchase: the Polar product initially
> carried no benefit (`_confirm_polar_checkout` requires exactly one benefit
> grant before `create_key_func` runs; a custom benefit was attached 2026-09-10),
> and Polar's sandbox then stopped creating benefit grants at all for **any**
> product (a control purchase on futo-music, previously reliable, also produced
> none). Polar webhooks to staging FUTOpay were also rejected 403 `Invalid
webhook signature` the whole time (`polar_sdk._webhooks.validate_event`
> base64-encodes the secret before HMAC; a Standard-Webhooks signature decodes it
> first), so the webhook fulfilment path was dead too. None of that reproduced on
> 2026-09-15's purchase — this is one verified success, not proof either fault is
> permanently fixed on Polar's side; re-verify if purchases start failing again.
>
> _A separate, resolved trap for anyone testing this by hand or by agent:_ Polar
> validates `customer_email` for deliverability before it will create a checkout
> at all, and rejects any `@example.com`/`@example.org`/`@test`/`@localhost`
> address (null-MX by design) or a domain with no DNS record, with a 422 that
> `create-checkout` flattens into the same 200-wrapped
> `{"status_code":502,"detail":"Polar rejected the checkout request"}` above —
> indistinguishable from the real server-side faults without checking the email.
> Confirmed 2026-09-15: 22/22 `@example.com` attempts failed, 15/15 real-domain
> attempts (`@gmail.com`, `@futo.org`, `@mailinator.com`) succeeded, interleaved
> from one IP within seconds — ruling out headers, cookies, and rate limiting.
> **Use `justin+<unique-id>@futo.tech` for test purchases**, never an
> `@example.*` address.

The **release gate for the License card** was re-run 2026-09-16 on one commit
across all three clients, each story observed on screen _and_ against storage
(the desktop app data dir, UserDefaults, `futo_prefs`). All three verdicts were
SHIP.

- _(desktop)_ Unlicensed card, the checkout URL, all four input shapes, a v1
  license, mask/reveal/copy, Remove, Full reset, and dark/light plus a narrow
  pane. The bare-key-offline case was driven by relaunching the dev process
  under a scoped `HTTPS_PROXY=http://127.0.0.1:1` — the offline toast appeared
  and no `license.json` was written. Copy was read back with `pbpaste` from
  outside the app, which is the only way: the app deliberately holds no
  clipboard-read permission.
- _(ios)_ A **fresh real staging purchase on this commit** — Stripe test card,
  `justin+…@futo.tech`, key `D58B-…-3684` minted, the HTML key page, Activate
  firing the deep link, and the pair landing in UserDefaults. The Buy URL was
  read verbatim from Safari's address bar. The simulator happened to still hold
  a **v1** license at launch, giving a live D2 reading: "Licensed since" present
  and blank, Term "Perpetual".
- _(android)_ A second independent real staging purchase (key `2FFB-…-89J5`),
  plus the one thing no other platform can do — **Expired rendered from a real
  stored license**, by moving the emulator clock past the fixture's 2029 expiry
  (`auto_time 0`, `adb root`, relaunch). The card showed the EXPIRED badge, an
  empty well, the masked key, "Licensed since Jan 15, 2026", "Term: Expired
  Jan 15, 2029" and **Renew** as the filled button. Restoring the clock
  re-evaluated the same stored pair back to Licensed, proving the clock move
  corrupted nothing. The `play` flavor's consumption-only shape was proven by
  flipping `LICENSE_LINK_OUT` locally and reverting it — both flavors still ship
  it `true` (D9).

> Three results were **not** obtained, and are recorded here rather than left to
> be rediscovered as failures. _(ios)_ the bare-key-**offline** case: a simulator
> proxies the host's network and has no Wi-Fi toggle, and host-level networking
> was deliberately left alone because two sibling legs were mid-purchase against
> the same host. _(desktop)_ the OS browser actually painting the Buy URL: the
> URL and the `openExternalUrl` code path were both proven, but confirming the
> browser tab would have needed UI scripting, which is forbidden (M24).
> _(desktop)_ Full reset's native confirm sheet is not reachable from the webview
> bridge, so the identical code path (`resetAllNotes()` → `deleteAllNotes()` →
> `clearLicense()`) was invoked instead.

> _Two false failures that were caught and refuted during that pass, recorded so
> the next one does not re-report them:_ _(ios)_ after Remove, `futo.license.
activation` lingers in UserDefaults for a few seconds after `futo.license.key`
> has gone — that is `NSUserDefaults` write coalescing, not a storage bug; both
> are clear on a re-read. _(android)_ `adb shell input text` silently truncates
> at roughly 250 characters, so entering the 584-character v2 fixture by hand
> needs chunking — an untruncated single call produces an activation failure
> that looks exactly like a rejected key.

> **Gap:** No revocation check — refunded or revoked keys stay valid on
> activated devices because the license module makes no background requests.
> An opportunistic re-check on explicit user action only would be the
> compatible way to add one.

> **Gap:** The **production** org public key is a placeholder. There is no
> production FUTOpay org for this product yet (product decision 2026-09-10:
> staging first), so `PRODUCTION_PUBLIC_KEY_BASE64` is a throwaway key whose
> private half was discarded — a release build therefore reports every user
> Unlicensed, which is fail-closed, and no license can be minted for it by
> anyone. Dropping the real key in is a one-line change to that constant.
> `STAGING_PUBLIC_KEY_BASE64` is **no longer** a placeholder: since 2026-09-11 it
> is the key the staging deployment actually signs with (DER SPKI SHA-256
> `fca4b6a4…29a23`, pinned by `the_staging_key_is_the_real_staging_org_key`), and
> the fixture license every dev build is driven with is signed by it rather than
> by the conformance pair. → `crates/futo-notes-license/src/config.rs`
>
> From 2026-09-10 to 2026-09-11 it was a _different_ real key (`ca4a8698…31514`,
> the 1Password `staging-polar-orgs-futo-notes-privk` pair), which **no
> deployment has ever held** — so every license staging minted verified as
> Invalid. FUTOpay generates an org's pair itself in `initialize_organizations`
> when the org row is first inserted and never replaces it
> (`auto_upsert_organization` omits both key columns from its `ON CONFLICT`), and
> although `manifest-inventory` injects
> `POLAR__ORGS__FUTO_NOTES__PRIVATE_KEY` from 1Password, no branch of lib-polar
> reads that variable outside its test suite (lib-polar issue #1). **The
> authority for either environment's key is therefore the live endpoint**, `GET
{pay2}/checkout/polar/futo-notes/activation/public-key` — which is what FUTO
> Music bakes for both of its environments too. Re-mint the staging-signed
> fixtures whenever it moves.
>
> **The production Buy destination does not exist either, and that is the wider
> half of the same gap.** Verified 2026-09-10 (#160):
> `GET pay2.futo.org/checkout/polar/futo-notes/futo-notes-license/info` answers
> 404 `{"detail":"Organization not found"}` and `/price` answers
> `Organization not found: futo-notes` — there is no `futo-notes` org in
> production, so no product and no price. The URL a release build would open,
> `.../futo-notes-license/checkout-ready?platform=…`, nonetheless returns
> **HTTP 200** and renders a checkout shell with no product in it — the same
> silent, un-buyable page that #157b fixed for staging by correcting the product
> slug. A 200 on that URL therefore proves nothing, and no later check of it
> should be read as the product existing; ask `/info` or `/price`. So a
> production release today would report every user Unlicensed **and** point Buy
> at a checkout that cannot take money. Both halves — the org/product and the
> key — must land before any production release carries this surface.

> **Gap:** _(ios, android)_ The card has a fourth, unspecified state: _not yet
> known_. The spec gives it three, while desktop initializes to Unlicensed before
> its asynchronous read lands. On both native shells a preference read and an RSA
> verify are work M1 keeps off the thread that paints the shell, so the card
> renders its frame with no status until the answer lands — _(android)_ the well
> carries no accessibility label at all in that window, because neither "No
> license" nor the coin's label would yet be true. The window is one
> background hop during startup and closes long before Settings can normally be
> opened; it is recorded rather than blessed, and the line to reconcile is
> whether the spec should name a loading state for all three clients. → iOS and
> Android `LicenseModel.view` (nullable until `load()`),
> `LicenseSettingsSection.swift`, `LicenseSettingsSection.kt`

> **Gap:** _(desktop, ios, android)_ The spec names the key field but none of the
> controls around it, so each shell supplies them: an **Activate** button (the
> keyboard's Done/Return also submits), a **Cancel** that closes the field, and a
> placeholder naming the three accepted shapes. A text field with no submit is
> not operable, so these are additions rather than choices — but they are
> unspecified copy, and this is the line to reconcile if the spec later names
> them. All three shells use the same four catalog entries
> (`license.keyLabel`, `keyPlaceholder`, `activate`, `cancelEntry`), so the
> addition is at least identical on all of them.

> **Gap:** _(desktop, macOS)_ The `futonotes` scheme is declared once in
> `tauri.conf.json`, but only Linux and Windows re-register it at runtime
> (`register_all`). macOS learns the scheme from the bundle's generated
> `CFBundleURLTypes`, which an unbundled `cargo tauri dev` binary never gets, so
> the OS → app hop is unverified there: QA drove the plugin's own
> `deep-link://new-url` event, which exercises everything from `on_open_url`
> inward but not LaunchServices. The #160 gate added the second half of the
> reason, read from the dependency rather than inferred: the single-instance
> argv route cannot cover macOS either, because
> `tauri-plugin-deep-link`'s `handle_cli_arguments` wraps its whole body in
> `if cfg!(windows) || cfg!(target_os = "linux")` — it is a **no-op** on macOS,
> so `license::handle_single_instance_arguments` can never fire there. Two
> second-launch attempts with the link as argv exited 0 through the
> single-instance socket and changed nothing, which is the specified outcome of
> a no-op and not a bug in this repo's code. Proving it needs a signed bundle from
> `just tauri-build`, and a production bundle verifies against the production
> key — so a staging license cannot demo it end to end until the **production**
> key lands (see the production-key gap above).
